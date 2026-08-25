// Telemetry storage-layer tests (#1018, #1023).
//
// These are hermetic: Upstash is stubbed at `globalThis.fetch`, so every case runs
// offline and deterministically. The behaviour under test is specifically what the
// old code could not express — the difference between "this counter is zero" and
// "we could not read this counter".
//
// Page-view counters no longer live one Redis key per (day, path); they are buffered in
// memory and persisted as a single JSON snapshot on a flush interval (#1023), so the
// assertions here look at what a flush *writes* rather than at per-request INCRs.

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
  NOT_FOUND_KEY,
  logRequest,
  resetCounters,
  loadTelemetry,
  flushTelemetry,
  flushPending,
  telemetryLoadDidFail,
} = await import("../dist/stats.js");

type Call = { cmd: string; args: unknown[] };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
/** Maps a Redis command name to the JSON body Upstash should answer with. */
let responder: (cmd: string, args: unknown[]) => unknown = () => ({ result: 1 });

const PAGE_VIEWS_KEY = "agentdeals:pageviews";
const TELEMETRY_KEY = "agentdeals:telemetry";
const TMP_TELEMETRY = "/tmp/agentdeals-telemetry-test.json";

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

/** The SET that persisted the page-view snapshot, parsed. */
function writtenSnapshot(): any {
  const set = callsFor("SET").find(c => String(c.args[0]) === PAGE_VIEWS_KEY);
  assert.ok(set, `no SET of ${PAGE_VIEWS_KEY}; SETs: ${callsFor("SET").map(c => c.args[0]).join(", ")}`);
  return JSON.parse(String(set!.args[1]));
}

/** An empty-but-healthy store: every read succeeds and returns nothing. */
const emptyStore = (cmd: string): unknown => {
  if (cmd === "GET") return { result: null };
  if (cmd === "SCAN") return { result: ["0", []] };
  if (cmd === "LRANGE" || cmd === "MGET") return { result: [] };
  return { result: "OK" };
};

/** Boots the module against a store, leaving it in the loaded state a live server has. */
async function boot(store: (cmd: string, args: unknown[]) => unknown = emptyStore): Promise<void> {
  responder = store;
  await loadTelemetry(TMP_TELEMETRY);
  calls = [];
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
      await boot();
      recordPageView("/vendor/hetzner", "Mozilla/5.0", undefined, 200);
      await flushPending();

      const snapshot = writtenSnapshot();
      assert.ok(snapshot.all_time["/vendor/:slug"] >= 1, "expected a /vendor/:slug counter");
      assert.ok(!JSON.stringify(snapshot).includes("hetzner"), "raw slug must not reach Redis");
    });

    // Contract changed by #1029. It used to be "a 404 buckets to __unmatched__", which
    // bounded the key space but still counted the request as a page view — 84% of a day's
    // recorded views on the day that was found. It is now "a 404 is not a page view":
    // counted, under its own name, outside the total.
    it("counts a 404 as not-found rather than as a page view, however page-like the path", async () => {
      await boot();
      recordPageView("/wp-login", "Mozilla/5.0", undefined, 404);
      recordPageView("/estimate", "Mozilla/5.0", undefined, 200);
      await flushPending();

      const snapshot = writtenSnapshot();
      const today = new Date().toISOString().slice(0, 10);
      assert.strictEqual(snapshot.days[today][NOT_FOUND_KEY], 1, "expected a not-found counter");
      assert.strictEqual(snapshot.all_time[NOT_FOUND_KEY], 1);
      assert.strictEqual(snapshot.days[today].total, 1, "only the served request is in the total");
      assert.strictEqual(snapshot.days[today][UNMATCHED_PAGE_KEY], undefined, "nothing writes the legacy bucket");
      assert.ok(!JSON.stringify(snapshot).includes("wp-login"), "a path we 404 must not mint its own key");

      const report = await getPageViews();
      assert.strictEqual(report.today.total, 1);
      assert.strictEqual(report.today.not_found, 1);
    });

    it("counts a 3xx apart from both — the request that follows it is the page view", async () => {
      await boot();
      recordPageView("/compare/b-vs-a", "Mozilla/5.0", undefined, 301);
      recordPageView("/compare/a-vs-b", "Mozilla/5.0", undefined, 200);
      await flushPending();

      const report = await getPageViews();
      assert.strictEqual(report.today.total, 1, "the redirect and its target are one page view");
      assert.strictEqual(report.today.redirects, 1);
      assert.strictEqual(report.today.not_found, 0, "a redirect is not a not-found");
    });

    it("keeps the day-scoped total alongside the per-path counters", async () => {
      await boot();
      recordPageView("/", "Mozilla/5.0", undefined, 200);
      recordPageView("/estimate", "Mozilla/5.0", undefined, 200);
      await flushPending();

      const today = new Date().toISOString().slice(0, 10);
      const day = writtenSnapshot().days[today];
      assert.strictEqual(day.total, 2);
      assert.strictEqual(day["/"], 1);
      assert.strictEqual(day["/estimate"], 1);
    });
  });

  describe("read failures are not reported as zeros (Defect B)", () => {
    it("marks the report unavailable when the snapshot could not be read", async () => {
      responder = () => ({ error: "ERR unavailable" });
      await loadTelemetry(TMP_TELEMETRY);

      const report = await getPageViews();
      assert.strictEqual(report.available, false);
      assert.match(String(report.error), /unavailable/);
      assert.strictEqual(report.today.total, null, "an unreadable counter must not read back as 0");
      assert.strictEqual(report.all_time.total, null);
      assert.deepStrictEqual(report.all_time.top_pages, [], "must not publish a top-pages list of fake zeros");
      assert.strictEqual(report.all_time.partial, true);
    });

    it("marks the report unavailable when the legacy migration scan fails", async () => {
      // The snapshot key is genuinely absent, but the legacy key space is unreadable —
      // seeding an empty snapshot here would erase real history on the next flush.
      responder = (cmd) => {
        if (cmd === "GET") return { result: null };
        if (cmd === "SCAN") return { error: "ERR unavailable" };
        return { result: "OK" };
      };
      await loadTelemetry(TMP_TELEMETRY);

      const report = await getPageViews();
      assert.strictEqual(report.available, false);

      calls = [];
      recordPageView("/", "Mozilla/5.0", undefined, 200);
      await flushPending();
      assert.strictEqual(
        callsFor("SET").filter(c => String(c.args[0]) === PAGE_VIEWS_KEY).length,
        0,
        "must not persist a snapshot built on an unread history",
      );
    });

    it("still reports a genuine zero as zero", async () => {
      await boot();
      const report = await getPageViews();
      assert.strictEqual(report.available, true);
      assert.strictEqual(report.all_time.total, 0, "an empty keyspace is a real measurement of zero");
      assert.strictEqual(report.all_time.partial, false);
    });
  });

  describe("write-path failure is surfaced (Defect A)", () => {
    it("records the Upstash error instead of swallowing it", async () => {
      await boot();
      resetTelemetryHealth();
      responder = () => ({ error: "ERR max daily request limit exceeded" });

      recordPageView("/estimate", "Mozilla/5.0", undefined, 200);
      await flushPending();

      const health = getTelemetryHealth();
      assert.ok(health.write_failures > 0, "a rejected write must be counted");
      assert.match(String(health.last_write_error), /max daily request limit/);
      assert.ok(health.last_write_error_at, "the failure needs a timestamp");
      assert.strictEqual(health.last_write_at, null, "a failed write must not look like a successful one");
      assert.strictEqual(health.quota_exhausted, true, "a spent quota is not an ordinary write error");
    });

    it("advances last_write_at only on a successful write", async () => {
      await boot();
      resetTelemetryHealth();
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/test", params: {}, result_count: 0 });
      await flushPending();
      assert.ok(getTelemetryHealth().last_write_at, "a successful LPUSH should stamp last_write_at");

      resetTelemetryHealth();
      responder = () => ({ error: "ERR quota" });
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/test", params: {}, result_count: 0 });
      await flushPending();
      assert.strictEqual(getTelemetryHealth().last_write_at, null);
      assert.ok(getTelemetryHealth().write_failures > 0);
    });

    it("distinguishes an unreadable request log from an empty one", async () => {
      responder = () => ({ error: "ERR unavailable" });
      await loadTelemetry(TMP_TELEMETRY);
      const failed = await getRequestLogResult(10);
      assert.strictEqual(failed.available, false);
      assert.match(String(failed.error), /unavailable/);

      resetCounters();
      await boot();
      const empty = await getRequestLogResult(10);
      assert.strictEqual(empty.available, true, "a genuinely empty log is available, just empty");
      assert.strictEqual(empty.error, null);
      assert.deepStrictEqual(empty.entries, []);
    });
  });

  describe("a failed load must not clobber stored history", () => {
    it("refuses to persist zeros after the boot-time read failed", async () => {
      responder = () => ({ error: "ERR max requests limit exceeded. Limit: 500000, Usage: 500000" });
      await loadTelemetry(TMP_TELEMETRY);
      assert.strictEqual(telemetryLoadDidFail(), true, "an errored GET is not an empty database");

      calls = [];
      await flushTelemetry();
      assert.strictEqual(
        callsFor("SET").filter(c => String(c.args[0]) === TELEMETRY_KEY).length,
        0,
        "flushing zeros over real history is data loss",
      );
    });

    it("resumes persisting once storage recovers", async () => {
      responder = () => ({ error: "ERR max requests limit exceeded" });
      await loadTelemetry(TMP_TELEMETRY);
      assert.strictEqual(telemetryLoadDidFail(), true);

      // Storage comes back with the real historical totals.
      responder = (cmd) => {
        if (cmd === "GET") return { result: JSON.stringify({ cumulative_api_hits: 282802, cumulative_sessions: 24955 }) };
        return { result: "OK" };
      };
      calls = [];
      await flushTelemetry();
      assert.strictEqual(telemetryLoadDidFail(), false, "a successful re-read clears the block");

      const sets = callsFor("SET").filter(c => String(c.args[0]) === TELEMETRY_KEY);
      assert.strictEqual(sets.length, 1, "persistence should resume");
      const written = JSON.parse(String(sets[0].args[1]));
      assert.strictEqual(written.cumulative_api_hits, 282802, "history must be re-hydrated, not overwritten with zeros");
    });

    it("persists normally when the boot-time read succeeds", async () => {
      responder = (cmd, args) => {
        if (cmd === "GET" && String(args[0]) === TELEMETRY_KEY) {
          return { result: JSON.stringify({ cumulative_api_hits: 100 }) };
        }
        return emptyStore(cmd);
      };
      await loadTelemetry(TMP_TELEMETRY);
      assert.strictEqual(telemetryLoadDidFail(), false);
      calls = [];
      await flushTelemetry();
      assert.strictEqual(callsFor("SET").filter(c => String(c.args[0]) === TELEMETRY_KEY).length, 1);
    });
  });

  describe("MGET chunking", () => {
    it("never sends more than 100 keys in one command", async () => {
      // Only the one-time migration off the legacy key space still reads this way.
      const keys = Array.from({ length: 250 }, (_, i) => `pv:all:/page-${i}`);
      responder = (cmd, args) => {
        if (cmd === "GET") return { result: null };
        if (cmd === "SCAN") return { result: ["0", String(args[2]) === "pv:all:*" ? keys : []] };
        if (cmd === "MGET") return { result: args.map(() => "1") };
        if (cmd === "LRANGE") return { result: [] };
        return { result: "OK" };
      };
      await loadTelemetry(TMP_TELEMETRY);

      const mgets = callsFor("MGET");
      assert.ok(mgets.length >= 3, `expected 250 keys to be chunked, got ${mgets.length} call(s)`);
      for (const call of mgets) {
        assert.ok(call.args.length <= 100, `chunk of ${call.args.length} exceeds the 100-key cap`);
      }

      const report = await getPageViews();
      assert.strictEqual(report.all_time.total, 250, "chunking must not lose counts");
    });
  });
});
