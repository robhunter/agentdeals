import { describe, it } from "node:test";
import assert from "node:assert";

const { cdxUrl, parseCdxRows, nearestCapture, captureUrl, createArchiveClient, dayOurTextEntered, readCapture } = await import("../scripts/archive-captures.js");

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
