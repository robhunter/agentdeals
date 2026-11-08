import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

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

describe("captures of a source URL and its destination", () => {
  const source = "https://archive-alias.example/pricing";
  const destination = "https://archive-alias.example/plans";
  const january = "20260101120000";
  const september = "20260917120000";
  const oldTerms = "Free plan: 3 projects";
  const newTerms = "Free plan: 1 project";
  const record = { date: "2026-09-25", summary: "The free plan now allows 1 project.", previous_state: oldTerms, current_state: newTerms };
  const identity = (url: string, timestamp: string) => `${url} ${timestamp}`;
  const savedUrl = (url: string, timestamp: string) => `https://web.archive.org/web/${timestamp}/${url}`;

  async function settle(pages: Record<string, string>) {
    const fetched: string[] = [];
    const listed: string[] = [];
    const client = { complete: async (prompt: string) => JSON.stringify({ previous_values: prompt.split(/ARCHIVED PAGE \(saved [^)]*\):\n/)[1].includes(oldTerms) ? [{ previous: oldTerms, current: newTerms, old_page: oldTerms }] : [] }) };
    const result = await settleAgainstCaptures({
      url: source, finalUrl: destination, textDay: "2026-09-20", recordDay: record.date,
      today: "2026-11-08", todayText: `${newTerms} ${FILLER}`,
      archive: {
        captures: async (url: string) => {
          listed.push(url);
          return { captures: [january, september].filter((timestamp) => Object.hasOwn(pages, identity(url, timestamp))).map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })) };
        },
        captureHtml: async (capture: Capture) => {
          const key = identity(capture.original, capture.timestamp);
          fetched.push(key);
          return { html: `<p>${pages[key]} ${FILLER}</p>` };
        },
      },
      readPair: async () => ({ status: "same", old_terms: [newTerms], new_terms: [newTerms] }),
      readStatedBefore: async () => ({ status: "stated", stated_then: [{ record: record.summary, old: newTerms }] }),
      readPreviousValue: previousValueReaderFor(client, record),
    });
    assert.deepStrictEqual(listed, [source, destination]);
    return { result, fetched };
  }

  it("preserves an earlier source copy when the destination has a different page at the same instant", async () => {
    const { result, fetched } = await settle({
      [identity(source, january)]: oldTerms, [identity(destination, january)]: newTerms,
      [identity(source, september)]: newTerms, [identity(destination, september)]: newTerms,
    });
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.prior_capture.url, savedUrl(source, january));
    assert.ok(fetched.includes(identity(source, january)));
  });

  it("reads each distinct copy instead of reusing another URL's cached text", async () => {
    const { result, fetched } = await settle({
      [identity(source, january)]: newTerms, [identity(destination, january)]: oldTerms,
      [identity(source, september)]: newTerms,
    });
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.prior_capture.url, savedUrl(destination, january));
    assert.deepStrictEqual(fetched, [identity(source, september), identity(source, january), identity(destination, january)]);
  });

  it("excludes only the chosen copy when checking other captures at that instant", async () => {
    const { result, fetched } = await settle({
      [identity(source, september)]: newTerms, [identity(destination, september)]: oldTerms,
    });
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.prior_capture.url, savedUrl(destination, september));
    assert.deepStrictEqual(fetched, [identity(source, september), identity(destination, september)]);
  });

  it("retains both URL copies through actual HTTP collection, model reading and the serial settlement report", async () => {
    const { createArchiveClient } = await import("../scripts/archive-captures.js");
    const { createVerifierClient, fetchPageText } = await import("../scripts/verify-freshness.js");
    const { runArchiveSettlement } = await import("../scripts/run-archive-settlement.js");
    let base = "";
    let pages: Record<string, string> = {};
    const archived: string[] = [];
    const modelPrompts: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, base);
      if (url.pathname === "/pricing") {
        response.writeHead(302, { Location: `${base}/plans` });
        response.end();
      } else if (url.pathname === "/cdx/search/cdx") {
        const original = url.searchParams.get("url")!;
        response.end(JSON.stringify([["timestamp", "original", "statuscode", "mimetype"],
          ...[january, september].filter((timestamp) => Object.hasOwn(pages, identity(original, timestamp))).map((timestamp) => [timestamp, original, "200", "text/html"])]));
      } else if (url.pathname.startsWith("/web/")) {
        const match = /^\/web\/(\d{14})id_\/(.+)$/.exec(url.pathname)!;
        const key = identity(match[2], match[1]);
        archived.push(key);
        assert.ok(Object.hasOwn(pages, key));
        response.end(`<p>${pages[key]} ${FILLER}</p>`);
      } else if (url.pathname === "/chat/completions") {
        let body = "";
        for await (const part of request) body += part;
        const prompt = JSON.parse(body).messages[0].content;
        modelPrompts.push(prompt);
        const answer = prompt.includes('"previous_values"')
          ? { previous_values: prompt.split(/ARCHIVED PAGE \(saved [^)]*\):\n/)[1].includes(oldTerms) ? [{ previous: oldTerms, current: newTerms, old_page: oldTerms }] : [] }
          : prompt.includes('"changes"')
            ? { changes: [{ record: "now allows 1 project", old_page: newTerms }] }
            : { old_terms: [newTerms], new_terms: [newTerms], same: true, differences: [] };
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
      } else {
        assert.strictEqual(url.pathname, "/plans");
        response.end(`<p>${newTerms} ${FILLER}</p>`);
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const source = `${base}/pricing`;
      const destination = `${base}/plans`;
      const client = createVerifierClient({ apiKey: "local-fixture", baseUrl: base });
      const scenarios = [
        { pages: { [identity(source, january)]: oldTerms, [identity(destination, january)]: newTerms, [identity(source, september)]: newTerms }, expected: savedUrl(source, january) },
        { pages: { [identity(source, january)]: newTerms, [identity(destination, january)]: oldTerms, [identity(source, september)]: newTerms }, expected: savedUrl(destination, january) },
        { pages: { [identity(source, september)]: newTerms, [identity(destination, september)]: oldTerms }, expected: savedUrl(destination, september) },
      ];
      for (const scenario of scenarios) {
        pages = scenario.pages;
        archived.length = 0;
        modelPrompts.length = 0;
        const progress: unknown[] = [];
        const change = { ...record, vendor: "Example", date_source: "discovered", source_url: source, category: "Databases" };
        const report = await runArchiveSettlement({
          changes: [change], offers: [], today: "2026-11-08",
          archive: createArchiveClient({ minIntervalMs: 0, fetchImpl: async (input: string, options: RequestInit) => {
            const url = new URL(input);
            assert.strictEqual(url.origin, "https://web.archive.org");
            return fetch(`${base}${url.pathname}${url.search}`, options);
          } }),
          fetchToday: fetchPageText, textDayOf: () => "2026-09-20",
          pairReaderForListing: (listing: unknown) => pairedReaderFor(client, listing),
          statedReaderForRecord: (record: unknown) => statedBeforeReaderFor(client, record),
          previousReaderForRecord: (record: unknown) => previousValueReaderFor(client, record),
          onSettled: (row: unknown) => progress.push(row),
        });
        assert.strictEqual(report.results[0].outcome, "no_usable_capture");
        assert.strictEqual(report.results[0].prior_capture.url, scenario.expected);
        assert.strictEqual(report.results[0].previous_values[0].previous, oldTerms);
        assert.strictEqual(progress.length, 1);
        assert.strictEqual(new Set(archived).size, archived.length);
        assert.ok(modelPrompts.some((prompt) => prompt.includes('"previous_values"') && prompt.includes(oldTerms)));
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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

describe("settling a review against the record's claim", () => {
  const line = { old: "Total: $ 0", new: "", why: "only the old page states it" };
  const review = { status: "review", old_terms: [NEW_MOBILE], new_terms: [NEW_MOBILE], review: [line], why: "a calculator line differs" };

  it("settles a review as ours only after the old capture states the claim, retaining both sets of lines", async () => {
    const options = oneSignalOptions({ "20260917120000": NEW_MOBILE });
    const result = await settleAgainstCaptures({ ...options, readPair: async () => review });
    assert.strictEqual(result.outcome, "ours");
    assert.strictEqual(result.settled_from_review, true);
    assert.deepStrictEqual(result.review, [line]);
    assert.deepStrictEqual(result.stated_then, [{ record: ONE_SIGNAL.summary, old: NEW_MOBILE }]);
  });

  it("also settles today's review after an agreeing capture from before the record day", async () => {
    const options = oneSignalOptions({ "20260917120000": NEW_MOBILE, "20260924120000": NEW_MOBILE });
    const result = await settleAgainstCaptures({ ...options, readPair: async (_older: Page, newer: Page) => newer.page === "today" ? review : { status: "same", old_terms: [NEW_MOBILE], new_terms: [NEW_MOBILE] } });
    assert.strictEqual(result.outcome, "ours");
    assert.strictEqual(result.compared_with.page, "today");
    assert.deepStrictEqual(result.review, [line]);
  });

  it("preserves review lines when the claim is missing or the capture is after our text day", async () => {
    for (const day of ["20260917120000", "20260921120000"]) {
      const options = oneSignalOptions({ [day]: NEW_MOBILE });
      let asks = 0;
      const result = await settleAgainstCaptures({ ...options, readPair: async () => review, readStatedBefore: async () => { asks++; return day === "20260917" + "120000" ? { status: "unstated", why: "claim absent", review: [] } : { status: "stated", stated_then: [{ old: NEW_MOBILE }] }; } });
      assert.strictEqual(result.outcome, "no_usable_capture");
      assert.deepStrictEqual(result.review, [line]);
      assert.strictEqual(result.why, review.why);
      assert.strictEqual(asks, 1);
    }
  });

  it("runs the historical-value safeguard after a review and never turns the review into vendor_changed", async () => {
    const options = oneSignalOptions({ "20260101120000": oldMobilePage, "20260917120000": NEW_MOBILE });
    const result = await settleAgainstCaptures({ ...options, readPair: async () => review });
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.strictEqual(result.settled_from_review, false);
    assert.strictEqual(result.prior_capture.day, "2026-01-01");
    assert.deepStrictEqual(result.review, [line]);
  });

  it("keeps an already stated removal as a removal, retaining the review evidence", async () => {
    const options = oneSignalOptions({ "20260917120000": NEW_MOBILE });
    const result = await settleAgainstCaptures({ ...options, readPair: async () => review, readStatedBefore: async () => ({ status: "removal_stated", stated_then: [{ record: "removed", old: "No free tier" }] }) });
    assert.strictEqual(result.outcome, "removal_stated_before");
    assert.strictEqual(result.settled_from_review, true);
    assert.deepStrictEqual(result.review, [line]);
  });

  it("retains review evidence when either subsequent reader fails", async () => {
    for (const failing of ["stated", "previous"]) {
      const options = oneSignalOptions({ "20260101120000": NEW_MOBILE, "20260917120000": NEW_MOBILE });
      const fail = async () => { throw new Error("reader unavailable"); };
      const result = await settleAgainstCaptures({ ...options, readPair: async () => review, ...(failing === "stated" ? { readStatedBefore: fail } : { readPreviousValue: fail }) });
      assert.strictEqual(result.outcome, "reader_failed");
      assert.deepStrictEqual(result.review, [line]);
      assert.strictEqual(result.review_reason, review.why);
      assert.match(result.why, /reader unavailable/);
    }
  });
});

type Fixture = { vendor: string; date: string; textDay: string; summary: string; previous_state: string; current_state: string; pages: Record<string, string>; terms: (text: string) => string[]; review?: string; addedReview?: string; expected: string };
const FIXTURES: Fixture[] = [
  { vendor: "Pinata IPFS", date: "2026-08-28", textDay: "2026-03-02", summary: "The free tier now offers 500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, and 10k requests per month.", previous_state: "1 GB storage free, along with access to API.", current_state: "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month", pages: { "20250116120000": "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month", "20260306210048": "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month", "20260803120000": "500 pinned files, 1GB storage, 1 gateway, 10GB bandwidth per month, 10k requests per month" }, terms: (text) => [text.split(" Pricing")[0]], expected: "ours" },
  { vendor: "GrowthBook", date: "2026-09-09", textDay: "2026-06-16", summary: "The free plans now have a limit of 1 project.", previous_state: "Unlimited projects", current_state: "1 project", pages: { "20260616120000": "Unlimited projects", "20260824143854": "1 project" }, terms: (text) => [text.includes("Unlimited projects") ? "Unlimited projects" : "1 project"], expected: "vendor_changed" },
  { vendor: "Stream", date: "2026-09-12", textDay: "2026-02-26", summary: "The Chat component now has a limit of 2,000 monthly active users and 100 concurrent connections.", previous_state: "Maker Account free: 2,000 monthly active users", current_state: "2,000 monthly active users and 100 concurrent connections", pages: { "20251208195711": "2,000 monthly active users and 100 concurrent connections Five or less team members Less than $100k in funding Less than $10k/mo revenue Low-priority Support", "20260911120000": "2,000 monthly active users and 100 concurrent connections Five or less team members Less than $100k in funding Less than $10k/mo revenue" }, terms: () => ["2,000 monthly active users", "100 concurrent connections"], review: "Low-priority Support", expected: "ours" },
  { vendor: "Codecov", date: "2026-09-02", textDay: "2026-03-02", summary: "The Team plan is now $5 per user/month, down from the stored $12 per user/month.", previous_state: "Developer plan free", current_state: "Team $5 per user/month for up to 10 users", pages: { "20260302120000": "Team $5 per user/month for up to 10 users Sentry integration", "20260829152010": "Team $5 per user/month for up to 10 users" }, terms: () => ["Team $5 per user/month for up to 10 users"], review: "Sentry integration", expected: "ours" },
];

describe("first-pass records with archive excerpt fixtures", () => {
  const mapbox = RECORDS.find((record: { vendor: string }) => record.vendor === "Mapbox");
  FIXTURES.push({ vendor: "Mapbox", date: mapbox.date, textDay: "2026-02-25", summary: mapbox.summary, previous_state: mapbox.previous_state, current_state: mapbox.current_state, pages: { "20260225071916": mapbox.current_state + " Total: $ 0", "20260827001036": mapbox.current_state }, terms: () => [mapbox.current_state], review: "Total: $ 0", expected: "ours" });
  const mux = RECORDS.find((record: { vendor: string }) => record.vendor === "Mux");
  FIXTURES.push({ vendor: "Mux", date: mux.date, textDay: "2026-02-13", summary: mux.summary, previous_state: mux.previous_state, current_state: mux.current_state, pages: { "20260213120000": "100K free monthly video delivery minutes", "20260909120000": "100K free monthly video delivery minutes 100K free monthly Mux Robots units" }, terms: () => ["100K free monthly video delivery minutes"], addedReview: "100K free monthly Mux Robots units", expected: "no_usable_capture" });
  for (const fixture of FIXTURES) {
    it(`${fixture.vendor} settles as ${fixture.expected}`, async () => {
      const record = RECORDS.find((record: { vendor: string }) => record.vendor === fixture.vendor);
      const latest = Object.keys(fixture.pages).sort().at(-1)!;
      const text = `${fixture.pages[latest]} ${FILLER}`;
      const client = {
        complete: async (prompt: string) => {
          if (prompt.includes('"previous_values"')) return JSON.stringify({ previous_values: [] });
          if (prompt.includes('"changes"')) return JSON.stringify({ changes: [{ record: record.summary, old_page: fixture.addedReview ? "" : fixture.pages[latest] }] });
          const [, older, newer] = prompt.split(/(?:OLD|NEW) PAGE \(saved [^)]*\):\n/);
          const oldTerms = fixture.terms(older);
          const newTerms = fixture.terms(newer);
          const review = fixture.review && older.includes(fixture.review) ? fixture.review : null;
          const addedReview = fixture.addedReview && newer.includes(fixture.addedReview) ? fixture.addedReview : null;
          const same = !review && !addedReview && JSON.stringify(oldTerms) === JSON.stringify(newTerms);
          return JSON.stringify({ old_terms: oldTerms, new_terms: newTerms, same, differences: review ? [{ old: review, new: "" }] : addedReview ? [{ old: "", new: addedReview }] : same ? [] : [{ old: oldTerms[0], new: newTerms[0] }] });
        },
      };
      const result = await settleAgainstCaptures({
        url: "https://archive-fixture.example/pricing", textDay: fixture.textDay, recordDay: fixture.date,
        today: "2026-11-08", todayText: text, archive: archiveOf(fixture.pages, "https://archive-fixture.example/pricing"),
        readPair: pairedReaderFor(client, { vendor: fixture.vendor, category: "Developer tools", tier: "Free" }),
        readStatedBefore: statedBeforeReaderFor(client, record), readPreviousValue: previousValueReaderFor(client, record),
      });
      assert.strictEqual(result.outcome, fixture.expected);
      if (fixture.review && fixture.expected === "ours") { assert.strictEqual(result.settled_from_review, true); assert.ok(result.review.some((line: { old: string }) => line.old === fixture.review)); assert.ok(result.stated_then.length > 0); }
      if (fixture.vendor === "GrowthBook") {
        assert.ok(result.brackets.every((bracket: { last_old: string; first_new: string }) => bracket.last_old >= "2026-06-16" && bracket.first_new <= "2026-08-24"));
      }
    });
  }
});
