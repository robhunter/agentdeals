import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const { judgePreviousValue, pairedReaderFor, previousValuePrompt, previousValueReaderFor, settleAgainstCaptures, statedBeforeReaderFor } = await import("../scripts/archive-captures.js");
const { settleFirstReadings } = await import("../scripts/settle-discovered-records.js");

const FILLER = "Pricing and plan comparison. ".repeat(30);
const RECORDS = JSON.parse(readFileSync(new URL("./fixtures/archive-first-readings.json", import.meta.url), "utf-8"));
const ONE_SIGNAL = RECORDS.find((record: { vendor: string }) => record.vendor === "OneSignal");
const OLD_MOBILE = "Unlimited Mobile Push Sends";
const NEW_MOBILE = "Mobile Push Notifications for organizations with up to 1,000 monthly active users";
const EARLIER_VALUE = { previous: OLD_MOBILE, current: NEW_MOBILE, old_page: OLD_MOBILE };
const oldMobilePage = `${OLD_MOBILE} Free Email Sends 10,000/mo. ${FILLER}`;

type Page = { page: string; day: string; text: string };
type Capture = { timestamp: string; original: string; statuscode: string; mimetype: string };

function archiveOf(pages: Record<string, string | null>, url = ONE_SIGNAL.source_url) {
  const fetched: string[] = [];
  return {
    fetched,
    captures: async () => ({ captures: Object.keys(pages).sort().map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })) }),
    captureHtml: async ({ timestamp }: Capture) => {
      fetched.push(timestamp);
      const text = pages[timestamp];
      return text === null ? { unavailable: "HTTP 403" } : { html: `<html><body><p>${text} ${FILLER}</p></body></html>` };
    },
  };
}

function oneSignalOptions(pages: Record<string, string | null>, answer: (page: Page) => unknown = (page) => ({ previous_values: page.text.includes(OLD_MOBILE) ? [EARLIER_VALUE] : [] })) {
  const client = { complete: async (prompt: string) => JSON.stringify(answer({ page: "", day: "", text: prompt.split(/ARCHIVED PAGE \(saved [^)]*\):\n/)[1] ?? "" })) };
  const readings: unknown[] = [];
  return {
    url: ONE_SIGNAL.source_url, textDay: "2026-09-20", recordDay: ONE_SIGNAL.date,
    today: "2026-11-08", todayText: `${NEW_MOBILE} ${FILLER}`, archive: archiveOf(pages),
    readPair: async () => ({ status: "same", old_terms: [NEW_MOBILE], new_terms: [NEW_MOBILE] }),
    readStatedBefore: async () => ({ status: "stated", stated_then: [{ record: ONE_SIGNAL.summary, old: NEW_MOBILE }] }),
    readPreviousValue: previousValueReaderFor(client, ONE_SIGNAL),
    onRead: (read: unknown) => readings.push(read), readings,
  };
}

describe("an earlier capture of the value a record says changed", () => {
  it("keeps OneSignal unsettled when its September agreement hides January's unlimited mobile push", async () => {
    const options = oneSignalOptions({ "20260101120000": oldMobilePage, "20260301120000": `Application shell. ${FILLER}`, "20260917120000": NEW_MOBILE });
    const result = await settleAgainstCaptures(options);
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.prior_capture.day, "2026-01-01");
    assert.deepStrictEqual(result.previous_values, [{ previous: OLD_MOBILE, current: NEW_MOBILE, old: OLD_MOBILE }]);
    assert.match(result.why, /earlier capture states the record's previous value/);
    assert.ok(options.archive.fetched.includes("20260101120000"));
    assert.strictEqual(options.readings.length, 3);
  });

  it("checks every earlier capture, including one between agreeing endpoints and one outside the text-day window", async () => {
    const options = oneSignalOptions({ "20240101120000": NEW_MOBILE, "20260101120000": oldMobilePage, "20260917120000": NEW_MOBILE });
    const result = await settleAgainstCaptures(options);
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.prior_capture.day, "2026-01-01");
    assert.deepStrictEqual(options.archive.fetched, ["20260917120000", "20240101120000", "20260101120000"]);
    const restored = oneSignalOptions({ "20240101120000": oldMobilePage, "20260101120000": NEW_MOBILE, "20260917120000": NEW_MOBILE });
    assert.strictEqual((await settleAgainstCaptures(restored)).prior_capture.day, "2024-01-01");
  });

  it("retains ours when none of the earlier captures states a replaced value", async () => {
    const options = oneSignalOptions({ "20240101120000": NEW_MOBILE, "20260101120000": NEW_MOBILE, "20260917120000": NEW_MOBILE });
    const result = await settleAgainstCaptures(options);
    assert.strictEqual(result.outcome, "ours");
    assert.deepStrictEqual(result.stated_then, [{ record: ONE_SIGNAL.summary, old: NEW_MOBILE }]);
    assert.strictEqual(options.readings.length, 4);
  });

  it("also checks captures after our text day but before the agreeing record-day capture", async () => {
    const options = oneSignalOptions({ "20260101120000": NEW_MOBILE, "20260601120000": oldMobilePage, "20260925120000": NEW_MOBILE });
    const result = await settleAgainstCaptures({ ...options, textDay: "2026-02-01" });
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.prior_capture.day, "2026-06-01");
  });

  it("keeps an unreadable earlier capture unsettled and never asks a model about an empty page", async () => {
    const options = oneSignalOptions({ "20260101120000": null, "20260917120000": NEW_MOBILE }, () => assert.fail("unreadable page reached reader"));
    const result = await settleAgainstCaptures(options);
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.match(result.why, /could not be read/);
  });

  it("keeps absent, malformed and ungrounded earlier-value readings unsettled", async () => {
    for (const answer of [null, {}, { previous_values: [{ ...EARLIER_VALUE, old_page: "Unlimited push forever" }] }]) {
      const options = oneSignalOptions({ "20260101120000": oldMobilePage, "20260917120000": NEW_MOBILE }, () => answer);
      assert.strictEqual((await settleAgainstCaptures(options)).outcome, "no_usable_capture");
    }
    const options = oneSignalOptions({ "20260101120000": oldMobilePage, "20260917120000": NEW_MOBILE });
    assert.strictEqual((await settleAgainstCaptures({ ...options, readPreviousValue: undefined })).outcome, "no_usable_capture");
  });

  it("does not use a later capture as evidence of a change before our text", async () => {
    const result = await settleAgainstCaptures(oneSignalOptions({ "20260917120000": NEW_MOBILE, "20261001120000": oldMobilePage }));
    assert.strictEqual(result.outcome, "ours");
  });

  it("carries the record-specific reader through first-pass settlement and saves its evidence", async () => {
    const options = oneSignalOptions({ "20260101120000": oldMobilePage, "20260917120000": NEW_MOBILE });
    const report = await settleFirstReadings({
      changes: [ONE_SIGNAL], offers: [], today: options.today, archive: options.archive,
      fetchToday: async () => ({ ok: true, text: options.todayText }), textDayOf: () => options.textDay,
      pairReaderForListing: () => options.readPair, statedReaderForRecord: () => options.readStatedBefore,
      previousReaderForRecord: (record: typeof ONE_SIGNAL) => { assert.strictEqual(record, ONE_SIGNAL); return options.readPreviousValue; },
      logReads: true,
    });
    assert.strictEqual(report.results[0].outcome, "no_usable_capture");
    assert.ok(report.results[0].readings.some((read: { newer: string; verdict: { status: string } }) => read.newer === "the previous value" && read.verdict.status === "stated"));
  });
});

describe("grounding an earlier-value answer", () => {
  it("shows the record, both descriptions and the dated page to the reader", () => {
    const prompt = previousValuePrompt(ONE_SIGNAL, { day: "2026-01-01", text: oldMobilePage });
    for (const text of [ONE_SIGNAL.summary, ONE_SIGNAL.previous_state, ONE_SIGNAL.current_state, "saved 2026-01-01", OLD_MOBILE, '"previous_values"']) assert.ok(prompt.includes(text));
  });

  it("accepts quoted old and new values, and rejects invented, empty, unchanged or missing figures", () => {
    const judge = (value: unknown) => judgePreviousValue({ previous_values: [value] }, ONE_SIGNAL, oldMobilePage);
    assert.strictEqual(judge(EARLIER_VALUE).status, "stated");
    for (const value of [
      { ...EARLIER_VALUE, previous: "Unlimited everything" },
      { ...EARLIER_VALUE, current: "Only 500 users" },
      { ...EARLIER_VALUE, old_page: "Unlimited push forever" },
      { ...EARLIER_VALUE, old_page: "Free Email Sends 10,000/mo" },
      { ...EARLIER_VALUE, previous: "" },
      { ...EARLIER_VALUE, old_page: "" },
    ]) assert.strictEqual(judge(value).status, "unknown", JSON.stringify(value));
    const record = { ...ONE_SIGNAL, previous_state: "1 GB storage", current_state: "1GB of storage" };
    assert.strictEqual(judgePreviousValue({ previous_values: [{ previous: "1 GB storage", current: "1GB of storage", old_page: "1 GB storage" }] }, record, "1 GB storage").status, "unknown");
  });

  it("cannot exclude an earlier value outside the prompt window, but keeps positive evidence inside it", () => {
    const text = `${oldMobilePage} ${"x".repeat(100000)}`;
    assert.strictEqual(judgePreviousValue({ previous_values: [] }, ONE_SIGNAL, text).status, "unknown");
    assert.strictEqual(judgePreviousValue({ previous_values: [EARLIER_VALUE] }, ONE_SIGNAL, text).status, "stated");
    assert.strictEqual(judgePreviousValue({ previous_values: [] }, ONE_SIGNAL, "x".repeat(100000)).status, "not_stated");
  });

  it("sends the complete page at its boundary and rejects a quote beyond the actual prompt window", async () => {
    const prompts: string[] = [];
    const client = { complete: async (prompt: string) => { prompts.push(prompt); return JSON.stringify({ previous_values: [EARLIER_VALUE] }); } };
    const read = previousValueReaderFor(client, ONE_SIGNAL);
    const boundary = "x".repeat(100000 - OLD_MOBILE.length) + OLD_MOBILE;
    assert.strictEqual((await read({ day: "2026-01-01", text: boundary })).status, "stated");
    assert.ok(prompts[0].includes(boundary));
    const beyond = "x".repeat(100000) + OLD_MOBILE;
    assert.strictEqual((await read({ day: "2026-01-01", text: beyond })).status, "unknown");
    const shown = prompts[1].split(/ARCHIVED PAGE \(saved [^)]*\):\n/)[1].split("\n\nFind only")[0];
    assert.strictEqual(shown, "x".repeat(100000));
    assert.ok(!shown.includes(OLD_MOBILE));
  });
});

type Fixture = { vendor: string; date: string; textDay: string; summary: string; previous_state: string; current_state: string; pages: Record<string, string>; terms: (text: string) => string[]; review?: string; expected: string };
const FIXTURES: Fixture[] = [
  { vendor: "Pinata IPFS", date: "2026-08-28", textDay: "2026-03-02", summary: "The free tier now offers 500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, and 10k requests per month.", previous_state: "1 GB storage free, along with access to API.", current_state: "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month", pages: { "20250116120000": "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month", "20260306210048": "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month", "20260803120000": "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month" }, terms: (text) => [text.split(" Pricing")[0]], expected: "ours" },
  { vendor: "GrowthBook", date: "2026-09-09", textDay: "2026-06-16", summary: "The free plans now have a limit of 1 project.", previous_state: "Unlimited projects", current_state: "1 project", pages: { "20260616120000": "Unlimited projects", "20260824143854": "1 project" }, terms: (text) => [text.includes("Unlimited projects") ? "Unlimited projects" : "1 project"], expected: "vendor_changed" },
  { vendor: "Stream", date: "2026-09-12", textDay: "2026-02-26", summary: "The Chat component now has a limit of 2,000 monthly active users and 100 concurrent connections.", previous_state: "Maker Account free: 2,000 monthly active users", current_state: "2,000 monthly active users and 100 concurrent connections", pages: { "20251208195711": "2,000 monthly active users and 100 concurrent connections Low-priority Support", "20260911120000": "2,000 monthly active users and 100 concurrent connections" }, terms: () => ["2,000 monthly active users", "100 concurrent connections"], review: "Low-priority Support", expected: "no_usable_capture" },
  { vendor: "Codecov", date: "2026-09-02", textDay: "2026-03-02", summary: "The Team plan is now $5 per user/month, down from the stored $12 per user/month.", previous_state: "Developer plan free", current_state: "Team $5 per user/month for up to 10 users", pages: { "20260302120000": "Team $5 per user/month for up to 10 users Sentry integration", "20260829152010": "Team $5 per user/month for up to 10 users" }, terms: () => ["Team $5 per user/month for up to 10 users"], review: "Sentry integration", expected: "no_usable_capture" },
];

describe("first-pass records with archive excerpt fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.vendor} settles as ${fixture.expected}`, async () => {
      const record = RECORDS.find((record: { vendor: string }) => record.vendor === fixture.vendor);
      const latest = Object.keys(fixture.pages).sort().at(-1)!;
      const text = `${fixture.pages[latest]} ${FILLER}`;
      const client = {
        complete: async (prompt: string) => {
          if (prompt.includes('"previous_values"')) return JSON.stringify({ previous_values: [] });
          if (prompt.includes('"changes"')) return JSON.stringify({ changes: [{ record: record.summary, old_page: fixture.pages[latest] }] });
          const [, older, newer] = prompt.split(/(?:OLD|NEW) PAGE \(saved [^)]*\):\n/);
          const oldTerms = fixture.terms(older);
          const newTerms = fixture.terms(newer);
          const review = fixture.review && older.includes(fixture.review) ? fixture.review : null;
          const same = !review && JSON.stringify(oldTerms) === JSON.stringify(newTerms);
          return JSON.stringify({ old_terms: oldTerms, new_terms: newTerms, same, differences: review ? [{ old: review, new: "" }] : same ? [] : [{ old: oldTerms[0], new: newTerms[0] }] });
        },
      };
      const result = await settleAgainstCaptures({
        url: "https://archive-fixture.example/pricing", textDay: fixture.textDay, recordDay: fixture.date,
        today: "2026-11-08", todayText: text, archive: archiveOf(fixture.pages, "https://archive-fixture.example/pricing"),
        readPair: pairedReaderFor(client, { vendor: fixture.vendor, category: "Developer tools", tier: "Free" }),
        readStatedBefore: statedBeforeReaderFor(client, record), readPreviousValue: previousValueReaderFor(client, record),
      });
      assert.strictEqual(result.outcome, fixture.expected);
      if (fixture.vendor === "GrowthBook") {
        assert.ok(result.brackets.every((bracket: { last_old: string; first_new: string }) => bracket.last_old >= "2026-06-16" && bracket.first_new <= "2026-08-24"));
      }
    });
  }
});
