// Telemetry write-path budget tests (#1023).
//
// The 2026-08-07 outage was not bad luck: with one Redis command per HTTP request,
// steady-state command volume sat over the plan's 500,000/month ceiling, so the write
// path died and stayed dead. These tests lock the property that fixed it — Redis command
// volume is a function of *flush intervals*, not of requests served.
//
// Hermetic: Upstash is replaced by an in-process fake that actually stores values, so the
// assertions can check both the command count and the data that ends up persisted.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const {
  recordPageView,
  getPageViews,
  getRequestLogResult,
  getTelemetryHealth,
  resetTelemetryHealth,
  resetTelemetryBuffers,
  resetCounters,
  loadTelemetry,
  flushPending,
  logRequest,
  UNMATCHED_PAGE_KEY,
  OTHER_REFERRER_KEY,
  FLUSH_INTERVAL_SECONDS,
} = await import("../dist/stats.js");

const PAGE_VIEWS_KEY = "agentdeals:pageviews";
const REQUEST_LOG_KEY = "agentdeals:request_log";
const REQUEST_LOG_MAX = 1000;
const REQUEST_LOG_FLUSH_MAX = 250;

type Call = { cmd: string; args: unknown[] };

/** Minimal stateful Upstash stand-in: enough of the command set to run the write path. */
class FakeUpstash {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();
  calls: Call[] = [];
  /** When set, commands answer with this error in a 200 body, as Upstash does. */
  failWith: string | null = null;
  /** Restricts `failWith` to these commands, so a read can fail while writes still work. */
  failOnly: Set<string> | null = null;
  /** Runs while a command is in flight — lets a test act inside the await window. */
  onCommand: ((cmd: string, args: unknown[]) => void) | null = null;

  reset(): void {
    this.calls = [];
    this.failWith = null;
    this.failOnly = null;
  }

  shouldFail(cmd: string): boolean {
    return this.failWith !== null && (this.failOnly === null || this.failOnly.has(cmd));
  }

  commandCount(cmd?: string): number {
    return cmd ? this.calls.filter(c => c.cmd === cmd).length : this.calls.length;
  }

  callsFor(cmd: string): Call[] {
    return this.calls.filter(c => c.cmd === cmd);
  }

  exec(cmd: string, args: unknown[]): unknown {
    switch (cmd) {
      case "GET": {
        const v = this.values.get(String(args[0]));
        return { result: v === undefined ? null : v };
      }
      case "SET":
        this.values.set(String(args[0]), String(args[1]));
        return { result: "OK" };
      case "DEL":
        this.values.delete(String(args[0]));
        return { result: 1 };
      case "MGET":
        return { result: args.map(k => this.values.get(String(k)) ?? null) };
      case "SCAN": {
        const pattern = String(args[2]);
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        const keys = [...this.values.keys()].filter(k => k.startsWith(prefix));
        return { result: ["0", keys] };
      }
      case "LPUSH": {
        const key = String(args[0]);
        const list = this.lists.get(key) ?? [];
        for (const v of args.slice(1)) list.unshift(String(v));
        this.lists.set(key, list);
        return { result: list.length };
      }
      case "LTRIM": {
        const key = String(args[0]);
        const list = this.lists.get(key) ?? [];
        this.lists.set(key, list.slice(Number(args[1]), Number(args[2]) + 1));
        return { result: "OK" };
      }
      case "LRANGE": {
        const list = this.lists.get(String(args[0])) ?? [];
        return { result: list.slice(Number(args[1]), Number(args[2]) + 1) };
      }
      default:
        return { result: 1 };
    }
  }
}

const realFetch = globalThis.fetch;
let redis: FakeUpstash;
let telemetryFile: string;

function installFetchStub(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as unknown[];
    const cmd = String(parsed[0]).toUpperCase();
    const args = parsed.slice(1);
    redis.calls.push({ cmd, args });
    redis.onCommand?.(cmd, args);
    const body = redis.shouldFail(cmd) ? { error: redis.failWith } : redis.exec(cmd, args);
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

/** Boots the module against the fake and clears the call log, as a live server would be. */
async function boot(): Promise<void> {
  await loadTelemetry(telemetryFile);
  redis.reset();
  resetTelemetryHealth();
}

function pageView(path: string, referer?: string): void {
  recordPageView(path, "Mozilla/5.0 (Macintosh) Chrome/120", referer, 200);
}

function entry(n: number) {
  return {
    ts: new Date(Date.UTC(2026, 7, 25, 0, 0, n % 60)).toISOString(),
    type: "api" as const,
    endpoint: `/api/offers`,
    params: { n },
    user_agent: "test",
    result_count: n,
  };
}

function storedSnapshot(): any {
  const raw = redis.values.get(PAGE_VIEWS_KEY);
  assert.ok(raw, "expected a persisted page-view snapshot");
  return JSON.parse(raw!);
}

const today = () => new Date().toISOString().slice(0, 10);

describe("telemetry command budget (#1023)", () => {
  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    redis = new FakeUpstash();
    telemetryFile = join(tmpdir(), `telemetry-budget-${randomUUID()}.json`);
    resetCounters();
    resetTelemetryHealth();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  describe("the request path spends no commands", () => {
    it("records 500 page views and 500 logged requests without touching Redis", async () => {
      await boot();

      for (let i = 0; i < 500; i++) {
        pageView(i % 2 === 0 ? "/" : "/vendor/some-vendor");
        logRequest(entry(i));
      }

      assert.strictEqual(
        redis.commandCount(),
        0,
        `1000 events issued ${redis.commandCount()} commands; the old path would have issued ~2500`,
      );
      assert.strictEqual(getTelemetryHealth().commands_since_boot, 0);
    });

    it("serves reads from memory — no fan-out, cached or otherwise", async () => {
      await boot();
      pageView("/");
      logRequest(entry(1));
      await flushPending();
      redis.reset();

      for (let i = 0; i < 50; i++) {
        await getPageViews();
        await getRequestLogResult(50);
      }

      assert.strictEqual(redis.commandCount(), 0, "the SCAN/MGET fan-out must not run per caller");
    });
  });

  describe("command volume is a function of flushes, not of traffic", () => {
    it("costs the same whether the interval carried 10 events or 10,000", async () => {
      await boot();
      // Warm-up: the first flush after boot also spends its one-shot deploy-race re-read,
      // so steady state is what the two measured intervals below have to agree on.
      pageView("/");
      await flushPending();

      redis.reset();
      for (let i = 0; i < 10; i++) { pageView("/"); logRequest(entry(i)); }
      await flushPending();
      const small = redis.commandCount();

      // Second interval, three orders of magnitude more traffic.
      redis.reset();
      for (let i = 0; i < 10_000; i++) { pageView("/"); logRequest(entry(i)); }
      await flushPending();
      const large = redis.commandCount();

      assert.strictEqual(
        large,
        small,
        `1000x the traffic cost ${large} commands vs ${small} — volume must not scale with requests`,
      );
      assert.ok(small <= 4, `a flush should cost a handful of commands, got ${small}: ${redis.calls.map(c => c.cmd).join(",")}`);
    });

    it("aggregates a path's hits into one counter write, not one per hit", async () => {
      await boot();
      for (let i = 0; i < 250; i++) pageView("/");
      await flushPending();

      const sets = redis.callsFor("SET").filter(c => String(c.args[0]) === PAGE_VIEWS_KEY);
      assert.strictEqual(sets.length, 1, "one snapshot write per interval");
      assert.strictEqual(redis.commandCount("INCR"), 0, "per-event INCR is the pattern that blew the quota");

      const snapshot = storedSnapshot();
      assert.strictEqual(snapshot.days[today()]["/"], 250, "aggregation must not lose counts");
      assert.strictEqual(snapshot.days[today()].total, 250);
      assert.strictEqual(snapshot.all_time["/"], 250);
    });

    it("does not drop views recorded while the snapshot write is in flight", async () => {
      await boot();
      pageView("/");
      // Requests keep arriving during the round trip. This one is not in the batch being
      // written, so clearing the buffer after the await would lose it permanently.
      redis.onCommand = (cmd) => {
        if (cmd === "SET") { redis.onCommand = null; pageView("/"); }
      };

      await flushPending();
      await flushPending();

      assert.strictEqual(storedSnapshot().days[today()].total, 2, "a view mid-write must survive to the next batch");
    });

    it("spends nothing on a flush with nothing buffered", async () => {
      await boot();
      await flushPending();
      await flushPending();
      assert.strictEqual(redis.commandCount(), 0, "an idle server should be free");
    });

    it("stays inside the monthly budget when every interval is busy", async () => {
      await boot();
      // Cost of one fully-loaded interval: page views AND request-log entries pending.
      for (let i = 0; i < 100; i++) { pageView("/"); logRequest(entry(i)); }
      await flushPending();
      const perFlush = redis.commandCount();

      const flushesPerMonth = (30 * 24 * 60 * 60) / FLUSH_INTERVAL_SECONDS;
      const projected = perFlush * flushesPerMonth;
      const budget = getTelemetryHealth().monthly_command_budget;
      assert.ok(
        projected <= budget,
        `${perFlush} commands/flush projects to ${projected}/month, over the ${budget} budget`,
      );
    });
  });

  describe("request log batching", () => {
    it("sends one LPUSH carrying the whole interval, not one per entry", async () => {
      await boot();
      for (let i = 0; i < 60; i++) logRequest(entry(i));
      await flushPending();

      const pushes = redis.callsFor("LPUSH");
      assert.strictEqual(pushes.length, 1, `expected a single batched LPUSH, got ${pushes.length}`);
      assert.strictEqual(pushes[0].args.length - 1, 60, "all 60 entries belong in the one command");
    });

    it("keeps newest-first ordering through the batch", async () => {
      await boot();
      for (let i = 0; i < 5; i++) logRequest(entry(i));
      await flushPending();

      const stored = (redis.lists.get(REQUEST_LOG_KEY) ?? []).map(s => JSON.parse(s));
      assert.strictEqual(stored[0].params.n, 4, "the newest entry must be at index 0");
      assert.strictEqual(stored[4].params.n, 0);

      const read = await getRequestLogResult(5);
      assert.strictEqual(read.entries[0].params.n, 4, "readers see newest-first too");
    });

    it("trims lazily instead of paying a command every flush", async () => {
      await boot();
      redis.lists.set(REQUEST_LOG_KEY, Array.from({ length: REQUEST_LOG_MAX }, (_, i) => JSON.stringify(entry(i))));

      logRequest(entry(1));
      await flushPending();
      assert.strictEqual(redis.commandCount("LTRIM"), 0, "one entry over the cap is not worth a command");

      for (let i = 0; i < 250; i++) logRequest(entry(i));
      await flushPending();
      assert.strictEqual(redis.commandCount("LTRIM"), 1, "the list must still be bounded");
      assert.strictEqual((redis.lists.get(REQUEST_LOG_KEY) ?? []).length, REQUEST_LOG_MAX);
    });

    it("counts entries dropped by an overflowing interval rather than hiding them", async () => {
      await boot();
      for (let i = 0; i < REQUEST_LOG_FLUSH_MAX + 40; i++) logRequest(entry(i));

      const health = getTelemetryHealth();
      assert.strictEqual(health.pending_request_log_entries, REQUEST_LOG_FLUSH_MAX);
      assert.strictEqual(health.request_log_dropped, 40, "a silent cap reads as full coverage when it is not");
    });

    it("keeps the batch for a retry when the push fails", async () => {
      await boot();
      for (let i = 0; i < 10; i++) logRequest(entry(i));
      redis.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000";
      await flushPending();
      assert.strictEqual(getTelemetryHealth().pending_request_log_entries, 10, "a failed flush must not eat the batch");

      redis.failWith = null;
      await flushPending();
      assert.strictEqual((redis.lists.get(REQUEST_LOG_KEY) ?? []).length, 10, "the retry delivers them");
    });
  });

  describe("flush on shutdown and across restarts", () => {
    it("persists buffered counters when the shutdown flush runs", async () => {
      await boot();
      pageView("/");
      pageView("/estimate");
      logRequest(entry(1));

      // What serve.ts does on SIGTERM.
      await flushPending();

      assert.strictEqual(storedSnapshot().days[today()].total, 2);
      assert.strictEqual((redis.lists.get(REQUEST_LOG_KEY) ?? []).length, 1);
    });

    it("loses at most the un-flushed interval on an unclean restart, never the history", async () => {
      await boot();
      for (let i = 0; i < 30; i++) pageView("/");
      await flushPending();
      for (let i = 0; i < 7; i++) pageView("/"); // buffered, never flushed

      // Unclean exit: the process dies with deltas still in memory.
      resetTelemetryBuffers();
      await loadTelemetry(telemetryFile);

      const report = await getPageViews();
      assert.strictEqual(report.available, true);
      assert.strictEqual(report.today.total, 30, "the flushed history survives; only the open interval is lost");
      assert.strictEqual(report.all_time.total, 30);
    });

    it("does not overwrite stored history when the boot read fails", async () => {
      await boot();
      for (let i = 0; i < 40; i++) pageView("/");
      await flushPending();
      const before = redis.values.get(PAGE_VIEWS_KEY);

      // Restart into an outage.
      resetTelemetryBuffers();
      redis.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000";
      await loadTelemetry(telemetryFile);
      for (let i = 0; i < 5; i++) pageView("/");
      await flushPending();

      assert.strictEqual(redis.values.get(PAGE_VIEWS_KEY), before, "history must be untouched while unread");
      const blind = await getPageViews();
      assert.strictEqual(blind.available, false, "and we must say so rather than report 5");

      // Storage recovers: the base is re-read and the buffered deltas land on top of it.
      redis.failWith = null;
      await flushPending();
      const report = await getPageViews();
      assert.strictEqual(report.available, true);
      assert.strictEqual(report.today.total, 45, "40 stored + 5 buffered through the outage");
    });

    it("refuses to persist when only the read failed and writes still work", async () => {
      // The dangerous shape: a transient read error leaves us with an empty in-memory
      // view while SET keeps succeeding, so a blind flush would replace real history with
      // whatever this process has seen since boot.
      await boot();
      for (let i = 0; i < 40; i++) pageView("/");
      await flushPending();
      const stored = redis.values.get(PAGE_VIEWS_KEY);

      resetTelemetryBuffers();
      redis.failWith = "ERR connection reset";
      redis.failOnly = new Set(["GET"]);
      await loadTelemetry(telemetryFile);
      for (let i = 0; i < 5; i++) pageView("/");
      await flushPending();

      assert.strictEqual(redis.values.get(PAGE_VIEWS_KEY), stored, "5 must never be written over 40");
    });

    it("keeps deltas pending when the snapshot write itself fails", async () => {
      await boot();
      pageView("/");
      redis.failWith = "ERR max requests limit exceeded";
      await flushPending();
      assert.ok(getTelemetryHealth().pending_page_view_keys > 0, "a failed SET must not clear the buffer");

      redis.failWith = null;
      await flushPending();
      assert.strictEqual(storedSnapshot().days[today()].total, 1);
    });
  });

  describe("migration off the legacy per-key layout", () => {
    it("carries the all-time history into the snapshot", async () => {
      redis.values.set("pv:all:/", "8000");
      redis.values.set("pv:all:/vendor/:slug", "2675");
      redis.values.set(`pv:${today()}:/`, "70");
      redis.values.set(`pv:${today()}:total`, "89");
      redis.values.set(`ref:${today()}:news.ycombinator.com`, "12");

      await loadTelemetry(telemetryFile);
      const report = await getPageViews();

      assert.strictEqual(report.all_time.total, 10_675, "the published all-time numbers");
      assert.strictEqual(report.today.total, 89);
      assert.strictEqual(report.referrers_today["news.ycombinator.com"], 12);
    });

    it("runs once — a later boot reads the snapshot and leaves the legacy keys alone", async () => {
      redis.values.set("pv:all:/", "500");
      await loadTelemetry(telemetryFile);
      pageView("/");
      await flushPending();

      resetTelemetryBuffers();
      redis.reset();
      await loadTelemetry(telemetryFile);

      assert.strictEqual(redis.commandCount("SCAN"), 0, "the legacy key space must not be re-scanned every boot");
      assert.strictEqual((await getPageViews()).all_time.total, 501);
    });
  });

  describe("the key space cannot be grown by traffic", () => {
    it("folds a referrer flood into one bucket", async () => {
      await boot();
      for (let i = 0; i < 400; i++) pageView("/", `https://spam-${i}.example.com/x`);
      await flushPending();

      const referrers = storedSnapshot().referrers[today()];
      const keys = Object.keys(referrers);
      assert.ok(keys.length <= 101, `referrer key space grew to ${keys.length} under a flood`);
      assert.ok(referrers[OTHER_REFERRER_KEY] > 0, "the overflow has to go somewhere countable");
      assert.strictEqual(
        Object.values(referrers).reduce((a: number, b) => a + (b as number), 0),
        400,
        "folding must not lose hits",
      );
    });

    it("folds overflowing all-time paths into __unmatched__ without losing the total", async () => {
      for (let i = 0; i < 400; i++) redis.values.set(`pv:all:/page-${i}`, "3");
      await loadTelemetry(telemetryFile);

      const report = await getPageViews();
      assert.strictEqual(report.all_time.total, 1200, "the total is preserved exactly");
      const snapshot = (await getPageViews()).all_time.top_pages;
      assert.ok(snapshot.length <= 20);
      // 400 paths capped to 300 named + one fold bucket.
      pageView("/");
      await flushPending();
      const keys = Object.keys(storedSnapshot().all_time);
      assert.ok(keys.length <= 302, `all-time key space grew to ${keys.length}`);
      assert.ok(keys.includes(UNMATCHED_PAGE_KEY));
    });

    it("prunes day buckets to the retention window", async () => {
      const stored = { days: {} as Record<string, Record<string, number>>, referrers: {}, all_time: {}, updated_at: "" };
      for (let i = 0; i < 20; i++) {
        const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        stored.days[date] = { total: 1, "/": 1 };
      }
      redis.values.set(PAGE_VIEWS_KEY, JSON.stringify(stored));

      await loadTelemetry(telemetryFile);
      pageView("/");
      await flushPending();

      assert.ok(Object.keys(storedSnapshot().days).length <= 7, "retention is enforced without a TTL command");
    });
  });

  describe("budget instrumentation", () => {
    it("reports what has been spent and what it projects to", async () => {
      await boot();
      pageView("/");
      logRequest(entry(1));
      await flushPending();

      const health = getTelemetryHealth();
      assert.strictEqual(health.commands_since_boot, redis.commandCount(), "the count must match reality");
      assert.ok(health.commands_since_boot > 0);
      assert.strictEqual(health.estimated_commands_per_month, health.estimated_commands_per_day * 30);
      assert.strictEqual(health.over_budget, health.estimated_commands_per_month > health.monthly_command_budget);
      assert.strictEqual(health.flush_interval_seconds, FLUSH_INTERVAL_SECONDS);
      assert.ok(health.last_flush_at, "a completed flush should be visible");
    });

    it("names a spent quota rather than lumping it in with other write errors", async () => {
      await boot();
      pageView("/");
      redis.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000";
      await flushPending();
      assert.strictEqual(getTelemetryHealth().quota_exhausted, true);

      resetTelemetryHealth();
      redis.failWith = "WRONGTYPE Operation against a key holding the wrong kind of value";
      await flushPending();
      const health = getTelemetryHealth();
      assert.ok(health.write_failures > 0, "still a failure");
      assert.strictEqual(health.quota_exhausted, false, "but not a billing problem");
    });
  });
});
