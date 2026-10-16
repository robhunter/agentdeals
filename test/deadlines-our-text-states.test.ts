import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { changesTheVendorMade } = await import("../dist/data.js");
const { recordsStillInForce } = await import("../dist/change-resolution.js");
const { openapiSpec } = await import("../dist/openapi.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const A_DAY_IN_MS = 86400000;

type Condition = { text: string; quote: string; url: string; read_on: string };
type Listing = { vendor: string; category: string; description?: string; conditions?: Condition[] } & Record<string, unknown>;
type ChangeRecord = { vendor: string; date: string; summary: string } & Record<string, unknown>;
type Deadline = {
  vendor: string;
  date: string;
  summary: string;
  source_url?: string | null;
  stated_in?: string;
  change_type?: string;
  record_date?: string;
};

const DEADLINE_WORD = /\bshut(?:s|ting)?\s?down\b|\bretir(?:e|es|ed|ing|ement)\b|\bdiscontinu|\bend[\s-]of[\s-]life\b|\buntil\b|\bprice\s+changes?\b/i;

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const MONTH_INDEX = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(year: string, month: number, day: string): string {
  return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function monthOf(name: string): number {
  return MONTH_INDEX.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function datesWritten(text: string): string[] {
  const found = new Set<string>();
  for (const [, year, month, day] of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.add(iso(year, Number(month), day));
  for (const [, month, day, year] of text.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) found.add(iso(year, monthOf(month), day));
  for (const [, day, month, year] of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})\\b`, "gi"))) found.add(iso(year, monthOf(month), day));
  for (const [, month, day, year] of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) found.add(iso(year, Number(month), day));
  return [...found];
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / A_DAY_IN_MS;
}

function dayFromToday(days: number): string {
  return new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + days * A_DAY_IN_MS).toISOString().slice(0, 10);
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function cardsOf(html: string): { badge: string | null; date: string; summary: string }[] {
  return [...html.matchAll(/<div class="dl-card [^"]*">([\s\S]*?)<div class="dl-date">([^<]*)<\/div>\s*<div class="dl-summary">([\s\S]*?)<\/div>/g)]
    .map(([, head, date, summary]) => ({
      badge: head.match(/<span class="badge"[^>]*>([^<]*)<\/span>/)?.[1] ?? null,
      date: decode(date),
      summary: decode(summary.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    }));
}

function startServer(env: Record<string, string>): Promise<{ server: ChildProcess; base: string }> {
  const server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
    server.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ server, base: `http://localhost:${match[1]}` });
      }
    });
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function deadlinesFrom(base: string): Promise<{ api: Deadline[]; html: string }> {
  const api = await fetch(`${base}/api/deadlines`);
  assert.strictEqual(api.status, 200, "/api/deadlines");
  const page = await fetch(`${base}/deadlines`);
  assert.strictEqual(page.status, 200, "/deadlines");
  return { api: ((await api.json()) as { deadlines: Deadline[] }).deadlines, html: await page.text() };
}

describe("the deadline tracker lists every later date our listings and records state beside a deadline word", () => {
  let server: ChildProcess;
  let deadlines: Deadline[] = [];
  let html = "";

  before(async () => {
    const started = await startServer({});
    server = started.server;
    ({ api: deadlines, html } = await deadlinesFrom(started.base));
  });

  after(() => {
    server?.kill();
  });

  it("has an entry within a day of every such date, for the vendor whose listing or record states it", () => {
    const today = new Date().toISOString().slice(0, 10);
    const listings: Listing[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers;
    const records: ChangeRecord[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;
    const texts = [
      ...listings.flatMap((listing) => [
        { vendor: listing.vendor, where: `${listing.vendor}'s listing`, text: listing.description ?? "" },
        ...(listing.conditions ?? []).map((condition) => ({ vendor: listing.vendor, where: `a condition on ${listing.vendor}'s listing`, text: condition.text })),
      ]),
      ...changesTheVendorMade(recordsStillInForce(records))
        .filter((record: ChangeRecord) => record.date <= today)
        .map((record: ChangeRecord) => ({ vendor: record.vendor, where: `${record.vendor}'s ${record.date} record`, text: record.summary })),
    ];
    const unlisted = texts
      .filter(({ text }) => DEADLINE_WORD.test(text))
      .flatMap(({ vendor, where, text }) => datesWritten(text)
        .filter((date) => date > today)
        .filter((date) => !deadlines.some((entry) => entry.vendor === vendor && daysApart(entry.date, date) <= 1))
        .map((date) => `${date} in ${where}`));
    assert.deepStrictEqual(unlisted, []);
  });

  it("prints each stated deadline's sentence on /deadlines as /api/deadlines gives it", () => {
    const printed = cardsOf(html).map(({ summary }) => summary);
    const missing = deadlines
      .filter((entry) => entry.stated_in !== undefined)
      .filter((entry) => !printed.some((summary) => summary.startsWith(entry.summary)))
      .map((entry) => `${entry.date} ${entry.vendor}: ${entry.summary}`);
    assert.deepStrictEqual(missing, []);
  });

  it("counts every entry it lists in the page's total", () => {
    const total = Number(html.match(/<p class="page-intro">(\d+) upcoming deadlines/)?.[1]);
    assert.strictEqual(total, deadlines.length);
    assert.strictEqual(cardsOf(html).length, deadlines.length);
  });

  it("says above the list when a change record leaves and when a quoted date leaves", () => {
    const today = dayFromToday(0);
    const notice = decode((html.match(/<p class="page-intro dated-rule">([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/<[^>]+>/g, ""));
    assert.strictEqual(
      notice,
      "What this section prints is decided by the calendar, not by anything the vendor did. " +
      `A change record is named here only while the date we hold for it is later than ${today}. ` +
      "That date is the effective date where the vendor states one, and the day we discovered the change where the vendor does not. " +
      "It is not removed because the shutdown was cancelled or because we stopped holding the record. " +
      "On the day its date arrives it leaves this page for the full change log. " +
      "Other entries quote a date stated by a listing or an earlier change record. " +
      `We show them while that text states the date and the date is later than ${today}. ` +
      "They leave when the date arrives, or when we rewrite or retract the text.",
    );
  });
});

describe("a deadline stated in a listing or an earlier record joins the deadline tracker and nothing else", () => {
  const VENDOR = "Deadline Fixture Cloud";
  const LISTING_URL = "https://deadline-fixture.example/pricing";
  const CONDITION_URL = "https://deadline-fixture.example/changelog";
  const RECORD_URL = "https://deadline-fixture.example/retirement";
  const IN_20 = dayFromToday(20);
  const IN_30 = dayFromToday(30);
  const IN_31 = dayFromToday(31);
  const IN_40 = dayFromToday(40);
  const IN_60 = dayFromToday(60);
  const IN_90 = dayFromToday(90);
  const IN_91 = dayFromToday(91);
  const IN_70 = dayFromToday(70);
  const IN_50 = dayFromToday(50);
  const TODAY = dayFromToday(0);
  const CONDITION_SENTENCE = `Scheduled jobs on the free plan run until ${IN_20}.`;
  const DESCRIPTION_SENTENCE = `The hosted dashboard shuts down on ${IN_40}.`;
  const PRICE_SENTENCE = `The starter plan costs $5 through ${IN_30}, then $8 from ${IN_31}.`;
  const NEXT_DAY_SENTENCE = `The legacy runtime can be called until ${IN_90}; the vendor says it is no longer supported after ${IN_91}.`;
  const RECORD_SENTENCE = `The v1 API is retired on ${IN_60}.`;
  const PAST_SENTENCE = "The beta console shut down on 2026-01-20.";
  const TODAY_SENTENCE = `The old importer works until ${TODAY}.`;
  const WHOLE_VENDOR = "Deadline Fixture Queue";
  const WHOLE_LISTING_URL = "https://deadline-fixture-queue.example/pricing";
  const WHOLE_DESCRIPTION = `The free queue plan is discontinued on ${dayFromToday(2)}.`;
  const WHOLE_CONDITION = "Free queues hold at most 1,000 messages at a time.";

  let server: ChildProcess;
  let base = "";
  let dir = "";
  let deadlines: Deadline[] = [];
  let html = "";

  before(async () => {
    const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
    const changeLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
    catalogue.offers.push({
      vendor: VENDOR,
      category: "Cloud Hosting",
      tier: "Free",
      url: LISTING_URL,
      description: `Container hosting for small apps. ${DESCRIPTION_SENTENCE} ${PRICE_SENTENCE} ${NEXT_DAY_SENTENCE} ${PAST_SENTENCE} ${TODAY_SENTENCE}`,
      verifiedDate: "2026-01-10",
      conditions: [{
        text: `${CONDITION_SENTENCE} After that they need a paid plan.`,
        quote: "Scheduled jobs need a paid plan.",
        url: CONDITION_URL,
        read_on: "2026-01-10",
      }, {
        text: `The next intake for the startup programme opens on ${IN_50}.`,
        quote: "The next intake opens soon.",
        url: CONDITION_URL,
        read_on: "2026-01-10",
      }],
    });
    catalogue.offers.push({
      vendor: WHOLE_VENDOR,
      category: "Cloud Hosting",
      tier: "Free",
      url: WHOLE_LISTING_URL,
      description: WHOLE_DESCRIPTION,
      verifiedDate: "2026-01-10",
      conditions: [{ text: WHOLE_CONDITION, quote: "Free queues hold 1,000 messages.", url: CONDITION_URL, read_on: "2026-01-10" }],
    });
    changeLog.changes.push(
      {
        vendor: VENDOR,
        change_type: "product_deprecated",
        date: "2026-01-15",
        summary: `Deadline Fixture Cloud deprecated its v1 API on 2026-01-15. ${RECORD_SENTENCE} Scheduled jobs keep running until ${IN_20}.`,
        previous_state: "The v1 API is available.",
        current_state: "The v1 API is deprecated.",
        impact: "medium",
        source_url: RECORD_URL,
        category: "Cloud Hosting",
        alternatives: [],
        recorded_date: "2026-01-16",
        date_source: "hand_written",
        listing_effect: "none",
      },
      {
        vendor: VENDOR,
        change_type: "limits_reduced",
        date: "2026-01-18",
        summary: `Deadline Fixture Cloud said its free tier is retired on ${IN_70}.`,
        previous_state: "The free tier is available.",
        current_state: "The free tier is scheduled to end.",
        impact: "high",
        source_url: RECORD_URL,
        category: "Cloud Hosting",
        alternatives: [],
        recorded_date: "2026-01-19",
        date_source: "hand_written",
        resolution: { state: "reversed", date: "2026-02-01", detail: "Reversed 2026-02-01: the free tier stays." },
      },
      {
        vendor: VENDOR,
        change_type: "product_deprecated",
        date: IN_90,
        summary: `Deadline Fixture Cloud's legacy runtime stops on ${IN_90}.`,
        previous_state: "The legacy runtime is available.",
        current_state: "The legacy runtime is scheduled to stop.",
        impact: "low",
        source_url: RECORD_URL,
        category: "Cloud Hosting",
        alternatives: [],
        recorded_date: "2026-01-16",
        date_source: "hand_written",
        listing_effect: "none",
      },
    );
    dir = mkdtempSync(path.join(tmpdir(), "stated-deadlines-"));
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(catalogue));
    writeFileSync(path.join(dir, "deal_changes.json"), JSON.stringify(changeLog));
    const started = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(dir, "deal_changes.json"),
    });
    server = started.server;
    base = started.base;
    ({ api: deadlines, html } = await deadlinesFrom(base));
  });

  after(() => {
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fixtureEntries = () => deadlines.filter((entry) => entry.vendor === VENDOR);

  it("lists a listing condition's date with the condition's sentence and link, ahead of a record naming the same date", () => {
    const entry = fixtureEntries().find((candidate) => candidate.date === IN_20);
    assert.deepStrictEqual(
      entry && { summary: entry.summary, source_url: entry.source_url, stated_in: entry.stated_in, change_type: entry.change_type },
      { summary: CONDITION_SENTENCE, source_url: CONDITION_URL, stated_in: "listing", change_type: undefined },
    );
  });

  it("lists a date in the listing's description with that sentence and the listing's pricing page", () => {
    const entry = fixtureEntries().find((candidate) => candidate.date === IN_40);
    assert.deepStrictEqual(entry && { summary: entry.summary, source_url: entry.source_url }, { summary: DESCRIPTION_SENTENCE, source_url: LISTING_URL });
  });

  it("lists a later date an earlier record states, with the record's change type and source", () => {
    const entry = fixtureEntries().find((candidate) => candidate.date === IN_60);
    assert.deepStrictEqual(
      entry && { summary: entry.summary, source_url: entry.source_url, stated_in: entry.stated_in, change_type: entry.change_type, record_date: entry.record_date },
      { summary: RECORD_SENTENCE, source_url: RECORD_URL, stated_in: "record", change_type: "product_deprecated", record_date: "2026-01-15" },
    );
  });

  it("gives a price that runs through one day and changes the next one entry, on the day it changes", () => {
    const dates = fixtureEntries().map((entry) => entry.date);
    assert.ok(dates.includes(IN_31), `no entry on ${IN_31}`);
    assert.ok(!dates.includes(IN_30), `an entry on ${IN_30} as well`);
  });

  it("adds nothing beside a record of the vendor dated within a day, for a record no longer in force, for a date not later than today, or for a text with no deadline word", () => {
    assert.deepStrictEqual(fixtureEntries().map((entry) => entry.date).sort(), [IN_20, IN_31, IN_40, IN_60, IN_90].sort());
  });

  it("prints the record's badge on the record's stated deadline and none on the listing's", () => {
    const cards = cardsOf(html);
    assert.strictEqual(cards.find((card) => card.summary.startsWith(RECORD_SENTENCE))?.badge, "deprecated");
    assert.strictEqual(cards.find((card) => card.summary.startsWith(CONDITION_SENTENCE))?.badge, null);
  });

  it("orders its cards by date, with the stated deadlines among the records", () => {
    const cards = cardsOf(html);
    const order = [CONDITION_SENTENCE, PRICE_SENTENCE, DESCRIPTION_SENTENCE, RECORD_SENTENCE, `Deadline Fixture Cloud's legacy runtime stops on ${IN_90}.`]
      .map((sentence) => cards.findIndex((card) => card.summary.startsWith(sentence)));
    assert.ok(order.every((at) => at >= 0), `a card is missing: ${order.join(", ")}`);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
  });

  it("links a listing's sentence to its page as the listing's source and a record's to the record's source", () => {
    const cardHolding = (sentence: string) => html.split('<div class="dl-card').slice(1).find((chunk) => chunk.includes(sentence)) ?? "";
    const classOfLinkTo = (chunk: string, url: string) => chunk.match(new RegExp(`<a href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*class="([^"]+)"`))?.[1];
    assert.strictEqual(classOfLinkTo(cardHolding(CONDITION_SENTENCE), CONDITION_URL), "record-source");
    assert.strictEqual(classOfLinkTo(cardHolding(RECORD_SENTENCE), RECORD_URL), "change-source");
  });

  it("keeps a listing's stated deadlines out of a change-type filter and a record's in its own type", async () => {
    const response = await fetch(`${base}/api/deadlines?type=product_deprecated`);
    assert.strictEqual(response.status, 200);
    const filtered = ((await response.json()) as { deadlines: Deadline[] }).deadlines.filter((entry) => entry.vendor === VENDOR);
    assert.deepStrictEqual(filtered.map((entry) => entry.date).sort(), [IN_60, IN_90].sort());
  });

  it("does not turn a stated deadline into a change record", async () => {
    const response = await fetch(`${base}/api/changes?vendor=${encodeURIComponent(VENDOR)}`);
    assert.strictEqual(response.status, 200);
    const changes = ((await response.json()) as { changes: { date: string }[] }).changes;
    assert.ok(changes.some((change) => change.date === "2026-01-15"), "the fixture's own record is not in /api/changes");
    assert.deepStrictEqual(changes.filter((change) => [IN_20, IN_31, IN_40, IN_60].includes(change.date)), []);
  });

  it("follows a quote of a listing's whole description with the listing's conditions, on the card and in the structured data, and a quote of one of its sentences with none", () => {
    const cardHolding = (sentence: string) => html.split('<div class="dl-card').slice(1).find((chunk) => chunk.includes(sentence)) ?? "";
    const whole = cardHolding(WHOLE_DESCRIPTION);
    assert.ok(whole.includes('<ul class="listing-conditions"'), "the card quoting a whole description prints no list of conditions");
    assert.ok(whole.indexOf(WHOLE_CONDITION) > whole.indexOf(WHOLE_DESCRIPTION), "the conditions do not follow the description");
    assert.ok(!cardHolding(DESCRIPTION_SENTENCE).includes('class="listing-conditions"'), "a card quoting one sentence of a longer description prints conditions");
    const items = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .flatMap(([, json]) => {
        const node = JSON.parse(json!);
        return node["@type"] === "ItemList" ? node.itemListElement : [];
      })
      .map((element: { item: { headline: string; description: string } }) => element.item);
    const described = items.find((item: { headline: string }) => item.headline === WHOLE_VENDOR)?.description ?? "";
    assert.ok(described.startsWith(WHOLE_DESCRIPTION) && described.includes(WHOLE_CONDITION), described);
    assert.strictEqual(items.find((item: { description: string }) => item.description.startsWith(DESCRIPTION_SENTENCE))?.description, DESCRIPTION_SENTENCE);
  });

  it("gives the sentence alone as the API's summary, whether or not it is the whole description", () => {
    assert.strictEqual(deadlines.find((entry) => entry.vendor === WHOLE_VENDOR)?.summary, WHOLE_DESCRIPTION);
  });

  it("documents every field a stated deadline carries in the OpenAPI spec, and requires only fields every one carries", () => {
    const items = (openapiSpec as any).paths["/api/deadlines"].get.responses["200"].content["application/json"].schema.properties.deadlines.items;
    const stated = items.oneOf.find((branch: any) => branch.properties?.stated_in);
    const entries = deadlines.filter((entry) => entry.stated_in !== undefined);
    assert.ok(entries.some((entry) => entry.stated_in === "listing") && entries.some((entry) => entry.stated_in === "record"), "the fixture no longer serves both kinds of stated deadline");
    const undocumented = [...new Set(entries.flatMap((entry) => Object.keys(entry)))].filter((key) => !(key in stated.properties));
    assert.deepStrictEqual(undocumented, []);
    const missing = entries.flatMap((entry) => stated.required.filter((key: string) => !(key in entry)).map((key: string) => `${entry.vendor} ${entry.date}: ${key}`));
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual([...new Set(entries.map((entry) => entry.stated_in))].sort(), [...stated.properties.stated_in.enum].sort());
  });
});
