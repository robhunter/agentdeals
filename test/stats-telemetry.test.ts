// Telemetry storage-layer tests (#1018).
//
// These are hermetic: Upstash is stubbed at `globalThis.fetch`, so every case runs
// offline and deterministically. The behaviour under test is specifically what the
// old code could not express — the difference between "this counter is zero" and
// "we could not read this counter".

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

const {
  recordPageView,
  getPageViews,
  getRequestLogResult,
  getTelemetryHealth,
  resetTelemetryHealth,
  normalizePagePath,
  UNMATCHED_PAGE_KEY,
  logRequest,
  resetCounters,
} = await import("../dist/stats.js");

type Call = { cmd: string; args: unknown[] };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
/** Maps a Redis command name to the JSON body Upstash should answer with. */
let responder: (cmd: string, args: unknown[]) => unknown = () => ({ result: 1 });

function installFetchStub(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as unknown[];
    const cmd = String(parsed[0]).toUpperCase();
    const args = parsed.slice(1);
    calls.push({ cmd, args });
    const body = responder(cmd, args);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
}

function callsFor(cmd: string): Call[] {
  return calls.filter(c => c.cmd === cmd);
}

/** Lets fire-and-forget INCRs inside recordPageView settle before asserting. */
async function drain(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe("telemetry storage layer (#1018)", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    calls = [];
    responder = () => ({ result: 1 });
    resetTelemetryHealth();
    resetCounters();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  describe("normalizePagePath", () => {
    it("collapses slug routes onto their route pattern", () => {
      assert.strictEqual(normalizePagePath("/vendor/hetzner"), "/vendor/:slug");
      assert.strictEqual(normalizePagePath("/compare/vercel-vs-netlify"), "/compare/:slug");
      assert.strictEqual(normalizePagePath("/alternative-to/datadog"), "/alternative-to/:slug");
      assert.strictEqual(normalizePagePath("/embed/vendor/fly"), "/embed/vendor/:slug");
      assert.strictEqual(normalizePagePath("/embed/category/hosting"), "/embed/category/:slug");
    });

    it("keeps the root and ordinary static pages intact", () => {
      assert.strictEqual(normalizePagePath("/"), "/");
      assert.strictEqual(normalizePagePath("/storage-alternatives"), "/storage-alternatives");
      assert.strictEqual(normalizePagePath("/free-llm-apis"), "/free-llm-apis");
    });

    it("buckets the scanner paths found in the live keyspace", () => {
      // Every one of these was a permanent Redis key in production.
      assert.strictEqual(normalizePagePath("/$(pwd)/.env"), UNMATCHED_PAGE_KEY);
      assert.strictEqual(normalizePagePath("/$(pwd)/.git/config"), UNMATCHED_PAGE_KEY);
      assert.strictEqual(normalizePagePath("/$(pwd)/terraform.tfstate"), UNMATCHED_PAGE_KEY);
      assert.strictEqual(normalizePagePath("/%20/admin/"), UNMATCHED_PAGE_KEY);
    });

    it("rejects anything that is not a plausible single-segment page", () => {
      assert.strictEqual(normalizePagePath("/a/b/c"), UNMATCHED_PAGE_KEY);
      assert.strictEqual(normalizePagePath("/" + "x".repeat(200)), UNMATCHED_PAGE_KEY);
      assert.strictEqual(normalizePagePath(""), UNMATCHED_PAGE_KEY);
      assert.strictEqual(normalizePagePath("/Admin"), UNMATCHED_PAGE_KEY);
    });

    it("strips query strings and fragments before matching", () => {
      assert.strictEqual(normalizePagePath("/vendor/fly?ref=x"), "/vendor/:slug");
      assert.strictEqual(normalizePagePath("/estimate#top"), "/estimate");
    });
  });

  describe("recordPageView key space", () => {
    it("writes the normalized route pattern, never the raw path", async () => {
      recordPageView("/vendor/hetzner", "Mozilla/5.0", undefined, 200);
      await drain();
      const keys = callsFor("INCR").map(c => String(c.args[0]));
      assert.ok(keys.some(k => k.endsWith(":/vendor/:slug")), `expected a /vendor/:slug key, got ${keys.join(", ")}`);
      assert.ok(!keys.some(k => k.includes("hetzner")), "raw slug must not reach Redis");
    });

    it("buckets a 404 to __unmatched__ even when the path looks like a page", async () => {
      recordPageView("/wp-login", "Mozilla/5.0", undefined, 404);
      await drain();
      const keys = callsFor("INCR").map(c => String(c.args[0]));
      assert.ok(keys.some(k => k.endsWith(`:${UNMATCHED_PAGE_KEY}`)), `expected __unmatched__, got ${keys.join(", ")}`);
      assert.ok(!keys.some(k => k.includes("wp-login")), "a path we 404 must not mint its own key");
    });

    it("sets a TTL on a daily key the first time it is created", async () => {
      responder = cmd => (cmd === "INCR" ? { result: 1 } : { result: 1 });
      recordPageView("/estimate", "Mozilla/5.0", undefined, 200);
      await drain();
      const expired = callsFor("EXPIRE").map(c => String(c.args[0]));
      assert.ok(expired.some(k => k.startsWith("pv:20")), "daily key should be given a TTL on creation");
      assert.ok(!expired.some(k => k.startsWith("pv:all:")), "all-time counters must not expire");
    });

    it("does not re-arm the TTL on subsequent hits", async () => {
      responder = cmd => (cmd === "INCR" ? { result: 7 } : { result: 1 });
      recordPageView("/estimate", "Mozilla/5.0", undefined, 200);
      await drain();
      assert.strictEqual(callsFor("EXPIRE").length, 0, "EXPIRE on every hit would keep pushing the expiry out");
    });
  });

  describe("read failures are not reported as zeros (Defect B)", () => {
    it("reports total: null and partial: true when MGET fails", async () => {
      responder = (cmd) => {
        if (cmd === "SCAN") return { result: ["0", ["pv:all:/", "pv:all:/estimate"]] };
        if (cmd === "MGET") return { error: "ERR max request size exceeded" };
        return { result: 1 };
      };
      const report = await getPageViews();
      assert.strictEqual(report.all_time.total, null, "an unreadable counter must not read back as 0");
      assert.strictEqual(report.all_time.partial, true);
      assert.deepStrictEqual(report.all_time.top_pages, [], "must not publish a top-pages list of fake zeros");
    });

    it("marks the report unavailable when SCAN itself fails", async () => {
      responder = (cmd) => (cmd === "SCAN" ? { error: "ERR unavailable" } : { result: 1 });
      const report = await getPageViews();
      assert.strictEqual(report.available, false);
      assert.match(String(report.error), /unavailable/);
      assert.strictEqual(report.today.total, null);
    });

    it("still reports a genuine zero as zero", async () => {
      responder = (cmd) => {
        if (cmd === "SCAN") return { result: ["0", []] };
        if (cmd === "MGET") return { result: [] };
        return { result: 1 };
      };
      const report = await getPageViews();
      assert.strictEqual(report.available, true);
      assert.strictEqual(report.all_time.total, 0, "an empty keyspace is a real measurement of zero");
      assert.strictEqual(report.all_time.partial, false);
    });
  });

  describe("write-path failure is surfaced (Defect A)", () => {
    it("records the Upstash error instead of swallowing it", async () => {
      responder = () => ({ error: "ERR max daily request limit exceeded" });
      recordPageView("/estimate", "Mozilla/5.0", undefined, 200);
      await drain();
      const health = getTelemetryHealth();
      assert.ok(health.write_failures > 0, "a rejected INCR must be counted");
      assert.match(String(health.last_write_error), /max daily request limit/);
      assert.ok(health.last_write_error_at, "the failure needs a timestamp");
      assert.strictEqual(health.last_write_at, null, "a failed write must not look like a successful one");
    });

    it("advances last_write_at only on a successful write", async () => {
      await logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/test", params: {}, result_count: 0 });
      const ok = getTelemetryHealth();
      assert.ok(ok.last_write_at, "a successful LPUSH should stamp last_write_at");

      resetTelemetryHealth();
      responder = () => ({ error: "ERR quota" });
      await logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/test", params: {}, result_count: 0 });
      assert.strictEqual(getTelemetryHealth().last_write_at, null);
      assert.ok(getTelemetryHealth().write_failures > 0);
    });

    it("distinguishes an unreadable request log from an empty one", async () => {
      responder = () => ({ error: "ERR unavailable" });
      const failed = await getRequestLogResult(10);
      assert.strictEqual(failed.available, false);
      assert.match(String(failed.error), /unavailable/);

      responder = () => ({ result: [] });
      const empty = await getRequestLogResult(10);
      assert.strictEqual(empty.available, true, "a genuinely empty log is available, just empty");
      assert.strictEqual(empty.error, null);
      assert.deepStrictEqual(empty.entries, []);
    });
  });

  describe("MGET chunking", () => {
    it("never sends more than 100 keys in one command", async () => {
      const keys = Array.from({ length: 250 }, (_, i) => `pv:all:/page-${i}`);
      responder = (cmd, args) => {
        if (cmd === "SCAN") return { result: ["0", keys] };
        if (cmd === "MGET") return { result: args.map(() => "1") };
        return { result: 1 };
      };
      const report = await getPageViews();
      const mgets = callsFor("MGET");
      assert.ok(mgets.length >= 3, `expected 250 keys to be chunked, got ${mgets.length} call(s)`);
      for (const call of mgets) {
        assert.ok(call.args.length <= 100, `chunk of ${call.args.length} exceeds the 100-key cap`);
      }
      assert.strictEqual(report.all_time.total, 250, "chunking must not lose counts");
    });
  });
});
