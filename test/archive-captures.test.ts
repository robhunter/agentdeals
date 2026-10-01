import { describe, it } from "node:test";
import assert from "node:assert";

const {
  cdxUrl,
  parseCdxRows,
  nearestCapture,
  captureUrl,
  createArchiveClient,
  dayOurTextEntered,
  comparableText,
  pairedPrompt,
  parsePairedAnswer,
  judgePair,
  pairedReaderFor,
  oldCaptureCandidates,
  recordDayCapture,
  settleAgainstCaptures,
  CAPTURE_WINDOW_DAYS,
} = await import("../scripts/archive-captures.js");

const HEADER = ["timestamp", "original", "statuscode", "mimetype"];

function cdxBody(rows: string[][]): string {
  return JSON.stringify([HEADER, ...rows]);
}

function capture(timestamp: string) {
  return { timestamp, original: "https://example.com/pricing", statuscode: "200", mimetype: "text/html" };
}

function scriptedFetch(responses: Array<{ status: number; body?: string; retryAfter?: string } | Error>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? next.retryAfter ?? null : null) },
      text: async () => next.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

function fakeTime() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

describe("finding the Internet Archive capture of a page nearest a day", () => {
  it("asks the capture index for successful captures of the page between two days, one a day", () => {
    const url = new URL(cdxUrl("https://example.com/pricing", "2025-05-01", "2025-07-31"));
    assert.strictEqual(url.origin + url.pathname, "https://web.archive.org/cdx/search/cdx");
    assert.strictEqual(url.searchParams.get("url"), "https://example.com/pricing");
    assert.strictEqual(url.searchParams.get("from"), "20250501");
    assert.strictEqual(url.searchParams.get("to"), "20250731");
    assert.strictEqual(url.searchParams.get("filter"), "statuscode:200");
    assert.strictEqual(url.searchParams.get("collapse"), "timestamp:8");
    assert.strictEqual(url.searchParams.get("output"), "json");
  });

  it("reaches back to the page's first capture when given no first day", () => {
    const url = new URL(cdxUrl("https://example.com/pricing", null, "2026-09-27"));
    assert.strictEqual(url.searchParams.has("from"), false);
    assert.strictEqual(url.searchParams.get("to"), "20260927");
  });

  it("keeps only successful HTML captures, oldest first", () => {
    const rows = parseCdxRows(cdxBody([
      ["20250612080000", "https://example.com/pricing", "200", "text/html"],
      ["20250530101500", "https://example.com/pricing", "200", "text/html"],
      ["20250601000000", "https://example.com/pricing", "200", "application/pdf"],
      ["2025060", "https://example.com/pricing", "200", "text/html"],
    ]));
    assert.deepStrictEqual(rows.map((row: { timestamp: string }) => row.timestamp), ["20250530101500", "20250612080000"]);
  });

  it("reads an empty or unreadable index answer as no captures", () => {
    assert.deepStrictEqual(parseCdxRows("[]"), []);
    assert.deepStrictEqual(parseCdxRows(""), []);
    assert.deepStrictEqual(parseCdxRows("<html>rate limited</html>"), []);
  });

  it("picks the capture closest to the day, and the earlier one when two are as close", () => {
    const captures = [capture("20250520120000"), capture("20250603120000"), capture("20250710120000")];
    assert.strictEqual(nearestCapture(captures, "2025-06-01")!.timestamp, "20250603120000");
    assert.strictEqual(nearestCapture(captures, "2025-05-27")!.timestamp, "20250520120000");
    assert.strictEqual(nearestCapture([], "2025-06-01"), null);
  });

  it("reads a capture as the page the Archive stored, without its toolbar", () => {
    assert.strictEqual(captureUrl(capture("20250530101500")), "https://web.archive.org/web/20250530101500id_/https://example.com/pricing");
  });
});

describe("reading the Archive at a pace it accepts", () => {
  it("leaves the minimum interval between two requests", async () => {
    const time = fakeTime();
    const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: cdxBody([]) }, { status: 200, body: "<html></html>" }]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock, minIntervalMs: 2000 });
    await archive.captures("https://example.com/pricing", "2025-05-01", "2025-07-31");
    await archive.captureHtml(capture("20250530101500"));
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(time.waits, [2000]);
  });

  it("waits as long as a 429 asks before trying again", async () => {
    const time = fakeTime();
    const { fetchImpl, calls } = scriptedFetch([{ status: 429, retryAfter: "30" }, { status: 200, body: cdxBody([["20250530101500", "https://example.com/pricing", "200", "text/html"]]) }]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock, minIntervalMs: 0 });
    const found = await archive.captures("https://example.com/pricing", "2025-05-01", "2025-07-31");
    assert.strictEqual(calls.length, 2);
    assert.ok(time.waits.includes(30_000), `waited ${time.waits.join(", ")} ms`);
    assert.strictEqual(found.captures.length, 1);
  });

  it("doubles its wait after each refusal that names no wait, and gives up after its last attempt", async () => {
    const time = fakeTime();
    const { fetchImpl, calls } = scriptedFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock, minIntervalMs: 0, maxAttempts: 4, firstBackoffMs: 10_000 });
    const found = await archive.captures("https://example.com/pricing", "2025-05-01", "2025-07-31");
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(time.waits, [10_000, 20_000, 40_000]);
    assert.deepStrictEqual(found, { unavailable: "HTTP 503 after 4 attempts" });
  });

  it("tries again after a dropped connection", async () => {
    const time = fakeTime();
    const { fetchImpl, calls } = scriptedFetch([new Error("socket hang up"), { status: 200, body: "<html>then</html>" }]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock, minIntervalMs: 0 });
    assert.deepStrictEqual(await archive.captureHtml(capture("20250530101500")), { html: "<html>then</html>" });
    assert.strictEqual(calls.length, 2);
  });

  it("leaves five seconds between requests unless told otherwise", async () => {
    const time = fakeTime();
    const { fetchImpl } = scriptedFetch([{ status: 200, body: cdxBody([]) }, { status: 200, body: "<html></html>" }]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock });
    await archive.captures("https://example.com/pricing", "2025-05-01", "2025-07-31");
    await archive.captureHtml(capture("20250530101500"));
    assert.deepStrictEqual(time.waits, [5000]);
  });

  it("waits minutes, not seconds, after the Archive refuses the connection, doubling each time", async () => {
    const time = fakeTime();
    const { fetchImpl, calls } = scriptedFetch([new Error("fetch failed"), new Error("fetch failed"), new Error("fetch failed"), new Error("fetch failed")]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock, minIntervalMs: 0 });
    assert.deepStrictEqual(await archive.captures("https://example.com/pricing", "2025-05-01", "2025-07-31"), { unavailable: "network error: fetch failed after 4 attempts" });
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(time.waits, [60_000, 120_000, 240_000]);
  });

  it("does not ask again for a page the Archive does not hold", async () => {
    const time = fakeTime();
    const { fetchImpl, calls } = scriptedFetch([{ status: 404 }]);
    const archive = createArchiveClient({ fetchImpl, sleep: time.sleep, clock: time.clock, minIntervalMs: 0 });
    assert.deepStrictEqual(await archive.captureHtml(capture("20250530101500")), { unavailable: "HTTP 404" });
    assert.strictEqual(calls.length, 1);
  });
});

describe("the day our text entered the catalogue", () => {
  it("is the first day a commit added or removed the text, from the history's first commit on", () => {
    assert.strictEqual(dayOurTextEntered("500 MB database", { commitDays: () => ["2025-04-02", "2025-11-20", "2026-09-27"] }), "2025-04-02");
  });

  it("looks for the text as the catalogue's JSON stores it, with quotes and backslashes escaped", () => {
    const searched: string[] = [];
    dayOurTextEntered('Individual: "Free forever" \\ 1 user', { commitDays: (text: string) => (searched.push(text), []) });
    assert.deepStrictEqual(searched, ['Individual: \\"Free forever\\" \\\\ 1 user']);
  });

  it("is unknown when no commit carries the text, or there is no text", () => {
    assert.strictEqual(dayOurTextEntered("never written", { commitDays: () => [] }), null);
    assert.strictEqual(dayOurTextEntered("  ", { commitDays: () => ["2025-04-02"] }), null);
  });
});

const OLD_PAGE = "Pricing. Free plan: $0 per month, 500 MB database, 50,000 monthly active users, community support. Pro plan: $25 per month, 8 GB database, 100,000 monthly active users.";
const NEW_PAGE = "Pricing. Free plan: $0 per month, 250 MB database, 50,000 monthly active users, community support. Pro plan: $25 per month, 8 GB database, 100,000 monthly active users.";

function answer(fields: Record<string, unknown>) {
  return { old_terms: ["Free plan: $0 per month, 500 MB database"], new_terms: ["Free plan: $0 per month, 250 MB database"], same: false, differences: [], direction: "narrowed", ...fields };
}

describe("judging a paired reading by the words it copied from each page", () => {
  it("finds the terms the same when the reader copied them from both pages and saw no difference", () => {
    const verdict = judgePair(answer({ old_terms: ["Free plan: $0 per month, 500 MB database"], new_terms: ["Free plan: $0 per month, 500 MB database"], same: true, direction: "unchanged" }), OLD_PAGE, OLD_PAGE);
    assert.strictEqual(verdict.status, "same");
    assert.deepStrictEqual(verdict.old_terms, ["Free plan: $0 per month, 500 MB database"]);
  });

  it("counts a difference when each side's words are on their own page and missing from the other page", () => {
    const verdict = judgePair(answer({ differences: [{ old: "500 MB database", new: "250 MB database" }] }), OLD_PAGE, NEW_PAGE);
    assert.strictEqual(verdict.status, "differ");
    assert.deepStrictEqual(verdict.differences, [{ old: "500 MB database", new: "250 MB database" }]);
    assert.strictEqual(verdict.direction, "narrowed");
  });

  it("cannot settle a page whose plan terms the reader did not copy from it, and says which page", () => {
    const invented = judgePair(answer({ old_terms: ["Free plan: 1 GB database"], differences: [{ old: "500 MB database", new: "250 MB database" }] }), OLD_PAGE, NEW_PAGE);
    assert.deepStrictEqual([invented.status, invented.side], ["unquotable", "old"]);
    assert.match(invented.why, /not on the old page: "Free plan: 1 GB database"/);
    const nothingNew = judgePair(answer({ new_terms: [] }), OLD_PAGE, NEW_PAGE);
    assert.deepStrictEqual([nothingNew.status, nothingNew.side], ["unquotable", "new"]);
    const neither = judgePair(answer({ old_terms: [], new_terms: [""] }), OLD_PAGE, NEW_PAGE);
    assert.deepStrictEqual([neither.status, neither.side], ["unquotable", "both"]);
  });

  it("does not trust the reader's word that the terms are the same when it did not copy them from both pages", () => {
    const verdict = judgePair(answer({ same: true, new_terms: ["Free plan: 250 MB storage"] }), OLD_PAGE, NEW_PAGE);
    assert.deepStrictEqual([verdict.status, verdict.side], ["unquotable", "new"]);
  });

  it("compares the copied words with each page after normalising whitespace, HTML entities and typographic marks", () => {
    const page = "Starter plan \u2014 it\u2019s free: 500\u00A0MB&nbsp;database &amp; 2 projects".padEnd(600, ".");
    assert.strictEqual(comparableText("500 MB"), comparableText("500MB"));
    const verdict = judgePair(answer({ old_terms: ["Starter plan - it's free: 500 MB database & 2 projects"], new_terms: ["Starter plan &mdash; it&#8217;s free: 500MB database &amp; 2 projects"], same: true }), page, page);
    assert.strictEqual(verdict.status, "same", verdict.why);
  });

  it("does not count an added term whose words were already on the old page, so a limit our text never stated is not a change", () => {
    const page = "Free hosting: 1000 MB disk space, 5 GB bandwidth, up to 5,000 visits a month, no ads.";
    const verdict = judgePair(answer({ old_terms: ["1000 MB disk space, 5 GB bandwidth"], new_terms: ["1000 MB disk space, 5 GB bandwidth"], differences: [{ old: "", new: "up to 5,000 visits a month" }] }), page, page);
    assert.strictEqual(verdict.status, "same");
    assert.deepStrictEqual(verdict.refuted, [{ old: "", new: "up to 5,000 visits a month", why: "the new words were already on the old page" }]);
  });

  it("counts an added term whose words are new to the page", () => {
    const before = "Free hosting: 1000 MB disk space, 5 GB bandwidth, no ads.";
    const after = "Free hosting: 1000 MB disk space, 5 GB bandwidth, up to 5,000 visits a month, no ads.";
    const verdict = judgePair(answer({ old_terms: ["1000 MB disk space, 5 GB bandwidth"], new_terms: ["1000 MB disk space, 5 GB bandwidth"], differences: [{ old: "", new: "up to 5,000 visits a month" }] }), before, after);
    assert.strictEqual(verdict.status, "differ");
  });

  it("does not count a removed term whose words are still on the new page", () => {
    const verdict = judgePair(answer({ differences: [{ old: "community support", new: "" }] }), OLD_PAGE, NEW_PAGE);
    assert.strictEqual(verdict.status, "same");
    assert.strictEqual(verdict.refuted[0].why, "the old words are still on the new page");
  });

  it("does not count a changed term when each page carries both the old and the new words", () => {
    const verdict = judgePair(answer({ differences: [{ old: "Free plan", new: "Pro plan" }] }), OLD_PAGE, NEW_PAGE);
    assert.strictEqual(verdict.status, "same");
    assert.strictEqual(verdict.refuted[0].why, "each page carries both the old and the new words");
  });

  it("cannot refute a difference with words that occur more than once on either page, so a figure the page repeats elsewhere cannot hide a cut", () => {
    const before = "Free plan: 10,000 calls a month. Launch offer: 10,000 calls a month for new sign-ups.";
    const after = "Free plan: 500 calls a month. Launch offer: 10,000 calls a month for new sign-ups.";
    const cut = judgePair(answer({ old_terms: ["Free plan: 10,000 calls a month"], new_terms: ["Free plan: 500 calls a month"], differences: [{ old: "10,000 calls a month", new: "" }] }), before, after);
    assert.deepStrictEqual([cut.status, cut.side, cut.refuted], ["unquotable", "old", []]);
    assert.strictEqual(cut.why, '"10,000 calls a month" occurs more than once on the old page, so it cannot refute the difference');

    const seats = { old: "Free plan: 3 seats, unlimited projects.", new: "Free plan: unlimited seats, unlimited projects." };
    const added = judgePair(answer({ old_terms: ["3 seats, unlimited projects"], new_terms: ["unlimited seats, unlimited projects"], differences: [{ old: "", new: "unlimited" }] }), seats.old, seats.new);
    assert.deepStrictEqual([added.status, added.side], ["unquotable", "new"]);
    const everywhere = "Free plan and Pro plan compared. Free plan: 1 project. Pro plan: 10 projects.";
    const both = judgePair(answer({ old_terms: ["Free plan: 1 project"], new_terms: ["Free plan: 1 project"], differences: [{ old: "Free plan", new: "Pro plan" }] }), everywhere, everywhere);
    assert.deepStrictEqual([both.status, both.side], ["unquotable", "both"]);
    assert.match(both.why, /"Free plan" and "Pro plan" occur more than once on the old and the new pages, so they cannot refute the difference/);
  });

  it("still refutes a difference with words that occur once on each page", () => {
    const verdict = judgePair(answer({ differences: [{ old: "community support", new: "" }, { old: "Free plan", new: "Pro plan" }] }), OLD_PAGE, NEW_PAGE);
    assert.strictEqual(verdict.status, "same");
    assert.deepStrictEqual(verdict.refuted.map((claim: { why: string }) => claim.why), ["the old words are still on the new page", "each page carries both the old and the new words"]);
  });

  it("does not count a claimed difference whose old and new words are the same, however often the pages repeat them", () => {
    const page = "Free: extra checkpoints $50 per million. Pro: extra checkpoints $50 per million.";
    const verdict = judgePair(answer({ old_terms: ["Free: extra checkpoints"], new_terms: ["Free: extra checkpoints"], differences: [{ old: "extra checkpoints $50 per million", new: "extra checkpoints $50 per million" }] }), page, page);
    assert.strictEqual(verdict.status, "same");
    assert.strictEqual(verdict.refuted[0].why, "the old and the new words are the same");
  });

  it("cannot settle a difference whose words are not on the page they were copied from, rather than calling the terms the same", () => {
    const verdict = judgePair(answer({ differences: [{ old: "500 MB database", new: "250 MB of database storage" }] }), OLD_PAGE, NEW_PAGE);
    assert.deepStrictEqual([verdict.status, verdict.side], ["unquotable", "new"]);
    assert.match(verdict.why, /the new words are not on the new page/);
  });

  it("cannot settle a reading that says the terms differ but copies no difference", () => {
    const verdict = judgePair(answer({ differences: [] }), OLD_PAGE, NEW_PAGE);
    assert.deepStrictEqual([verdict.status, verdict.side], ["unquotable", "both"]);
  });

  it("keeps a counted difference when the reader also claimed one the pages refute", () => {
    const verdict = judgePair(answer({ differences: [{ old: "Free plan", new: "Pro plan" }, { old: "500 MB database", new: "250 MB database" }] }), OLD_PAGE, NEW_PAGE);
    assert.strictEqual(verdict.status, "differ");
    assert.strictEqual(verdict.differences.length, 1);
    assert.strictEqual(verdict.refuted.length, 1);
  });

  it("cannot settle an answer it could not parse", () => {
    assert.deepStrictEqual(judgePair(null, OLD_PAGE, NEW_PAGE), { status: "unquotable", side: "both", why: "the reader's answer could not be parsed" });
  });
});

describe("parsing the paired reader's answer", () => {
  it("reads a JSON answer, fenced or not, with lists and objects inside it", () => {
    const body = '{"old_terms":["a"],"new_terms":["b"],"same":false,"differences":[{"old":"a","new":"b"}],"direction":"narrowed"}';
    assert.deepStrictEqual(parsePairedAnswer(body).differences, [{ old: "a", new: "b" }]);
    assert.deepStrictEqual(parsePairedAnswer("```json\n" + body + "\n```").old_terms, ["a"]);
    assert.strictEqual(parsePairedAnswer(`Here is the comparison:\n${body}\nDone.`).same, false);
  });

  it("gives nothing for an answer that is not the object asked for", () => {
    assert.strictEqual(parsePairedAnswer("The terms look the same."), null);
    assert.strictEqual(parsePairedAnswer('{"status":"confirmed"}'), null);
    assert.strictEqual(parsePairedAnswer('{"old_terms":["a"],"same":tru'), null);
    assert.strictEqual(parsePairedAnswer(undefined), null);
  });
});

describe("asking the paired reader", () => {
  const LISTING = { vendor: "Example", category: "Databases", tier: "Free", description: "our catalogue text: 500 MB database" };

  it("shows the reader both pages, dated, and the plan whose terms it is to copy, but not our catalogue text", () => {
    const prompt = pairedPrompt(LISTING, { day: "2026-02-15", text: OLD_PAGE }, { day: "2026-08-28", text: NEW_PAGE });
    assert.ok(prompt.includes("- Vendor: Example\n- Category: Databases\n- Plan: Free"), prompt);
    assert.ok(prompt.includes(`OLD PAGE (saved 2026-02-15, truncated):\n${OLD_PAGE}`));
    assert.ok(prompt.includes(`NEW PAGE (saved 2026-08-28, truncated):\n${NEW_PAGE}`));
    assert.ok(!prompt.includes("our catalogue text"));
  });

  it("shows each page up to the re-read's length", () => {
    const prompt = pairedPrompt(LISTING, { day: "2026-02-15", text: `${"a".repeat(12_000)}HIDDEN` }, { day: "2026-08-28", text: "b" }, 12_000);
    assert.ok(prompt.includes("a".repeat(12_000)));
    assert.ok(!prompt.includes("HIDDEN"));
  });

  it("judges the reader's answer against the two pages it was shown", async () => {
    const prompts: string[] = [];
    const client = {
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify(answer({ differences: [{ old: "500 MB database", new: "250 MB database" }] }));
      },
    };
    const read = pairedReaderFor(client, LISTING);
    const verdict = await read({ page: "capture 2026-02-15", day: "2026-02-15", text: OLD_PAGE }, { page: "today", day: "2026-09-27", text: NEW_PAGE });
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(verdict.status, "differ");
    const swapped = await read({ page: "capture 2026-02-15", day: "2026-02-15", text: NEW_PAGE }, { page: "today", day: "2026-09-27", text: OLD_PAGE });
    assert.strictEqual(swapped.status, "unquotable");
  });
});

function everyDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

const NO_TERMS = "-";
const FILLER = "Plan comparison, limits and prices. ".repeat(20);

function pageStating(terms: string | null): string {
  if (terms === null) return "<html><body>Loading…</body></html>";
  if (terms === NO_TERMS) return `<html><body><h2>Contact sales</h2><p>${FILLER}</p></body></html>`;
  return `<html><body><h2>Free plan</h2><p>TERMS=${terms}</p><p>${FILLER}</p></body></html>`;
}

function archiveOf(days: string[], termsOn: (day: string) => string | null) {
  const listed: Array<{ from: string | null; to: string }> = [];
  return {
    listed,
    captures: async (_url: string, from: string | null, to: string) => {
      listed.push({ from, to });
      return { captures: days.filter((day) => (!from || day >= from) && day <= to).map((day) => capture(`${day.replaceAll("-", "")}120000`)) };
    },
    captureHtml: async ({ timestamp }: { timestamp: string }) => ({
      html: pageStating(termsOn(`${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`)),
    }),
  };
}

type Page = { page: string; text: string };

function termsPairReader() {
  const calls: string[] = [];
  const readPair = async (older: Page, newer: Page) => {
    calls.push(`${older.page} | ${newer.page}`);
    const was = older.text.match(/TERMS=(\w+)/)?.[1];
    const now = newer.text.match(/TERMS=(\w+)/)?.[1];
    if (!was || !now) return { status: "unquotable", side: !was && !now ? "both" : !was ? "old" : "new", why: "no terms on the page" };
    const quoted = { old_terms: [`TERMS=${was}`], new_terms: [`TERMS=${now}`] };
    return was === now ? { status: "same", ...quoted } : { status: "differ", ...quoted, differences: [{ old: `TERMS=${was}`, new: `TERMS=${now}` }] };
  };
  return { readPair, calls };
}

const TODAY = "2026-09-27";
const RECORD_DAY = "2026-08-28";
const ALL_YEAR = everyDay("2025-10-01", TODAY);

function settle(options: { textDay?: string | null; recordDay?: string; todayTerms: string | null; days?: string[]; termsOn: (day: string) => string | null; archive?: unknown }) {
  const reader = termsPairReader();
  const archive = options.archive ?? archiveOf(options.days ?? ALL_YEAR, options.termsOn);
  return {
    reader,
    archive,
    result: settleAgainstCaptures({
      url: "https://example.com/pricing",
      textDay: options.textDay === undefined ? "2026-02-15" : options.textDay,
      recordDay: options.recordDay ?? RECORD_DAY,
      todayText: options.todayTerms === null ? "Contact sales" : `Free plan TERMS=${options.todayTerms}`,
      today: TODAY,
      archive,
      readPair: reader.readPair,
    }),
  };
}

type Bracket = { last_old: string; first_new: string | null; relative_to_record: string };
const spans = (brackets: Bracket[]) => brackets.map((b) => [b.last_old, b.first_new, b.relative_to_record]);

describe("the captures a record is judged on", () => {
  it("takes the latest capture on or before our text's day, however old, and else the first within the window after it", () => {
    const captures = ["20240301120000", "20260301120000", "20260501120000"].map(capture);
    assert.deepStrictEqual(oldCaptureCandidates(captures, "2026-02-15"), { before: captures[0], after: captures[1] });
    assert.deepStrictEqual(oldCaptureCandidates(captures.slice(2), "2026-02-15"), { before: null, after: null });
  });

  it("takes the capture nearest the record's day within the window, and never the old capture or one before it", () => {
    const captures = ["20260215120000", "20260820120000", "20260910120000", "20261201120000"].map(capture);
    assert.strictEqual(recordDayCapture(captures, "2026-08-28", captures[0]).timestamp, "20260820120000");
    assert.strictEqual(recordDayCapture(captures, "2026-08-28", captures[1]).timestamp, "20260910120000");
    assert.strictEqual(recordDayCapture(captures, "2026-08-28", captures[2]), null);
  });
});

describe("settling a first reading's difference against the page as the Archive stored it", () => {
  it("is unsettled when our text's day is unknown, and asks the Archive nothing", async () => {
    const { result, archive, reader } = settle({ textDay: null, todayTerms: "B", termsOn: () => "A" });
    assert.deepStrictEqual(await result, { outcome: "text_day_unknown", reads: 0 });
    assert.deepStrictEqual((archive as { listed: unknown[] }).listed, []);
    assert.deepStrictEqual(reader.calls, []);
  });

  it("calls the difference the vendor's when the page on the record's day states other terms than the capture from our text's day, and brackets the move", async () => {
    const { result } = settle({ todayTerms: "B", termsOn: (day) => (day <= "2026-04-10" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(settled.capture, { day: "2026-02-15", gap_days: 0, side: "before" });
    assert.deepStrictEqual(settled.compared_with, { page: "capture 2026-08-28", day: "2026-08-28", gap_days: 0, side: "on" });
    assert.strictEqual(settled.previous_state, "TERMS=A");
    assert.deepStrictEqual(settled.terms_on_record_day, ["TERMS=B"]);
    assert.deepStrictEqual(spans(settled.brackets), [["2026-04-10", "2026-04-11", "before"]]);
    assert.strictEqual(settled.brackets[0].narrowed_to_adjacent_captures, true);
    assert.deepStrictEqual(settled.later_moves, []);
    assert.strictEqual(settled.date, "2026-04-11");
    assert.ok(settled.reads <= 12, `${settled.reads} reads`);
  });

  it("calls the difference ours when the page on the record's day states the terms of the capture from our text's day", async () => {
    const { result, reader } = settle({ todayTerms: "B", termsOn: () => "B" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.deepStrictEqual(settled.terms_then, ["TERMS=B"]);
    assert.deepStrictEqual(reader.calls, ["capture 2026-02-15 | capture 2026-08-28"]);
  });

  it("reaches back past any window for the capture on or before our text's day", async () => {
    const { result, archive } = settle({ todayTerms: "B", days: ["2024-03-01", "2026-08-28"], termsOn: () => "B" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.deepStrictEqual(settled.capture, { day: "2024-03-01", gap_days: 716, side: "before" });
    assert.deepStrictEqual((archive as { listed: Array<{ from: string | null }> }).listed.map((ask) => ask.from), [null]);
  });

  it("judges the record on its own day, so a move after it does not make the record's difference the vendor's", async () => {
    const { result, reader } = settle({ todayTerms: "C", termsOn: (day) => (day <= "2026-09-05" ? "A" : "C") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.ok(!reader.calls.some((call) => call.includes("today")), reader.calls.join("\n"));
  });

  it("also reads today's page when the capture nearest the record's day is from before it, and calls the difference ours when today agrees", async () => {
    const { result, reader } = settle({ todayTerms: "A", days: everyDay("2026-01-01", "2026-08-20"), termsOn: () => "A" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.deepStrictEqual(settled.compared_with, { page: "capture 2026-08-20", day: "2026-08-20", gap_days: 8, side: "before" });
    assert.deepStrictEqual(reader.calls, ["capture 2026-02-15 | capture 2026-08-20", "capture 2026-02-15 | today"]);
  });

  it("keeps the record the vendor's when the capture before the record's day agrees but today's page does not, dated by that bracket", async () => {
    const { result } = settle({ todayTerms: "B", days: everyDay("2026-01-01", "2026-08-20"), termsOn: () => "A" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.strictEqual(settled.previous_state, "TERMS=A");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-08-20", null, "spans"]]);
    assert.strictEqual(settled.date, null);
  });

  it("reports a move a capture places after the record's day as a later move, and the record's difference as ours", async () => {
    const days = [...everyDay("2026-01-01", "2026-08-20"), "2026-09-20"];
    const { result } = settle({ todayTerms: "B", days, termsOn: () => "A" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.deepStrictEqual(spans(settled.later_moves), [["2026-09-20", null, "after"]]);
  });

  it("calls the difference the vendor's from a capture before the record's day that already shows new terms, without reading today's page", async () => {
    const days = [...everyDay("2026-01-01", "2026-02-15"), "2026-08-29", "2026-09-01"];
    const { result, reader } = settle({ todayTerms: "B", days, termsOn: (day) => (day <= "2026-08-29" ? "A" : "B"), recordDay: "2026-09-02" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-08-29", "2026-09-01", "before"]]);
    assert.strictEqual(settled.date, "2026-09-01");
    assert.ok(!reader.calls.some((call) => call.includes("today")), reader.calls.join("\n"));
  });

  it("reports a move that a capture beyond the window places after the record's day as a later move", async () => {
    const days = [...everyDay("2026-01-01", "2026-02-15"), "2026-08-15"];
    const { result } = settle({ todayTerms: "B", days, termsOn: (day) => (day <= "2026-08-15" ? "A" : "B"), recordDay: "2026-06-01" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.strictEqual(settled.compared_with.page, "today");
    assert.deepStrictEqual(spans(settled.later_moves), [["2026-08-15", null, "after"]]);
  });

  it("stands today's page in for the record's day when no capture is within the window of it", async () => {
    const days = everyDay("2026-01-01", "2026-06-01");
    const moved = await settle({ todayTerms: "B", days, termsOn: (day) => (day <= "2026-04-10" ? "A" : "B") }).result;
    assert.strictEqual(moved.outcome, "vendor_changed");
    assert.deepStrictEqual(moved.compared_with, { page: "today", day: TODAY, gap_days: 30, side: "after" });
    assert.deepStrictEqual(spans(moved.brackets), [["2026-04-10", "2026-04-11", "before"]]);
    const agreed = await settle({ todayTerms: "A", days, termsOn: () => "A" }).result;
    assert.strictEqual(agreed.outcome, "ours");
    assert.strictEqual(agreed.compared_with.page, "today");
  });

  it("dates the move after the last capture when only today's page shows the new terms", async () => {
    const { result } = settle({ todayTerms: "B", days: everyDay("2026-02-01", "2026-06-15"), termsOn: () => "A" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-06-15", null, "spans"]]);
    assert.strictEqual(settled.date, null);
  });

  it("judges a reading made today against today's page, whatever today's capture says", async () => {
    const { result } = settle({ todayTerms: "B", recordDay: TODAY, termsOn: () => "A" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.strictEqual(settled.compared_with.page, "today");
    assert.deepStrictEqual(spans(settled.brackets), [[TODAY, null, "spans"]]);
  });

  it("does not call the difference ours from a capture after our text's day, since the vendor could have changed its terms in between", async () => {
    const { result } = settle({ todayTerms: "B", days: ["2026-03-01"], termsOn: () => "B" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.tried.map((t: { day: string; side: string }) => [t.day, t.side]), [["2026-03-01", "after"]]);
    assert.match(settled.tried[0].why, /after our text's day/);
  });

  it("brackets a vendor change from a capture after our text's day that still states the old terms", async () => {
    const { result } = settle({ todayTerms: "B", days: everyDay("2026-03-01", TODAY), termsOn: (day) => (day <= "2026-05-20" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(settled.capture, { day: "2026-03-01", gap_days: 14, side: "after" });
    assert.strictEqual(settled.date, "2026-05-21");
  });

  it(`uses a capture after our text's day only within ${CAPTURE_WINDOW_DAYS} days of it`, async () => {
    const inside = await settle({ todayTerms: "B", days: ["2026-04-16", "2026-08-28"], termsOn: (day) => (day <= "2026-04-16" ? "A" : "B") }).result;
    assert.deepStrictEqual(inside.capture, { day: "2026-04-16", gap_days: 60, side: "after" });
    const outside = await settle({ todayTerms: "B", days: ["2026-04-17", "2026-08-28"], termsOn: (day) => (day <= "2026-04-17" ? "A" : "B") }).result;
    assert.strictEqual(outside.outcome, "no_usable_capture");
    assert.deepStrictEqual(outside.tried, []);
    assert.match(outside.why, /no capture on or before our text's day, nor within 60 days after it/);
  });

  it("reads the capture after our text's day when the one before cannot be read", async () => {
    const days = ["2026-02-14", ...everyDay("2026-02-20", TODAY)];
    const { result } = settle({ todayTerms: "B", days, termsOn: (day) => (day === "2026-02-14" ? null : day <= "2026-06-01" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.strictEqual(settled.capture.side, "after");
    assert.strictEqual(settled.date, "2026-06-02");
    assert.deepStrictEqual(settled.tried, [{ day: "2026-02-14", gap_days: 1, side: "before", why: "the capture could not be read" }]);
  });

  it("moves to the capture after our text's day when the reader cannot copy the plan's terms from the one before, and never calls that ours", async () => {
    const days = ["2026-02-14", ...everyDay("2026-02-20", TODAY)];
    const { result } = settle({ todayTerms: "A", days, termsOn: (day) => (day === "2026-02-14" ? NO_TERMS : "A") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.tried.map((t: { day: string; side: string; why: string }) => [t.day, t.side]), [["2026-02-14", "before"], ["2026-02-20", "after"]]);
    assert.strictEqual(settled.tried[0].why, "the capture settles nothing: no terms on the page");
  });

  it("stands today's page in for the record's day when the reader cannot copy the plan's terms from the capture nearest it", async () => {
    const { result } = settle({ todayTerms: "A", termsOn: (day) => (day === RECORD_DAY ? NO_TERMS : "A") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "ours");
    assert.strictEqual(settled.compared_with.page, "today");
  });

  it("leaves the record unsettled when the reader can copy the plan's terms from neither the capture nearest the record's day nor today's page", async () => {
    const { result } = settle({ todayTerms: null, termsOn: (day) => (day === RECORD_DAY ? NO_TERMS : "A") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.match(settled.why, /page on the record's day/);
  });

  it("is never ours when a capture before the record's day agrees but the reader cannot copy the plan's terms from today's page", async () => {
    const { result } = settle({ todayTerms: null, days: everyDay("2026-01-01", "2026-08-20"), termsOn: () => "A" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.match(settled.why, /could not compare today's page/);
  });

  it("leaves a record unsettled, never ours, when the only difference the reader claims is refuted by a figure a page repeats", async () => {
    const promo = "Launch offer: 10,000 calls a month for new sign-ups.";
    const planPage = (calls: string) => `<html><body><h2>Free plan</h2><p>${calls} calls a month.</p><p>${promo}</p><p>${FILLER}</p></body></html>`;
    const archive = {
      captures: async () => ({ captures: [capture("20260210120000"), capture("20260825120000")] }),
      captureHtml: async ({ timestamp }: { timestamp: string }) => ({ html: planPage(timestamp.startsWith("202602") ? "10,000" : "500") }),
    };
    const client = {
      complete: async () => JSON.stringify({ old_terms: ["10,000 calls a month"], new_terms: ["500 calls a month"], same: false, differences: [{ old: "10,000 calls a month", new: "" }], direction: "narrowed" }),
    };
    const settled = await settleAgainstCaptures({
      url: "https://example.com/pricing",
      textDay: "2026-02-15",
      recordDay: RECORD_DAY,
      todayText: `Free plan 500 calls a month. ${promo} ${FILLER}`,
      today: TODAY,
      archive,
      readPair: pairedReaderFor(client, { vendor: "Example", category: "APIs", tier: "Free" }),
    });
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.tried, [{ day: "2026-02-10", gap_days: 5, side: "before", why: 'the capture settles nothing: "10,000 calls a month" occurs more than once on the old page, so it cannot refute the difference' }]);
  });

  it("brackets each move when the terms moved more than once, and leaves the record's date to be split by hand", async () => {
    const { result } = settle({ todayTerms: "C", termsOn: (day) => (day <= "2026-04-10" ? "A" : day <= "2026-07-01" ? "B" : "C") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-04-10", "2026-04-11", "before"], ["2026-07-01", "2026-07-02", "before"]]);
    assert.strictEqual(settled.moves_complete, true);
    assert.strictEqual(settled.date, null);
  });

  it("steps past a capture it cannot read, or whose terms the reader cannot copy, while bisecting", async () => {
    const { result } = settle({ todayTerms: "B", termsOn: (day) => (day === "2026-04-10" ? null : day === "2026-04-09" ? NO_TERMS : day <= "2026-04-10" ? "A" : "B") });
    const settled = await result;
    assert.deepStrictEqual(spans(settled.brackets), [["2026-04-08", "2026-04-11", "before"]]);
    assert.strictEqual(settled.brackets[0].narrowed_to_adjacent_captures, true);
  });

  it("also reads the captures of the page a redirect lands on, since the Archive files a redirect's captures under its own address", async () => {
    const reader = termsPairReader();
    const asked: string[] = [];
    const moved = archiveOf(ALL_YEAR, (day) => (day <= "2026-04-10" ? "A" : "B"));
    const archive = {
      captures: async (url: string, from: string | null, to: string) => {
        asked.push(url);
        return url === "https://example.com/en/pricing" ? moved.captures(url, from, to) : { captures: [] };
      },
      captureHtml: moved.captureHtml,
    };
    const settled = await settleAgainstCaptures({
      url: "https://example.com/pricing",
      finalUrl: "https://example.com/en/pricing",
      textDay: "2026-02-15",
      recordDay: RECORD_DAY,
      todayText: "Free plan TERMS=B",
      today: TODAY,
      archive,
      readPair: reader.readPair,
    });
    assert.deepStrictEqual(asked, ["https://example.com/pricing", "https://example.com/en/pricing"]);
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.strictEqual(settled.date, "2026-04-11");
  });

  it("asks once when the page lands where it was listed, give or take www and a trailing slash", async () => {
    const asked: string[] = [];
    const archive = { captures: async (url: string) => { asked.push(url); return { captures: [] }; }, captureHtml: async () => ({ unavailable: "unused" }) };
    await settleAgainstCaptures({ url: "https://example.com/pricing", finalUrl: "https://www.example.com/pricing/", textDay: "2026-02-15", recordDay: RECORD_DAY, todayText: "", today: TODAY, archive, readPair: termsPairReader().readPair });
    assert.deepStrictEqual(asked, ["https://example.com/pricing"]);
  });

  it("hands each reading to a listener with the two pages it compared and the reader's verdict", async () => {
    const readings: Array<{ older: string; newer: string; verdict: { status: string } }> = [];
    const settled = await settleAgainstCaptures({
      url: "https://example.com/pricing",
      textDay: "2026-02-15",
      recordDay: RECORD_DAY,
      todayText: "Free plan TERMS=B",
      today: TODAY,
      archive: archiveOf(ALL_YEAR, (day) => (day <= "2026-04-10" ? "A" : "B")),
      readPair: termsPairReader().readPair,
      onRead: (reading: { older: string; newer: string; verdict: { status: string } }) => readings.push(reading),
    });
    const described = readings.map((reading) => `${reading.older} | ${reading.newer} ${reading.verdict.status}`);
    assert.strictEqual(readings.length, settled.reads);
    assert.strictEqual(described[0], "capture 2026-02-15 | capture 2026-08-28 differ");
    assert.ok(readings.slice(1, -1).every((reading) => reading.older === "capture 2026-02-15"), described.join("\n"));
    assert.strictEqual(described.at(-1), "capture 2026-04-11 | capture 2026-08-28 same");
  });

  it("says the Archive did not answer, rather than that no capture exists", async () => {
    const archive = { captures: async () => ({ unavailable: "HTTP 503 after 4 attempts" }), captureHtml: async () => ({ unavailable: "unused" }) };
    const settled = await settle({ todayTerms: "B", termsOn: () => "A", archive }).result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.match(settled.why, /HTTP 503 after 4 attempts/);
  });
});
