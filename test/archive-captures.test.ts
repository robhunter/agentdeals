import { describe, it } from "node:test";
import assert from "node:assert";

const { cdxUrl, parseCdxRows, nearestCapture, captureUrl, createArchiveClient, dayOurTextEntered, readCapture, readerFor, settleAgainstCaptures, CAPTURE_WINDOW_DAYS } = await import("../scripts/archive-captures.js");

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

  it("is unknown when no commit carries the text, or there is no text", () => {
    assert.strictEqual(dayOurTextEntered("never written", { commitDays: () => [] }), null);
    assert.strictEqual(dayOurTextEntered("  ", { commitDays: () => ["2025-04-02"] }), null);
  });
});

describe("reading a capture with the re-read's own reader", () => {
  const OFFER = { vendor: "Example", category: "Databases", tier: "Free", description: "Free plan: 500 MB database, 50,000 monthly active users" };
  const CAPTURE = "<html><head><style>.x{}</style><script>track()</script></head><body><h2>Free</h2><p>500 MB database &amp; 50,000 MAUs</p></body></html>";

  it("gives the reader the capture as text, with the stored terms beside it", async () => {
    const prompts: string[] = [];
    const client = { complete: async (prompt: string) => { prompts.push(prompt); return '{"status":"confirmed"}'; } };
    assert.deepStrictEqual(await readCapture(client, OFFER, CAPTURE), { status: "confirmed" });
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes("Free 500 MB database & 50,000 MAUs"), prompts[0]);
    assert.ok(prompts[0].includes(OFFER.description));
    assert.ok(!/<|track\(\)|\.x\{\}/.test(prompts[0].split("CURRENT PRICING PAGE TEXT (truncated):")[1].split("Compare the stored")[0]));
  });

  it("returns the reader's changed reading, with the terms it found on the capture", async () => {
    const client = { complete: async () => '{"status":"changed","summary":"lower cap","change_type":"limits_reduced","tier":"Free","tier_direction":"narrowed","current_state":"Free plan: 250 MB database","impact":"medium"}' };
    const reading = await readCapture(client, OFFER, CAPTURE);
    assert.strictEqual(reading.status, "changed");
    assert.strictEqual(reading.current_state, "Free plan: 250 MB database");
  });
});

function everyDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

function pageStating(terms: string | null): string {
  if (terms === null) return "<html><body>Loading…</body></html>";
  return `<html><body><h2>Free plan</h2><p>TERMS=${terms}</p><p>${"Plan comparison, limits and prices. ".repeat(20)}</p></body></html>`;
}

function archiveOf(days: string[], termsOn: (day: string) => string | null) {
  const listed: Array<{ from: string; to: string }> = [];
  return {
    listed,
    captures: async (_url: string, from: string, to: string) => {
      listed.push({ from, to });
      return { captures: days.filter((day) => day >= from && day <= to).map((day) => capture(`${day.replaceAll("-", "")}120000`)) };
    },
    captureHtml: async ({ timestamp }: { timestamp: string }) => ({
      html: pageStating(termsOn(`${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`)),
    }),
  };
}

function termsReader() {
  const calls: string[] = [];
  const read = async (stored: string, pageText: string) => {
    calls.push(stored);
    const found = pageText.match(/TERMS=(\w+)/);
    if (!found) return { status: "unclear", summary: "no terms on the page" };
    return found[1] === stored ? { status: "confirmed" } : { status: "changed", change_type: "limits_reduced", current_state: found[1] };
  };
  return { read, calls };
}

const TODAY = "2026-09-27";
const ALL_YEAR = everyDay("2025-10-01", TODAY);

function settle(options: { ourText?: string; textDay?: string | null; todayTerms: string; days?: string[]; termsOn: (day: string) => string | null; archive?: unknown }) {
  const reader = termsReader();
  const archive = options.archive ?? archiveOf(options.days ?? ALL_YEAR, options.termsOn);
  return {
    reader,
    archive,
    result: settleAgainstCaptures({
      url: "https://example.com/pricing",
      ourText: options.ourText ?? "A",
      textDay: options.textDay === undefined ? "2026-02-15" : options.textDay,
      todayText: `Free plan TERMS=${options.todayTerms}`,
      today: TODAY,
      archive,
      read: reader.read,
    }),
  };
}

describe("settling a first reading's difference against the page as the Archive stored it", () => {
  it("is unsettled when our text's day is unknown, and asks the Archive nothing", async () => {
    const { result, archive, reader } = settle({ textDay: null, todayTerms: "B", termsOn: () => "A" });
    assert.deepStrictEqual(await result, { outcome: "text_day_unknown", reads: 0 });
    assert.deepStrictEqual((archive as { listed: unknown[] }).listed, []);
    assert.deepStrictEqual(reader.calls, []);
  });

  it("calls the difference the vendor's when the capture on our text's day states our text, and brackets the move to adjacent captures", async () => {
    const { result } = settle({ todayTerms: "B", termsOn: (day) => (day <= "2026-04-10" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(settled.capture, { day: "2026-02-15", gap_days: 0, side: "before" });
    assert.strictEqual(settled.previous_state, "A");
    assert.deepStrictEqual(settled.brackets, [{ last_old: "2026-04-10", first_new: "2026-04-11", narrowed_to_adjacent_captures: true }]);
    assert.strictEqual(settled.later_moves, "none");
    assert.strictEqual(settled.date, "2026-04-11");
    assert.ok(settled.reads <= 12, `${settled.reads} reads`);
  });

  it("takes the old terms from the capture's reading when the page never stated our text", async () => {
    const { result } = settle({ ourText: "A0", todayTerms: "B", termsOn: (day) => (day <= "2026-04-10" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.strictEqual(settled.previous_state, "A");
    assert.deepStrictEqual(settled.brackets.map((b: { last_old: string; first_new: string }) => [b.last_old, b.first_new]), [["2026-04-10", "2026-04-11"]]);
  });

  it("calls the difference ours when the capture on or before our text's day already states today's terms", async () => {
    const { result } = settle({ todayTerms: "B", days: everyDay("2025-12-01", "2026-02-10"), termsOn: () => "B" });
    assert.deepStrictEqual(await result, { outcome: "ours", text_day: "2026-02-15", capture: { day: "2026-02-10", gap_days: 5, side: "before" }, terms_then: "B", reads: 2 });
  });

  it("does not call the difference ours from a capture after our text's day, since the vendor could have changed its terms in between", async () => {
    const { result } = settle({ todayTerms: "B", days: ["2026-03-01"], termsOn: () => "B" });
    const settled = await result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.deepStrictEqual(settled.tried.map((t: { day: string; side: string }) => [t.day, t.side]), [["2026-03-01", "after"]]);
    assert.match(settled.tried[0].why, /after our text's day/);
  });

  it("brackets a vendor change from a capture after our text's day that still states our text", async () => {
    const { result } = settle({ todayTerms: "B", days: everyDay("2026-03-01", TODAY), termsOn: (day) => (day <= "2026-05-20" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(settled.capture, { day: "2026-03-01", gap_days: 14, side: "after" });
    assert.strictEqual(settled.date, "2026-05-21");
  });

  it("reads the capture after our text's day when the one before cannot be read", async () => {
    const days = ["2026-02-14", ...everyDay("2026-02-20", TODAY)];
    const { result } = settle({ todayTerms: "B", days, termsOn: (day) => (day === "2026-02-14" ? null : day <= "2026-06-01" ? "A" : "B") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.strictEqual(settled.capture.side, "after");
    assert.strictEqual(settled.date, "2026-06-02");
  });

  it(`uses a capture ${CAPTURE_WINDOW_DAYS} days from our text's day, and none further`, async () => {
    const inside = await settle({ todayTerms: "B", days: ["2025-12-17"], termsOn: () => "B" }).result;
    assert.deepStrictEqual(inside.capture, { day: "2025-12-17", gap_days: 60, side: "before" });
    const outside = await settle({ todayTerms: "B", days: ["2025-12-16", "2026-04-17"], termsOn: () => "B" }).result;
    assert.strictEqual(outside.outcome, "no_usable_capture");
    assert.deepStrictEqual(outside.tried, []);
    assert.match(outside.why, /no capture within 60 days/);
  });

  it("brackets each move when the terms moved more than once, and leaves the record's date to be split by hand", async () => {
    const { result } = settle({ todayTerms: "C", termsOn: (day) => (day <= "2026-04-10" ? "A" : day <= "2026-07-01" ? "B" : "C") });
    const settled = await result;
    assert.strictEqual(settled.outcome, "vendor_changed");
    assert.deepStrictEqual(settled.brackets.map((b: { last_old: string; first_new: string }) => [b.last_old, b.first_new]), [["2026-04-10", "2026-04-11"], ["2026-07-01", "2026-07-02"]]);
    assert.strictEqual(settled.date, null);
  });

  it("steps past a capture it cannot read while bisecting", async () => {
    const { result } = settle({ todayTerms: "B", termsOn: (day) => (day === "2026-04-10" || day === "2026-06-06" ? null : day <= "2026-04-10" ? "A" : "B") });
    const settled = await result;
    assert.deepStrictEqual(settled.brackets.map((b: { last_old: string; first_new: string }) => [b.last_old, b.first_new]), [["2026-04-09", "2026-04-11"]]);
  });

  it("does not call it a vendor change when the capture on our text's day and today's page both state our text", async () => {
    const { result, reader } = settle({ todayTerms: "A", days: everyDay("2026-02-01", "2026-08-31"), termsOn: () => "A" });
    assert.deepStrictEqual(await result, { outcome: "not_reproduced", text_day: "2026-02-15", capture: { day: "2026-02-15", gap_days: 0, side: "before" }, reads: 2 });
    assert.deepStrictEqual(reader.calls, ["A", "A"]);
  });

  it("dates the move after the last capture when no capture shows the new terms", async () => {
    const { result } = settle({ todayTerms: "B", days: everyDay("2026-02-01", "2026-08-31"), termsOn: () => "A" });
    const settled = await result;
    assert.deepStrictEqual(settled.brackets, [{ last_old: "2026-08-31", first_new: null, narrowed_to_adjacent_captures: true }]);
    assert.strictEqual(settled.date, null);
  });

  it("says the Archive did not answer, rather than that no capture exists", async () => {
    const archive = { captures: async () => ({ unavailable: "HTTP 503 after 4 attempts" }), captureHtml: async () => ({ unavailable: "unused" }) };
    const settled = await settle({ todayTerms: "B", termsOn: () => "A", archive }).result;
    assert.strictEqual(settled.outcome, "no_usable_capture");
    assert.match(settled.why, /HTTP 503 after 4 attempts/);
  });

  it("asks the reader with the terms under test standing in for our stored text", async () => {
    const prompts: string[] = [];
    const client = { complete: async (prompt: string) => { prompts.push(prompt); return '{"status":"confirmed"}'; } };
    const read = readerFor(client, { vendor: "Example", category: "Databases", tier: "Free", description: "our catalogue text" });
    await read("the capture's terms", "Free plan: 250 MB database");
    assert.ok(prompts[0].includes("- Description: the capture's terms"), prompts[0]);
    assert.ok(!prompts[0].includes("our catalogue text"));
  });
});
