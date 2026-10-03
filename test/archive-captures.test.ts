import { describe, it } from "node:test";
import assert from "node:assert";

const {
  cdxUrl,
  parseCdxRows,
  nearestCapture,
  captureUrl,
  archivedCopyUrl,
  createArchiveClient,
  dayOurTextEntered,
  comparableText,
  pairedPrompt,
  parsePairedAnswer,
  judgePair,
  valuesStated,
  pairedReaderFor,
  oldCaptureCandidates,
  recordDayCapture,
  settleAgainstCaptures,
  CAPTURE_WINDOW_DAYS,
} = await import("../scripts/archive-captures.js");

const statesItAlready = async () => ({ status: "stated", stated_then: [{ record: "the change", old: "the line" }] });

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

  it("sends a same answer to review when a line stating a value is copied from one page only and the other page does not state it, as Wraps' pair was", () => {
    const oldTerms = ["Free", "Get started - no credit card required", "$ 0 /mo", "Hosted dashboard", "5K tracked events /mo", "1 workflow", "7-day history", "Unlimited contacts", "CLI & SDK access", "10 AI generations/mo", "Community support"];
    const newTerms = ["Free forever", "Free", "Get started - no credit card required", "$0", "Dashboard + AI template editor", "5K tracked events/mo", "1 workflow", "Unlimited contacts", "CLI + TypeScript SDK", "10 AI template generations/mo"];
    const verdict = judgePair(answer({ old_terms: oldTerms, new_terms: newTerms, same: true, direction: "unchanged" }), oldTerms.join(". "), newTerms.join(". "));
    assert.strictEqual(verdict.status, "review", verdict.why);
    assert.deepStrictEqual(verdict.review.map((line: { old: string; new: string }) => [line.old, line.new]), [["$ 0 /mo", ""], ["7-day history", ""]]);
    assert.deepStrictEqual([verdict.old_terms, verdict.new_terms], [oldTerms, newTerms]);
  });

  it("keeps a same answer when the copies state the same values in other formats, a line without a value is reworded, or a line one copy left out is on the other page once", () => {
    const oldPage = "Free: $0 per month. 5 GB storage. 10,000 requests per month. 7-day history. Community support.";
    const newPage = "Free: $0/mo. 5GB storage. 10K requests monthly. 7-day history. Forum support.";
    const verdict = judgePair(answer({
      old_terms: ["Free: $0 per month", "5 GB storage", "10,000 requests per month", "7-day history", "Community support"],
      new_terms: ["Free: $0/mo", "5GB storage", "10K requests monthly", "Forum support"],
      same: true,
    }), oldPage, newPage);
    assert.strictEqual(verdict.status, "same", verdict.why);
  });

  it("sends a same answer to review when the line one copy left out is on the other page more than once, since it may belong to another plan there", () => {
    const oldPage = "Free plan. 7-day history. Pro plan. 30-day history.";
    const answered = (newPage: string) => judgePair(answer({ old_terms: ["Free plan", "7-day history"], new_terms: ["Free plan"], same: true }), oldPage, newPage);
    const twice = answered("Free plan. Pro plan. 7-day history. Team plan. 7-day history.");
    assert.strictEqual(twice.status, "review", twice.why);
    assert.deepStrictEqual(twice.review.map((line: { old: string; new: string }) => [line.old, line.new]), [["7-day history", ""]]);
    assert.strictEqual(answered("Free plan. 7-day history. Pro plan. 30-day history.").status, "same");
  });

  it("matches each copied line with one line on the other side, so two lines stating the same figure need two there", () => {
    const verdict = judgePair(answer({ old_terms: ["1 workflow", "1 team member"], new_terms: ["1 workflow"], same: true }), "1 workflow. 1 team member.", "1 workflow. Unlimited team members.");
    assert.strictEqual(verdict.status, "review", verdict.why);
    assert.deepStrictEqual(verdict.review.map((line: { old: string; new: string }) => [line.old, line.new]), [["1 team member", ""]]);
  });

  it("reads a copied line's figures after decoding its HTML entities, so an apostrophe written as &#8217; is not a figure", () => {
    const verdict = judgePair(answer({ old_terms: ["Free: 3 apps, it's free"], new_terms: ["Free: it&#8217;s free with 3 apps"], same: true }), "Free: 3 apps, it's free.", "Free: it&#8217;s free with 3 apps.");
    assert.strictEqual(verdict.status, "same", verdict.why);
  });

  it("sends a same answer to review when a negation is on one page only, though the line states no figure", () => {
    const verdict = judgePair(answer({ old_terms: ["Hobby: $0", "No credit card required"], new_terms: ["Hobby: $0", "Credit card required"], same: true }), "Hobby: $0. No credit card required.", "Hobby: $0. Credit card required.");
    assert.strictEqual(verdict.status, "review", verdict.why);
    assert.deepStrictEqual(verdict.review.map((line: { old: string; new: string }) => [line.old, line.new]), [["No credit card required", ""]]);
  });

  const sameAnswered = (oldTerms: string[], newTerms: string[]) =>
    judgePair(answer({ old_terms: oldTerms, new_terms: newTerms, same: true, direction: "unchanged" }), `${oldTerms.join(". ")}.`, `${newTerms.join(". ")}.`);

  it("sends a same answer to review when a copied line shares its terms but none of its other words with the lines on the other side", () => {
    const changes: [string[], string[], string[][]][] = [
      [["No credit card required", "Commercial use allowed"], ["Credit card required", "No commercial use"], [["No credit card required", ""], ["", "No commercial use"]]],
      [["3 projects", "Unlimited users"], ["3 users", "Unlimited projects"], [["3 projects", ""], ["Unlimited users", ""], ["", "3 users"], ["", "Unlimited projects"]]],
      [["10K requests/mo"], ["10K events/mo"], [["10K requests/mo", ""], ["", "10K events/mo"]]],
    ];
    for (const [oldTerms, newTerms, review] of changes) {
      const verdict = sameAnswered(oldTerms, newTerms);
      assert.strictEqual(verdict.status, "review", `${oldTerms.join(" / ")}: ${verdict.why}`);
      assert.deepStrictEqual(verdict.review.map((line: { old: string; new: string }) => [line.old, line.new]), review);
    }
  });

  it("does not count a unit as a word two lines share, so \"5 GB storage\" does not match \"5 GB bandwidth\"", () => {
    const verdict = sameAnswered(["5 GB storage"], ["5 GB bandwidth"]);
    assert.strictEqual(verdict.status, "review", verdict.why);
  });

  it("does not count a function word as a word two lines share, so \"Up to 3 projects\" does not match \"Up to 3 users\"", () => {
    const verdict = sameAnswered(["Up to 3 projects"], ["Up to 3 users"]);
    assert.strictEqual(verdict.status, "review", verdict.why);
  });

  it("names the words each matched pair of lines shares, in a same answer and in one sent to review", () => {
    const same = sameAnswered(["Free: 3 projects", "1 GB of storage", "$0/mo"], ["Free: 3 users", "Storage: 1 GB", "$0 per month"]);
    assert.strictEqual(same.status, "same", same.why);
    assert.deepStrictEqual(same.matched, [
      { old: "Free: 3 projects", new: "Free: 3 users", shared: ["free"] },
      { old: "1 GB of storage", new: "Storage: 1 GB", shared: ["storage"] },
      { old: "$0/mo", new: "$0 per month", shared: [] },
    ]);
    const review = sameAnswered(["Free: 3 projects", "7-day history"], ["Free: 3 users"]);
    assert.strictEqual(review.status, "review", review.why);
    assert.deepStrictEqual(review.matched, [{ old: "Free: 3 projects", new: "Free: 3 users", shared: ["free"] }]);
  });

  it("keeps a same answer when a reworded line shares a word with its match in any case or number, or states nothing besides its terms", () => {
    const reworded = [
      [["1 GB of storage"], ["Storage: 1 GB"]],
      [["No credit card required"], ["No credit card needed"]],
      [["Unlimited Projects"], ["unlimited project"]],
      [["$0/mo"], ["$0 per month"]],
    ];
    for (const [oldTerms, newTerms] of reworded) {
      const verdict = sameAnswered(oldTerms, newTerms);
      assert.strictEqual(verdict.status, "same", `${oldTerms[0]} / ${newTerms[0]}: ${verdict.why}`);
    }
  });

  it("does not count an added term whose words were already on the old page, so a limit our text never stated is not a change", () => {
    const page = "Free hosting: 1000 MB disk space, 5 GB bandwidth, up to 5,000 visits a month, no ads.";
    const verdict = judgePair(answer({ old_terms: ["1000 MB disk space, 5 GB bandwidth"], new_terms: ["1000 MB disk space, 5 GB bandwidth"], differences: [{ old: "", new: "up to 5,000 visits a month" }] }), page, page);
    assert.strictEqual(verdict.status, "same");
    assert.deepStrictEqual(verdict.refuted, [{ old: "", new: "up to 5,000 visits a month", why: "the new words were already on the old page" }]);
  });

  it("does not count a line only the new page states, and leaves the pair for review", () => {
    const before = "Free hosting: 1000 MB disk space, 5 GB bandwidth, no ads.";
    const after = "Free hosting: 1000 MB disk space, 5 GB bandwidth, up to 5,000 visits a month, no ads.";
    const verdict = judgePair(answer({ old_terms: ["1000 MB disk space, 5 GB bandwidth"], new_terms: ["1000 MB disk space, 5 GB bandwidth"], differences: [{ old: "", new: "up to 5,000 visits a month" }] }), before, after);
    assert.strictEqual(verdict.status, "review");
    assert.deepStrictEqual(verdict.one_sided, [{ old: "", new: "up to 5,000 visits a month", why: "only the new page states it" }]);
  });

  it("does not count a line only the old page states, such as a feature dropped from the plan's list", () => {
    const before = "Free: $0 /mo. Hosted dashboard. 7-day history. Community support. 10 AI generations/mo.";
    const after = "Free: $0 /mo. Hosted dashboard. Community support. 10 AI generations/mo.";
    const verdict = judgePair(answer({ old_terms: ["Free: $0 /mo"], new_terms: ["Free: $0 /mo"], differences: [{ old: "7-day history", new: "" }] }), before, after);
    assert.strictEqual(verdict.status, "review");
    assert.strictEqual(verdict.one_sided[0].why, "only the old page states it");
  });

  it("counts a term both pages state when its value differs, with 'Unlimited', 'none' and 'not included' as values", () => {
    const before = "Free plan: up to 500 monthly active rooms, 1 GB storage. Comments: none. Version history: included.";
    const after = "Free plan: Unlimited monthly active rooms, 1 GB storage. Comments: 100. Version history: not included.";
    const rooms = judgePair(answer({ old_terms: ["Free plan: up to 500 monthly active rooms"], new_terms: ["Free plan: Unlimited monthly active rooms"], differences: [{ old: "up to 500 monthly active rooms", new: "Unlimited monthly active rooms" }] }), before, after);
    assert.strictEqual(rooms.status, "differ", rooms.why);
    const comments = judgePair(answer({ old_terms: ["Free plan: up to 500 monthly active rooms"], new_terms: ["Free plan: Unlimited monthly active rooms"], differences: [{ old: "Comments: none", new: "Comments: 100" }] }), before, after);
    assert.strictEqual(comments.status, "differ", comments.why);
    const history = judgePair(answer({ old_terms: ["Free plan: up to 500 monthly active rooms"], new_terms: ["Free plan: Unlimited monthly active rooms"], differences: [{ old: "Version history: included", new: "Version history: not included" }] }), before, after);
    assert.strictEqual(history.status, "differ", history.why);
  });

  it("counts a figure that moved on a line that repeats another figure", () => {
    const before = "Free: 1 project, 1 member.";
    const after = "Free: 1 project, 2 members.";
    const verdict = judgePair(answer({ old_terms: ["Free: 1 project, 1 member"], new_terms: ["Free: 1 project, 2 members"], differences: [{ old: "1 project, 1 member", new: "1 project, 2 members" }] }), before, after);
    assert.strictEqual(verdict.status, "differ", verdict.why);
  });

  it("cannot settle a pair with a claimed difference it cannot verify, even beside lines one page states", () => {
    const before = "Free: 3 user seats. SOC 2 compliant.";
    const after = "Free: 2 user seats. SOC 2 compliant. MCP Server.";
    const verdict = judgePair(answer({ old_terms: ["Free: 3 user seats"], new_terms: ["Free: 2 user seats"], differences: [{ old: "3 seats", new: "2 seats" }, { old: "", new: "MCP Server" }] }), before, after);
    assert.deepStrictEqual([verdict.status, verdict.side], ["unquotable", "old"]);
    assert.strictEqual(verdict.one_sided.length, 1);
  });

  it("reads a reworded line as the same terms only when both sides state values and all of them match, and sends any other rewording to review", () => {
    const before = "Free: $ 0 /mo. Hosted dashboard. 10,000 events a month.";
    const after = "Free: $0 you pay AWS directly. Dashboard + AI template editor. 10K events a month.";
    const verdict = judgePair(
      answer({
        old_terms: ["Free: $ 0 /mo"],
        new_terms: ["Free: $0 you pay AWS directly"],
        differences: [
          { old: "Hosted dashboard", new: "Dashboard + AI template editor" },
          { old: "$ 0 /mo", new: "$0 you pay AWS directly" },
          { old: "10,000 events a month", new: "10K events a month" },
        ],
      }),
      before,
      after,
    );
    assert.strictEqual(verdict.status, "review", verdict.why);
    assert.deepStrictEqual(verdict.unmatched.map((claim: { why: string }) => claim.why), [
      "neither the old nor the new words state a value",
      'the figures match, but only the old words say "per month"',
    ]);
    assert.deepStrictEqual(verdict.reworded.map((claim: { why: string }) => claim.why), ["the old and the new words state the same values"]);
    assert.deepStrictEqual(verdict.review.map((claim: { old: string }) => claim.old), ["Hosted dashboard", "$ 0 /mo"]);
  });

  const judgeLine = (was: string, now: string) =>
    judgePair(
      answer({ old_terms: [`Free plan: ${was}`], new_terms: [`Free plan: ${now}`], differences: [{ old: was, new: now }], direction: "changed" }),
      `Pricing. Free plan: ${was}. Pro plan: $20/month.`,
      `Pricing. Free plan: ${now}. Pro plan: $20/month.`,
    );

  it("counts a line both pages state whose figures match but whose unit or period moved", () => {
    for (const [was, now] of [
      ["5 GB storage", "5 MB storage"],
      ["1 TB bandwidth", "1 GB bandwidth"],
      ["10,000 requests per month", "10,000 requests per day"],
      ["100 build hours", "100 build minutes"],
    ]) {
      const verdict = judgeLine(was, now);
      assert.strictEqual(verdict.status, "differ", `${was} -> ${now}: ${verdict.why}`);
    }
  });

  it("never reads as the same terms a line whose per-seat words or negation changed, or that states no value, and sends it to review", () => {
    for (const [was, now, why] of [
      ["$10/mo flat", "$10/user/mo", 'the figures match, but only the new words say "per seat"'],
      ["Custom domains", "No custom domains", "neither the old nor the new words state a value"],
      ["No credit card required", "Credit card required", "neither the old nor the new words state a value"],
      ["Commercial use allowed", "Commercial use not allowed", "neither the old nor the new words state a value"],
      ["For individuals and teams", "For non-commercial personal use only", "neither the old nor the new words state a value"],
      ["5 GB storage, no ads", "5 GB storage", 'the figures match, but only the old words say "no"'],
    ]) {
      const verdict = judgeLine(was, now);
      assert.strictEqual(verdict.status, "review", `${was} -> ${now}: ${verdict.why}`);
      assert.deepStrictEqual(verdict.review, [{ old: was, new: now, why }]);
    }
  });

  it("reads a line whose figures, units and periods changed only in how they are written as the same terms", () => {
    for (const [was, now] of [
      ["5 GB storage", "5GB storage"],
      ["10,000 requests per month", "10,000 requests/mo"],
      ["10,000 requests/mo", "10K requests monthly"],
    ]) {
      const verdict = judgeLine(was, now);
      assert.strictEqual(verdict.status, "same", `${was} -> ${now}: ${verdict.why}`);
    }
  });

  it("treats a value that only one side of a changed line states as a line only one page states", () => {
    const before = "Free: 1,000 build minutes.";
    const after = "Free: 1,000 build minutes, 100 GB bandwidth.";
    const verdict = judgePair(answer({ old_terms: ["Free: 1,000 build minutes"], new_terms: ["Free: 1,000 build minutes, 100 GB bandwidth"], differences: [{ old: "1,000 build minutes", new: "1,000 build minutes, 100 GB bandwidth" }] }), before, after);
    assert.strictEqual(verdict.status, "review");
    assert.strictEqual(verdict.one_sided[0].why, 'only the new words state "100"');
  });

  it("keeps a counted difference beside lines only one page states, and lists both", () => {
    const before = "Free: 3 user seats, 5 apps. SOC 2 compliant.";
    const after = "Free: 2 user seats, 5 apps. SOC 2 compliant. MCP Server.";
    const verdict = judgePair(answer({ old_terms: ["Free: 3 user seats, 5 apps"], new_terms: ["Free: 2 user seats, 5 apps"], differences: [{ old: "3 user seats", new: "2 user seats" }, { old: "", new: "MCP Server" }] }), before, after);
    assert.strictEqual(verdict.status, "differ");
    assert.deepStrictEqual(verdict.differences, [{ old: "3 user seats", new: "2 user seats" }]);
    assert.strictEqual(verdict.one_sided.length, 1);
  });

  it("counts a plan that the new page no longer offers, from what that page offers in its place", () => {
    const before = "Pricing. Basic plan: free, 10 GiB storage, 50M request units. Standard plan: from $0.18/hour.";
    const after = "Pricing. Start with a 30-day trial and $400 of credits. Standard plan: from $0.18/hour.";
    const verdict = judgePair(answer({ old_terms: ["Basic plan: free, 10 GiB storage, 50M request units"], new_terms: [], offered_instead: ["Start with a 30-day trial and $400 of credits"], differences: [], direction: "narrowed" }), before, after);
    assert.strictEqual(verdict.status, "differ", verdict.why);
    assert.strictEqual(verdict.plan, "disappeared");
    assert.deepStrictEqual(verdict.differences, [{ old: "Basic plan: free, 10 GiB storage, 50M request units", new: "" }]);
    assert.deepStrictEqual(verdict.offered_instead, ["Start with a 30-day trial and $400 of credits"]);
    const contradicted = judgePair(answer({ old_terms: ["Basic plan: free, 10 GiB storage, 50M request units"], new_terms: [], offered_instead: ["Start with a 30-day trial and $400 of credits"], same: true }), before, after);
    assert.deepStrictEqual([contradicted.status, contradicted.side], ["unquotable", "new"]);
  });

  it("counts a plan that the old page did not offer, from what that page offered in its place", () => {
    const before = "Pricing. Try the cloud free for 14 days. Serverless: from $25/month.";
    const after = "Pricing. Free sandbox: a permanent cluster with 1 million vectors. Serverless: from $25/month.";
    const verdict = judgePair(answer({ old_terms: [], new_terms: ["Free sandbox: a permanent cluster with 1 million vectors"], offered_instead: ["Try the cloud free for 14 days"], direction: "widened" }), before, after);
    assert.strictEqual(verdict.status, "differ", verdict.why);
    assert.strictEqual(verdict.plan, "appeared");
  });

  it("finds no move of a plan that neither page offers, once the reader copies from each page what it offers instead", () => {
    const before = "Pricing. Start with a 14-day trial. Pro: $25/month.";
    const after = "Pricing. Start with a 30-day trial. Pro: $25/month.";
    const absent = judgePair(answer({ old_terms: [], new_terms: [], offered_instead: ["Start with a 14-day trial", "Start with a 30-day trial"] }), before, after);
    assert.deepStrictEqual([absent.status, absent.why], ["absent", "neither page offers the plan"]);
    const fromOnePage = judgePair(answer({ old_terms: [], new_terms: [], offered_instead: ["Start with a 14-day trial"] }), before, after);
    assert.deepStrictEqual([fromOnePage.status, fromOnePage.side], ["unquotable", "both"]);
    const invented = judgePair(answer({ old_terms: [], new_terms: [], offered_instead: ["Start with a 14-day trial", "Enterprise only"] }), before, after);
    assert.match(invented.why, /on neither page: "Enterprise only"/);
  });

  it("does not take a plan for gone while its words are still on the page, or without copying what that page offers instead", () => {
    const before = "Pricing. Basic plan: free, 10 GiB storage. Standard plan: from $0.18/hour.";
    const truncated = `Pricing. Standard plan: from $0.18/hour. ${"Features. ".repeat(30)} Basic plan: free, 10 GiB storage.`;
    const still = judgePair(answer({ old_terms: ["Basic plan: free, 10 GiB storage"], new_terms: [], offered_instead: ["Standard plan: from $0.18/hour"] }), before, truncated);
    assert.deepStrictEqual([still.status, still.side], ["unquotable", "new"]);
    assert.strictEqual(still.why, 'the plan\'s words are still on the new page: "Basic plan: free, 10 GiB storage"');
    const after = "Pricing. Standard plan: from $0.18/hour.";
    const invented = judgePair(answer({ old_terms: ["Basic plan: free, 10 GiB storage"], new_terms: [], offered_instead: ["Basic plan retired"] }), before, after);
    assert.deepStrictEqual([invented.status, invented.side], ["unquotable", "new"]);
    assert.match(invented.why, /not on the new page: "Basic plan retired"/);
    const unsaid = judgePair(answer({ old_terms: ["Basic plan: free, 10 GiB storage"], new_terms: [] }), before, after);
    assert.deepStrictEqual([unsaid.status, unsaid.side, unsaid.why], ["unquotable", "new", "no terms quoted from the new page"]);
  });

  it("takes a plan for gone though its name or a feature it listed stays on the page, and leaves for review one whose figure the page still prints", () => {
    const before = "Pricing. Free: $0/month, 1 project, Community support. Pro: $20/month, 10 projects, Email support.";
    const read = { old_terms: ["Free", "$0/month", "1 project", "Community support"], new_terms: [], direction: "narrowed" };
    const trial = judgePair(answer({ ...read, offered_instead: ["Start a Free trial"] }), before, "Pricing. Start a Free trial. Pro: $20/month, 10 projects, Email support.");
    assert.deepStrictEqual([trial.status, trial.plan], ["differ", "disappeared"], trial.why);
    const feature = judgePair(answer({ ...read, offered_instead: ["Start a 14-day trial"] }), before, "Pricing. Start a 14-day trial. Pro: $20/month, 10 projects, Community support.");
    assert.deepStrictEqual([feature.status, feature.plan], ["differ", "disappeared"], feature.why);
    const fee = judgePair(answer({ ...read, offered_instead: ["Start a 14-day trial"] }), before, "Pricing. Start a 14-day trial. Pro: $20/month, 10 projects. Setup fee: $0/month for the first year.");
    assert.deepStrictEqual([fee.status, fee.side, fee.plan_claimed], ["unquotable", "new", "disappeared"]);
    assert.deepStrictEqual(fee.review, [{ old: "Free \u00B7 $0/month \u00B7 1 project \u00B7 Community support", new: "Start a 14-day trial", why: 'the plan\'s words are still on the new page: "$0/month"' }]);
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

describe("the values a line of terms states", () => {
  it("reads each figure once, without its separators, and scales a K, M or B written against it", () => {
    assert.deepStrictEqual(valuesStated("10,000 calls, 10K triggers, 1.5M rows, 1B tokens, $5.40/mo"), ["10000", "10000", "1500000", "1000000000", "5.4"]);
  });

  it("does not take a unit for a multiplier", () => {
    assert.deepStrictEqual(valuesStated("5MB file size, 50GB storage, 2 members, 100 kb"), ["5", "50", "2", "100"]);
  });

  it("reads 'Unlimited', 'none', 'not included' and 'included' as values, and 'not included' as one value", () => {
    assert.deepStrictEqual(valuesStated("Unlimited rooms; comments: None; SSO not included; backups included").sort(), ["included", "none", "not included", "unlimited"]);
    assert.deepStrictEqual(valuesStated("SSO: Not  included"), ["not included"]);
  });

  it("finds no value in a line that states none", () => {
    assert.deepStrictEqual(valuesStated("Hosted dashboard and community support"), []);
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

  it("asks the reader, when one page does not offer the plan, for the words that page offers in its place", () => {
    const prompt = pairedPrompt(LISTING, { day: "2026-02-15", text: OLD_PAGE }, { day: "2026-08-28", text: NEW_PAGE });
    assert.match(prompt, /If one page does not offer this plan at all, give an empty list for that page's terms, and copy into offered_instead/);
    assert.ok(prompt.includes('"offered_instead":["<fragment copied from the page that does not offer the plan>"]'), prompt);
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

function linesPairReader() {
  const calls: string[] = [];
  const readPair = async (older: Page, newer: Page) => {
    calls.push(`${older.page} | ${newer.page}`);
    const [was, wasLine = ""] = (older.text.match(/TERMS=(\w+)/)?.[1] ?? "").split("_");
    const [now, nowLine = ""] = (newer.text.match(/TERMS=(\w+)/)?.[1] ?? "").split("_");
    if (!was || !now) return { status: "unquotable", side: !was && !now ? "both" : !was ? "old" : "new", why: "no terms on the page" };
    const quoted = { old_terms: [`TERMS=${was}`], new_terms: [`TERMS=${now}`] };
    if (was !== now) return { status: "differ", ...quoted, differences: [{ old: `TERMS=${was}`, new: `TERMS=${now}` }] };
    if (wasLine !== nowLine) return { status: "review", ...quoted, review: [{ old: wasLine, new: nowLine, why: "one page states it" }], why: "no difference is a value both pages state moving, so the lines go to review" };
    return { status: "same", ...quoted };
  };
  return { readPair, calls };
}

const TODAY = "2026-09-27";
const RECORD_DAY = "2026-08-28";
const ALL_YEAR = everyDay("2025-10-01", TODAY);

function moveQuotedOnlySometimesReader() {
  const calls: string[] = [];
  const readPair = async (older: Page, newer: Page) => {
    calls.push(`${older.page} | ${newer.page}`);
    const [was, wasQuoted = ""] = (older.text.match(/TERMS=(\w+)/)?.[1] ?? "").split("_");
    const [now, nowQuoted = ""] = (newer.text.match(/TERMS=(\w+)/)?.[1] ?? "").split("_");
    if (!was || !now) return { status: "unquotable", side: !was && !now ? "both" : !was ? "old" : "new", why: "no terms on the page" };
    const quoted = { old_terms: [`TERMS=${was}`], new_terms: [`TERMS=${now}`] };
    if (was === now) return { status: "same", ...quoted };
    if (wasQuoted === "unquoted" || nowQuoted === "unquoted") return { status: "review", ...quoted, review: [{ old: `TERMS=${was}`, new: `TERMS=${now}`, why: "no value both pages state moved" }], why: "no difference is a value both pages state moving, so the lines go to review" };
    return { status: "differ", ...quoted, differences: [{ old: `TERMS=${was}`, new: `TERMS=${now}` }] };
  };
  return { readPair, calls };
}

function readerFindingNoPlanOn(terms: string) {
  const reader = termsPairReader();
  const readPair = async (older: Page, newer: Page) => {
    if (!newer.text.includes(`TERMS=${terms}`)) return reader.readPair(older, newer);
    reader.calls.push(`${older.page} | ${newer.page}`);
    return { status: "absent", side: "both", why: "neither page offers the plan", old_terms: [], new_terms: [], offered_instead: [] };
  };
  return { readPair, calls: reader.calls };
}

function statesTheRecordWhere(statesIt: (terms: string) => boolean, status = "stated") {
  return async (older: Page) => {
    const terms = older.text.match(/TERMS=(\w+)/)?.[1] ?? "";
    return statesIt(terms)
      ? { status, stated_then: [{ record: "the change", old: `TERMS=${terms}` }] }
      : { status: "unstated", why: 'no line already states "the change"', review: [{ record: "the change", old: "", why: "the capture does not state it" }] };
  };
}

const cannotReadTheRecord = async () => ({ status: "unstated", why: "the reader's answer could not be parsed", review: [] });

function settle(options: { textDay?: string | null; recordDay?: string; todayTerms: string | null; days?: string[]; termsOn: (day: string) => string | null; archive?: unknown; reader?: ReturnType<typeof termsPairReader>; statedBefore?: (older: Page) => Promise<unknown> }) {
  const reader = options.reader ?? termsPairReader();
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
      readStatedBefore: options.statedBefore ?? statesItAlready,
    }),
  };
}

function settlePlanPages(options: { plan: string; instead: string; offeredOn: (day: string) => boolean; offeredToday: boolean }) {
  const offer = (offered: boolean) => (offered ? options.plan : options.instead);
  const archive = {
    captures: async () => ({ captures: everyDay("2026-01-01", TODAY).map((day) => capture(`${day.replaceAll("-", "")}120000`)) }),
    captureHtml: async ({ timestamp }: { timestamp: string }) => {
      const day = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
      return { html: `<html><body><p>${offer(options.offeredOn(day))}.</p><p>Standard plan: from $0.18/hour.</p><p>${FILLER}</p></body></html>` };
    },
  };
  const client = {
    complete: async (prompt: string) => {
      const [, oldPage, newPage] = prompt.split(/(?:OLD|NEW) PAGE \(saved [^)]*\):\n/);
      const read = (page: string) => (page.includes(options.plan) ? { terms: [options.plan], instead: [] } : { terms: [], instead: [options.instead] });
      const before = read(oldPage);
      const after = read(newPage);
      const same = before.terms.length === after.terms.length;
      return JSON.stringify({ old_terms: before.terms, new_terms: after.terms, offered_instead: [...before.instead, ...after.instead], same, differences: [], direction: same ? "unchanged" : "changed" });
    },
  };
  return settleAgainstCaptures({
    url: "https://example.com/pricing",
    textDay: "2026-02-15",
    recordDay: RECORD_DAY,
    todayText: `${offer(options.offeredToday)}. Standard plan: from $0.18/hour. ${FILLER}`,
    today: TODAY,
    archive,
    readPair: pairedReaderFor(client, { vendor: "Example", category: "Databases", tier: "Free" }),
    readStatedBefore: statesItAlready,
  });
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

describe("the two addresses of an archived copy", () => {
  it("reads a copy's raw page from one address, and gives readers the Archive's own address for the copy", () => {
    const copy = capture("20260215120000");
    assert.strictEqual(captureUrl(copy), "https://web.archive.org/web/20260215120000id_/https://example.com/pricing");
    assert.strictEqual(archivedCopyUrl(copy), "https://web.archive.org/web/20260215120000/https://example.com/pricing");
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
    assert.deepStrictEqual(settled.capture, { day: "2026-02-15", gap_days: 0, side: "before", url: "https://web.archive.org/web/20260215120000/https://example.com/pricing" });
    assert.deepStrictEqual(settled.compared_with, { page: "capture 2026-08-28", day: "2026-08-28", gap_days: 0, side: "on" });
    assert.strictEqual(settled.previous_state, "TERMS=A");
    assert.deepStrictEqual(settled.terms_on_record_day, ["TERMS=B"]);
    assert.deepStrictEqual(spans(settled.brackets), [["2026-04-10", "2026-04-11", "before"]]);
    assert.deepStrictEqual([settled.brackets[0].last_old_capture, settled.brackets[0].first_new_capture], ["https://web.archive.org/web/20260410120000/https://example.com/pricing", "https://web.archive.org/web/20260411120000/https://example.com/pricing"]);
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
    assert.deepStrictEqual(settled.capture, { day: "2024-03-01", gap_days: 716, side: "before", url: "https://web.archive.org/web/20240301120000/https://example.com/pricing" });
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
    assert.strictEqual(settled.brackets[0].first_new_capture, null);
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
    assert.deepStrictEqual(settled.capture, { day: "2026-03-01", gap_days: 14, side: "after", url: "https://web.archive.org/web/20260301120000/https://example.com/pricing" });
    assert.strictEqual(settled.date, "2026-05-21");
  });

  it(`uses a capture after our text's day only within ${CAPTURE_WINDOW_DAYS} days of it`, async () => {
    const inside = await settle({ todayTerms: "B", days: ["2026-04-16", "2026-08-28"], termsOn: (day) => (day <= "2026-04-16" ? "A" : "B") }).result;
    assert.deepStrictEqual(inside.capture, { day: "2026-04-16", gap_days: 60, side: "after", url: "https://web.archive.org/web/20260416120000/https://example.com/pricing" });
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
      readStatedBefore: statesItAlready,
    });
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.tried, [{ day: "2026-02-10", gap_days: 5, side: "before", why: 'the capture settles nothing: "10,000 calls a month" occurs more than once on the old page, so it cannot refute the difference' }]);
  });

  it("puts a record on the review list, never ours, when the only differences on the record's day are lines one page states", async () => {
    const { result } = settle({ todayTerms: "A_bandwidth", termsOn: (day) => (day <= "2026-06-09" ? "A" : "A_bandwidth"), reader: linesPairReader() });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.review, [{ old: "", new: "bandwidth", why: "one page states it" }]);
    assert.deepStrictEqual(settled.compared_with, { page: "capture 2026-08-28", day: "2026-08-28", gap_days: 0, side: "on" });
    assert.deepStrictEqual(settled.capture, { day: "2026-02-15", gap_days: 0, side: "before", url: "https://web.archive.org/web/20260215120000/https://example.com/pricing" });
  });

  it("puts a record on the review list when the capture before the record's day agrees but today's page differs only by lines one page states", async () => {
    const { result } = settle({ todayTerms: "A_bandwidth", days: everyDay("2026-01-01", "2026-08-20"), termsOn: () => "A", reader: linesPairReader() });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.strictEqual(settled.compared_with.page, "today");
    assert.strictEqual(settled.review.length, 1);
  });

  it("puts a record on the review list, with the words that kept it open, when no capture settles a plan's removal", async () => {
    const line = { old: "Free \u00B7 $0/month", new: "Start a 14-day trial", why: 'the plan\'s words are still on the new page: "$0/month"' };
    const lingering = { calls: [] as string[], readPair: async () => ({ status: "unquotable", side: "new", why: line.why, old_terms: ["Free", "$0/month"], new_terms: [], plan_claimed: "disappeared", review: [line] }) };
    const settled = await settle({ todayTerms: "A", termsOn: () => "A", reader: lingering }).result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.review, [line]);
    assert.deepStrictEqual(settled.compared_with, { page: "capture 2026-08-28", day: "2026-08-28", gap_days: 0, side: "on" });

    const misread = { calls: [] as string[], readPair: async () => ({ status: "unquotable", side: "new", why: "no terms on the page" }) };
    const unread = await settle({ todayTerms: "A", termsOn: () => "A", reader: misread }).result;
    assert.strictEqual(unread.outcome, "no_usable_capture");
    assert.strictEqual(unread.review, undefined);
  });

  it("bisects past captures that differ only by lines one page states and do not state what the record calls new, to the capture where a value moved", async () => {
    const termsOn = (day: string) => (day <= "2026-06-09" ? "A" : day <= "2026-08-05" ? "A_bandwidth" : "B_bandwidth");
    const { result } = settle({ todayTerms: "B_bandwidth", termsOn, reader: linesPairReader(), statedBefore: statesTheRecordWhere((terms) => terms.startsWith("B")) });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-08-05", "2026-08-06", "before"]]);
    assert.strictEqual(settled.date, "2026-08-06");
  });

  it("dates a move by the first capture that states what the record calls new, though the reader could not quote the move on it", async () => {
    const days = ["2026-02-15", ...everyDay("2026-07-01", "2026-08-10"), RECORD_DAY];
    const termsOn = (day: string) => (day <= "2026-07-14" ? "A" : day <= "2026-08-03" ? "B_unquoted" : "B");
    for (const status of ["stated", "removal_stated"]) {
      const statedBefore = statesTheRecordWhere((terms) => terms.startsWith("B"), status);
      const settled = await settle({ todayTerms: "B", days, termsOn, reader: moveQuotedOnlySometimesReader(), statedBefore }).result;
      assert.strictEqual(settled.outcome, "vendor_changed");
      assert.deepStrictEqual(spans(settled.brackets), [["2026-07-14", "2026-07-15", "before"]], status);
      assert.strictEqual(settled.moves_complete, true);
      assert.strictEqual(settled.date, "2026-07-15");
    }
  });

  it("ends no bracket on a capture read for review when the bracket's first page already states what the record calls new, or the reader cannot say", async () => {
    const days = ["2026-02-15", ...everyDay("2026-06-01", "2026-06-20"), RECORD_DAY];
    const termsOn = (day: string) => (day <= "2026-06-09" ? "A" : day <= "2026-06-12" ? "A_bandwidth" : "B_bandwidth");
    for (const statedBefore of [statesItAlready, cannotReadTheRecord]) {
      const settled = await settle({ todayTerms: "B_bandwidth", days, termsOn, reader: linesPairReader(), statedBefore }).result;
      assert.deepStrictEqual(spans(settled.brackets), [["2026-06-09", "2026-06-13", "before"]]);
      assert.strictEqual(settled.brackets[0].narrowed_to_adjacent_captures, true);
    }
  });

  it("ends no bracket on a capture where the reader found the plan on neither page, once the bracket began with the plan offered", async () => {
    const days = ["2026-02-15", ...everyDay("2026-04-01", "2026-04-20"), RECORD_DAY];
    const termsOn = (day: string) => (day <= "2026-04-08" ? "A" : day <= "2026-04-10" ? "GONE" : "B");
    const settled = await settle({ todayTerms: "B", days, termsOn, reader: readerFindingNoPlanOn("GONE") }).result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-04-08", "2026-04-11", "before"]]);
  });

  it("finds no further move when the pages after a move differ only by lines one page states", async () => {
    const termsOn = (day: string) => (day <= "2026-05-15" ? "A" : day <= "2026-07-15" ? "B" : "B_collections");
    const { result } = settle({ todayTerms: "B_collections", termsOn, reader: linesPairReader() });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(spans(settled.brackets), [["2026-05-15", "2026-05-16", "before"]]);
    assert.strictEqual(settled.moves_complete, true);
    assert.strictEqual(settled.date, "2026-05-16");
  });

  it("dates a plan the page stopped offering, and keeps what it offers instead as the terms on the record's day", async () => {
    const plan = "Basic plan: free, 10 GiB storage, 50M request units";
    const instead = "Start with a 30-day trial and $400 of credits";
    const settled = await settlePlanPages({ plan, instead, offeredOn: (day) => day <= "2026-04-10", offeredToday: false });
    assert.strictEqual(settled.outcome, "vendor_changed", settled.why);
    assert.strictEqual(settled.plan, "disappeared");
    assert.strictEqual(settled.previous_state, "Basic plan: free, 10 GiB storage, 50M request units");
    assert.deepStrictEqual(settled.offered_instead, ["Start with a 30-day trial and $400 of credits"]);
    assert.deepStrictEqual(spans(settled.brackets), [["2026-04-10", "2026-04-11", "before"]]);
    assert.strictEqual(settled.moves_complete, true);
    assert.strictEqual(settled.date, "2026-04-11");
  });

  it("dates a plan the page began offering, bisecting past captures that offer something else in its place", async () => {
    const plan = "Free sandbox: a permanent cluster with 1 million vectors";
    const instead = "Try the cloud free for 14 days";
    const settled = await settlePlanPages({ plan, instead, offeredOn: (day) => day >= "2026-06-01", offeredToday: true });
    assert.strictEqual(settled.outcome, "vendor_changed", settled.why);
    assert.strictEqual(settled.plan, "appeared");
    assert.strictEqual(settled.previous_state, instead);
    assert.deepStrictEqual(spans(settled.brackets), [["2026-05-31", "2026-06-01", "before"]]);
    assert.strictEqual(settled.date, "2026-06-01");
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
      readStatedBefore: statesItAlready,
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
      readStatedBefore: statesItAlready,
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
