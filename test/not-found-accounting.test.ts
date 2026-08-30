import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const {
  recordTraffic: recordTrafficRaw,
  recordPageView,
  recordSearchQuery,
  getSearchAnalytics,
  getTrafficReport,
  getPageViews,
  getStats,
  resetTelemetryHealth,
  getTelemetryHealth,
  resetTelemetryBuffers,
  resetCounters,
  loadTelemetry,
  flushPending,
  requestOutcome,
  sanitizeSamplePath,
  normalizePagePath,
  UNMATCHED_PAGE_KEY,
  OVERFLOW_PAGE_KEY,
  NOT_FOUND_KEY,
  REDIRECT_KEY,
} = await import("../dist/stats.js");
const { classifyRequest } = await import("../dist/client-class.js");

function recordTraffic(path: string, ua: string | undefined, status?: number): void {
  recordTrafficRaw(classifyRequest(path, ua), path, status);
}

const PAGE_VIEWS_KEY = "agentdeals:pageviews";

const UA = {
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  curl: "curl/8.5.0",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  chatgpt: "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
};

type Call = { cmd: string; args: unknown[] };

class FakeUpstash {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();
  calls: Call[] = [];
  failWith: string | null = null;

  reset(): void {
    this.calls = [];
    this.failWith = null;
  }
  commandCount(cmd?: string): number {
    return cmd ? this.calls.filter(c => c.cmd === cmd).length : this.calls.length;
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
      case "MGET":
        return { result: args.map(k => this.values.get(String(k)) ?? null) };
      case "SCAN": {
        const pattern = String(args[2]);
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        return { result: ["0", [...this.values.keys()].filter(k => k.startsWith(prefix))] };
      }
      case "LPUSH": {
        const key = String(args[0]);
        const list = this.lists.get(key) ?? [];
        for (const v of args.slice(1)) list.unshift(String(v));
        this.lists.set(key, list);
        return { result: list.length };
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
    const body = redis.failWith ? { error: redis.failWith } : redis.exec(cmd, args);
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

async function boot(): Promise<void> {
  await loadTelemetry(telemetryFile);
  redis.reset();
  resetTelemetryHealth();
}

function storedSnapshot(): any {
  const raw = redis.values.get(PAGE_VIEWS_KEY);
  assert.ok(raw, "expected a persisted snapshot");
  return JSON.parse(raw!);
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

describe("404s are not page views (#1029)", () => {
  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    redis = new FakeUpstash();
    telemetryFile = join(tmpdir(), `not-found-${randomUUID()}.json`);
    resetCounters();
    resetTelemetryBuffers();
    resetTelemetryHealth();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  describe("outcome classification", () => {
    it("splits 2xx from 3xx from 4xx/5xx", () => {
      assert.equal(requestOutcome(200), "served");
      assert.equal(requestOutcome(204), "served");
      assert.equal(requestOutcome(299), "served");
      assert.equal(requestOutcome(301), "redirect");
      assert.equal(requestOutcome(302), "redirect");
      assert.equal(requestOutcome(304), "redirect");
      assert.equal(requestOutcome(404), "not_found");
      assert.equal(requestOutcome(410), "not_found");
      assert.equal(requestOutcome(500), "not_found");
      assert.equal(requestOutcome(undefined), "served");
    });
  });

  describe("the excluded traffic is out of every total we would quote", () => {
    it("reproduces the reported shape: a scan burst leaves the headline figures alone", async () => {
      await boot();
      for (let i = 0; i < 100; i++) {
        recordPageView(`/wp-admin-${i}`, UA.chrome, undefined, 404);
        recordTraffic(`/wp-admin-${i}`, UA.curl, 404);
      }
      for (let i = 0; i < 12; i++) {
        recordPageView("/vendor/neon", UA.chrome, undefined, 200);
        recordTraffic("/vendor/neon", UA.chrome, 200);
      }
      await flushPending();

      const pv = await getPageViews();
      assert.equal(pv.today.total, 12, "the page-view headline counts pages we served");
      assert.equal(pv.today.not_found, 100, "and the scan volume is still visible");
      assert.equal(pv.all_time.total, 12);
      assert.equal(pv.all_time.not_found, 100);

      const traffic = getTrafficReport().today;
      assert.equal(traffic.hits_total, 12);
      assert.equal(traffic.hits_excluding_internal, 12);
      assert.equal(traffic.not_found_total, 100);
      assert.equal(traffic.by_class.sdk_client, 0, "a client that only 404s read nothing");
      assert.equal(traffic.not_found_by_class.sdk_client, 100);
      assert.equal(traffic.web_vs_mcp ?? undefined, undefined);
    });

    it("keeps web_vs_mcp clean, since that is the number we publish", async () => {
      await boot();
      for (let i = 0; i < 50; i++) recordTraffic(`/probe-${i}`, UA.curl, 404);
      recordTraffic("/vendor/neon", UA.chatgpt, 200);

      const web = getTrafficReport().web_vs_mcp.today;
      assert.equal(web.web_hits, 1, "50 failed probes are not 50 web hits");
      assert.equal(web.ai_agent_hits, 1);
    });

    it("does not let a 404 reach the in-memory page-view counter either", async () => {
      await boot();
      recordPageView("/nope", UA.chrome, undefined, 404);
      recordPageView("/", UA.chrome, undefined, 200);
      assert.equal(getStats().page_views_today, 1);
    });

    it("counts a redirect apart from both, so it is neither a view nor a failure", async () => {
      await boot();
      recordPageView("/compare/b-vs-a", UA.chrome, undefined, 301);
      recordTraffic("/compare/b-vs-a", UA.chrome, 301);
      recordPageView("/compare/a-vs-b", UA.chrome, undefined, 200);
      recordTraffic("/compare/a-vs-b", UA.chrome, 200);
      await flushPending();

      const pv = await getPageViews();
      assert.equal(pv.today.total, 1, "the 301 and the request that follows it are one view");
      assert.equal(pv.today.redirects, 1);
      assert.equal(pv.today.not_found, 0);

      const traffic = getTrafficReport().today;
      assert.equal(traffic.hits_total, 1);
      assert.equal(traffic.redirect_total, 1);
      assert.equal(traffic.not_found_total, 0);
      assert.equal(traffic.redirects_by_class.browser, 1);
      assert.equal(storedSnapshot().days[today()][REDIRECT_KEY], 1);
      const routes = (traffic.top_routes_by_class.browser ?? []).map((r: any) => r.route);
      assert.deepEqual(routes, ["/compare/:slug"], `a redirect leaked into the route list: ${routes}`);
      assert.equal(
        (storedSnapshot().class_routes[today()] ?? {})["browser|/compare/:slug"],
        1,
        "exactly one route hit, from the 200 — not two",
      );
    });

    it("earns no referrer credit for a page it did not serve", async () => {
      await boot();
      recordPageView("/gone", UA.chrome, "https://news.ycombinator.com/item?id=1", 404);
      await flushPending();
      const pv = await getPageViews();
      assert.deepEqual(pv.referrers_today, {}, "a 404 is not a referral to a page");
    });
  });

  describe("the excluded traffic stays attributable", () => {
    it("remembers the last 50 non-resolving requests with class, status and path", async () => {
      await boot();
      recordTraffic("/wp-login.php", UA.curl, 404);
      recordTraffic("/vendor/neon", UA.chrome, 200);
      recordTraffic("/vendors/neon", UA.chrome, 301);
      recordTraffic("/broken", UA.googlebot, 500);

      const sample = getTrafficReport().not_found_sample;
      assert.equal(sample.length, 2, "only non-resolving requests are sampled");
      assert.ok(!sample.some((s: any) => s.path === "/vendor/neon"), "a served page is not sampled");
      assert.ok(!sample.some((s: any) => s.path === "/vendors/neon"), "a redirect is not sampled");
      assert.equal(sample[0].path, "/broken");
      assert.equal(sample[0].status, 500);
      assert.equal(sample[0].client_class, "search_crawler");
      assert.equal(sample[1].path, "/wp-login.php");
      assert.equal(sample[1].client_class, "sdk_client");
      assert.ok(Date.parse(sample[0].ts) > 0, "each sample is timestamped");
    });

    it("bounds the sample so a sustained scan cannot grow the snapshot", async () => {
      await boot();
      for (let i = 0; i < 5000; i++) recordTraffic(`/scan-${i}`, UA.curl, 404);
      await flushPending();

      assert.equal(storedSnapshot().not_found_sample.length, 50, "the ring is capped");
      const sample = getTrafficReport().not_found_sample;
      assert.equal(sample.length, 50);
      assert.equal(sample[0].path, "/scan-4999", "and it keeps the newest, not the oldest");
    });

    it("bounds it in memory too, between flushes", async () => {
      await boot();
      for (let i = 0; i < 5000; i++) recordTraffic(`/scan-${i}`, UA.curl, 404);
      const pending = getTelemetryHealth().pending_page_view_keys;
      assert.ok(pending <= 60, `pending page-view work grew to ${pending} for 5,000 scanned paths`);
    });

    it("stays capped on the read path, where nothing has been pruned", async () => {
      await boot();
      for (let i = 0; i < 40; i++) recordTraffic(`/stored-${i}`, UA.curl, 404);
      await flushPending();
      for (let i = 0; i < 40; i++) recordTraffic(`/buffered-${i}`, UA.curl, 404);

      const sample = getTrafficReport().not_found_sample;
      assert.equal(sample.length, 50, "the read path must not exceed the documented cap");
      assert.equal(sample[0].path, "/buffered-39", "and it is the newest 50");
    });

    it("stays capped across flushes, not just within one", async () => {
      await boot();
      for (let i = 0; i < 40; i++) recordTraffic(`/first-${i}`, UA.curl, 404);
      await flushPending();
      for (let i = 0; i < 40; i++) recordTraffic(`/second-${i}`, UA.curl, 404);
      await flushPending();

      const stored = storedSnapshot().not_found_sample;
      assert.equal(stored.length, 50, "two 40-entry batches must not persist as 80");
      assert.equal(stored[stored.length - 1].path, "/second-39", "the newest survives");
      assert.ok(
        !stored.some((s: any) => s.path === "/first-0"),
        "and the oldest is the one dropped",
      );
    });

    it("counts non-resolving and redirected requests apart since boot", async () => {
      await boot();
      recordTraffic("/gone", UA.curl, 404);
      recordTraffic("/gone-too", UA.curl, 410);
      recordTraffic("/moved", UA.chrome, 301);
      recordTraffic("/vendor/neon", UA.chatgpt, 200);

      const report = getTrafficReport();
      assert.equal(report.since_boot_not_found, 2);
      assert.equal(report.since_boot_redirects, 1);
      assert.equal(report.since_boot_by_class.ai_agent, 1);
      assert.equal(report.since_boot_by_class.sdk_client, 0, "since_boot_by_class is served-only too");
    });

    it("sanitizes and truncates the path, and never uses it as a key", async () => {
      await boot();
      const hostile = `/$(pwd)/<script>alert('x')</script>/${"a".repeat(200)}`;
      recordTraffic(hostile, UA.curl, 404);
      await flushPending();

      const snapshot = storedSnapshot();
      const sample = snapshot.not_found_sample[0];
      assert.ok(sample.path.length <= 83, `path not truncated: ${sample.path.length}`);
      assert.ok(!/[<>"'`&\\]/.test(sample.path), `unescaped markup survived: ${sample.path}`);
      for (const map of [snapshot.days[today()] ?? {}, snapshot.all_time, snapshot.class_routes[today()] ?? {}]) {
        for (const key of Object.keys(map)) {
          assert.ok(!key.includes("script"), `sample path leaked into a key: ${key}`);
          assert.ok(!key.includes("pwd"), `sample path leaked into a key: ${key}`);
        }
      }
    });

    it("reports and rewrites an oversized stored sample at the cap", async () => {
      await boot();
      recordTraffic("/probe", UA.curl, 404);
      await flushPending();

      const raw = JSON.parse(redis.values.get(PAGE_VIEWS_KEY)!);
      raw.not_found_sample = Array.from({ length: 500 }, (_, i) => ({
        ts: new Date().toISOString(),
        client_class: "sdk_client",
        status: 404,
        path: `/stale-${i}`,
      }));
      redis.values.set(PAGE_VIEWS_KEY, JSON.stringify(raw));
      resetTelemetryBuffers();
      await boot();

      assert.equal(getTrafficReport().not_found_sample.length, 50, "a reader sees the cap");
      recordTraffic("/probe-2", UA.curl, 404);
      await flushPending();
      assert.equal(storedSnapshot().not_found_sample.length, 50, "and the oversized blob does not persist");
    });

    it("survives a round trip through storage with the path re-sanitized", async () => {
      await boot();
      recordTraffic("/probe", UA.curl, 404);
      await flushPending();

      const raw = JSON.parse(redis.values.get(PAGE_VIEWS_KEY)!);
      raw.not_found_sample.push({ ts: "x", client_class: "browser", status: 404, path: "/<img onerror=1>" });
      redis.values.set(PAGE_VIEWS_KEY, JSON.stringify(raw));
      resetTelemetryBuffers();
      await boot();

      const sample = getTrafficReport().not_found_sample;
      assert.ok(!sample.some((s: any) => /[<>]/.test(s.path)), "markup must not survive a reload");
    });

    it("aggregates by client class so the shape is visible without the sample", async () => {
      await boot();
      for (let i = 0; i < 30; i++) recordTraffic(`/scan-${i}`, UA.curl, 404);
      for (let i = 0; i < 3; i++) recordTraffic(`/typo-${i}`, UA.chrome, 404);
      recordTraffic("/gone", UA.googlebot, 404);

      const window = getTrafficReport().today;
      assert.equal(window.not_found_by_class.sdk_client, 30);
      assert.equal(window.not_found_by_class.browser, 3);
      assert.equal(window.not_found_by_class.search_crawler, 1);
      assert.equal(window.not_found_total, 34);
      assert.equal(window.not_found_by_class.ai_agent, 0);
    });
  });

  describe("it costs nothing (#1023's budget still binds)", () => {
    it("spends zero commands on the request path, whatever the scan volume", async () => {
      await boot();
      for (let i = 0; i < 2000; i++) {
        recordTraffic(`/scan-${i}`, UA.curl, 404);
        recordPageView(`/scan-${i}`, UA.chrome, undefined, 404);
      }
      assert.equal(redis.commandCount(), 0, `2000 scanned paths issued ${redis.commandCount()} commands`);
    });

    it("adds no command to a flush: the counters and the sample ride in the same SET", async () => {
      await boot();
      recordPageView("/", UA.chrome, undefined, 200);
      await flushPending();
      redis.reset();

      for (let i = 0; i < 500; i++) recordTraffic(`/scan-${i}`, UA.curl, 404);
      await flushPending();
      assert.equal(redis.commandCount("SET"), 1, "one snapshot write, as before #1029");
      assert.equal(redis.commandCount("SCAN"), 0);
      assert.equal(redis.commandCount("MGET"), 0);
      assert.equal(redis.commandCount("INCR"), 0);
    });

    it("serves the sample and the counters from memory — reads stay free", async () => {
      await boot();
      recordTraffic("/scan", UA.curl, 404);
      await flushPending();
      redis.reset();
      for (let i = 0; i < 25; i++) {
        getTrafficReport();
        await getPageViews();
      }
      assert.equal(redis.commandCount(), 0);
    });
  });

  describe("the pre-#1021 junk key space", () => {
    const JUNK = [
      "/%2f%2eenv",
      "/%2eenv",
      "/%2fbackend%2f%2eenv",
      "/%2egit/%63onfig",
      "/%2f%2eaws%2fcredentials",
      "/$(pwd)/.env",
      "/$(pwd)/.git/config",
    ];

    it("moves keys that are not routes we serve into the not-found bucket", async () => {
      for (const key of JUNK) redis.values.set(`pv:all:${key}`, "9");
      redis.values.set("pv:all:/", "500");
      redis.values.set("pv:all:/vendor/:slug", "300");
      await loadTelemetry(telemetryFile);

      const pv = await getPageViews();
      assert.equal(pv.all_time.total, 800, "only routes we serve are page views");
      assert.equal(pv.all_time.not_found, JUNK.length * 9, "and the scan volume is preserved, not deleted");
      const paths = pv.all_time.top_pages.map((p: any) => p.path);
      for (const key of JUNK) assert.ok(!paths.includes(key), `${key} still served in top_pages`);
      assert.ok(paths.includes("/") && paths.includes("/vendor/:slug"));
    });

    it("is idempotent, and does not re-import the junk on a later boot", async () => {
      for (const key of JUNK) redis.values.set(`pv:all:${key}`, "9");
      redis.values.set("pv:all:/", "500");
      await loadTelemetry(telemetryFile);
      recordPageView("/", UA.chrome, undefined, 200);
      await flushPending();

      const first = (await getPageViews()).all_time;
      resetTelemetryBuffers();
      await loadTelemetry(telemetryFile);
      const second = (await getPageViews()).all_time;

      assert.equal(second.total, first.total, "a second pass must not move anything again");
      assert.equal(second.not_found, first.not_found);
      assert.ok(!JSON.stringify(storedSnapshot().all_time).includes("pwd"));
    });

    it("holds the pseudo-keys out of the path cap so they cannot be folded away", async () => {
      for (let i = 0; i < 400; i++) redis.values.set(`pv:all:/%2e${i}%2fenv`, "2");
      await loadTelemetry(telemetryFile);

      const pv = await getPageViews();
      assert.equal(pv.all_time.total, 0, "none of these was ever a page we served");
      assert.equal(pv.all_time.not_found, 800, "and every hit is accounted for");
    });

    it("keeps the excluded counters out of the path cap, so a full key space cannot re-absorb them", async () => {
      for (let i = 0; i < 320; i++) redis.values.set(`pv:all:/page-${i}`, "1");
      await boot();
      for (let i = 0; i < 25; i++) recordPageView(`/scan-${i}`, UA.chrome, undefined, 404);
      recordPageView("/moved", UA.chrome, undefined, 301);
      recordPageView("/", UA.chrome, undefined, 200);
      await flushPending();

      const all = (await getPageViews()).all_time;
      assert.equal(all.not_found, 25, "not-found must not be folded into a page bucket");
      assert.equal(all.redirects, 1);
      const stored = storedSnapshot().all_time;
      assert.equal(stored[NOT_FOUND_KEY], 25, "and it is stored under its own key, not the overflow one");
      assert.ok(!all.top_pages.some((p: any) => p.path === NOT_FOUND_KEY));
    });

    it("does the same for a day map, whose cap is reached first on a busy day", async () => {
      await boot();
      for (let i = 0; i < 320; i++) recordPageView(`/page-${i}`, UA.chrome, undefined, 200);
      for (let i = 0; i < 25; i++) recordPageView(`/scan-${i}`, UA.chrome, undefined, 404);
      recordPageView("/moved", UA.chrome, undefined, 301);
      await flushPending();

      const day = storedSnapshot().days[today()];
      assert.equal(day[NOT_FOUND_KEY], 25, "the day's not-found counter must not be folded away");
      assert.equal(day[REDIRECT_KEY], 1);
      assert.equal(day.total, 320, "and the total is still the served pages only");

      const pv = (await getPageViews()).today;
      assert.equal(pv.total, 320);
      assert.equal(pv.not_found, 25);
      assert.equal(pv.redirects, 1);
    });

    it("names the boundary it cannot repair rather than claiming the series is clean", async () => {
      redis.values.set("pv:all:/", "500");
      await loadTelemetry(telemetryFile);
      const pv = await getPageViews();
      assert.equal(pv.all_time_trustworthy_from, today());
      assert.ok(pv.notes.some((n: string) => n.includes("all_time_trustworthy_from")));
    });

    it("keeps the stamped date across a restart rather than resetting it to today", async () => {
      redis.values.set("pv:all:/", "500");
      await loadTelemetry(telemetryFile);
      recordPageView("/", UA.chrome, undefined, 200);
      await flushPending();

      const raw = JSON.parse(redis.values.get(PAGE_VIEWS_KEY)!);
      raw.all_time_trustworthy_from = "2026-01-01";
      redis.values.set(PAGE_VIEWS_KEY, JSON.stringify(raw));
      resetTelemetryBuffers();
      await loadTelemetry(telemetryFile);

      assert.equal((await getPageViews()).all_time_trustworthy_from, "2026-01-01");
    });

    it("reports what the old counter could not name instead of dropping it", async () => {
      redis.values.set(`pv:${today()}:/`, "573");
      redis.values.set(`pv:${today()}:total`, "3580");
      redis.values.set(`pv:${today()}:${UNMATCHED_PAGE_KEY}`, "3007");
      await loadTelemetry(telemetryFile);

      const pv = (await getPageViews()).today;
      assert.equal(pv.total, 573, "the figure measured by hand from the stored page keys");
      assert.equal(pv.unclassified_legacy, 3007);
      assert.equal(pv.total + pv.unclassified_legacy, 3580, "and the arithmetic closes");
      assert.ok(!pv.top_pages.some((p: any) => p.path === UNMATCHED_PAGE_KEY));
    });
  });

  describe("nothing writes the legacy bucket any more", () => {
    it("sends a served page we cannot name to the overflow bucket, not __unmatched__", async () => {
      await boot();
      const odd = "/Weird_Path!!";
      assert.equal(normalizePagePath(odd), UNMATCHED_PAGE_KEY, "precondition: it does not normalize");
      recordPageView(odd, UA.chrome, undefined, 200);
      await flushPending();

      const day = storedSnapshot().days[today()];
      assert.equal(day[OVERFLOW_PAGE_KEY], 1, "a page we served belongs in the total");
      assert.equal(day[UNMATCHED_PAGE_KEY], undefined);
      assert.equal((await getPageViews()).today.total, 1);
    });

    it("never writes __unmatched__ across a mixed traffic day", async () => {
      await boot();
      recordPageView("/", UA.chrome, undefined, 200);
      recordPageView("/gone", UA.chrome, undefined, 404);
      recordPageView("/moved", UA.chrome, undefined, 301);
      recordTraffic("/vendor/neon", UA.chatgpt, 200);
      recordTraffic("/gone", UA.curl, 404);
      await flushPending();

      const snapshot = storedSnapshot();
      const written = JSON.stringify({
        days: snapshot.days,
        all_time: snapshot.all_time,
        class_routes: snapshot.class_routes,
      });
      assert.ok(!written.includes(UNMATCHED_PAGE_KEY), `${UNMATCHED_PAGE_KEY} was written: ${written}`);
    });
  });

  describe("every window states its own denominator", () => {
    it("says how much of the window is actually backed by data", async () => {
      await boot();
      recordTraffic("/vendor/neon", UA.chatgpt, 200);
      const report = getTrafficReport();

      assert.equal(report.today.data_days_available, 1);
      assert.equal(report.today.coverage.split(";")[0], "complete");
      assert.equal(report.last_30d.days, 30);
      assert.equal(report.last_30d.data_days_available, 1);
      assert.ok(
        report.last_30d.coverage.startsWith("partial — 1 of 30 days"),
        `coverage did not warn: ${report.last_30d.coverage}`,
      );
      assert.ok(
        report.last_30d.coverage.split(";")[0].includes(today()),
        `coverage clause does not name the earliest record: ${report.last_30d.coverage}`,
      );
    });

    it("reports complete once the window is genuinely covered", async () => {
      for (let i = 0; i < 10; i++) {
        redis.values.set(`pv:${daysAgo(i)}:/`, "1");
      }
      redis.values.set(
        PAGE_VIEWS_KEY,
        JSON.stringify({
          days: {},
          referrers: {},
          all_time: {},
          updated_at: new Date().toISOString(),
          classes: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [daysAgo(i), { browser: 5 }]),
          ),
          class_routes: {},
          families: {},
          mcp: {},
        }),
      );
      await boot();

      const report = getTrafficReport();
      assert.equal(report.today.coverage.split(";")[0], "complete");
      assert.equal(report.last_7d.data_days_available, 7);
      assert.equal(report.last_7d.coverage.split(";")[0], "complete");
      assert.equal(report.last_30d.data_days_available, 10);
      assert.ok(report.last_30d.coverage.startsWith("partial — 10 of 30 days"));
    });

    it("discloses days whose class totals predate the outcome split", async () => {
      await boot();
      recordTraffic("/vendor/neon", UA.chatgpt, 200);
      const report = getTrafficReport();

      assert.deepEqual(report.today.pre_split_dates, [today()]);
      assert.ok(report.today.coverage.includes("before the outcome split"));
      assert.ok(report.notes.some((n: string) => n.includes("not_found_*")));
    });

    it("stops disclosing once every day in the window post-dates the split", async () => {
      redis.values.set(
        PAGE_VIEWS_KEY,
        JSON.stringify({
          days: {},
          referrers: {},
          all_time: {},
          updated_at: new Date().toISOString(),
          classes: { [today()]: { browser: 5 } },
          class_routes: {},
          families: {},
          mcp: {},
          outcome_split_from: daysAgo(3),
        }),
      );
      await boot();

      const window = getTrafficReport().today;
      assert.deepEqual(window.pre_split_dates, []);
      assert.ok(!window.coverage.includes("before the outcome split"));
    });

    it("states the denominator of the page-view figures too", async () => {
      await boot();
      const pv = await getPageViews();
      assert.ok(pv.notes.length > 0);
      assert.ok(pv.notes.some((n: string) => n.includes("2xx")), "says what is included");
      assert.ok(pv.notes.some((n: string) => n.includes("excludes bots")), "says what is excluded");
      assert.ok(pv.notes.some((n: string) => n.includes("7 days")), "says over what window");
    });
  });

  describe("the search-analytics window says how thin it is", () => {
    it("reports a 7-day list backed by an hour of data as partial", () => {
      resetCounters();
      recordSearchQuery("postgres", 3, { source: "web" });
      recordSearchQuery("redis", 0, { source: "mcp" });

      const window = getSearchAnalytics().window_7d;
      assert.equal(window.days, 7);
      assert.equal(window.entries, 2);
      assert.equal(window.data_days_available, 1);
      assert.ok(
        window.coverage.startsWith("partial — 1 of 7 days"),
        `coverage did not warn: ${window.coverage}`,
      );
      assert.equal(window.ring_saturated, false);
      assert.ok(Date.parse(window.oldest_entry) > 0);
    });

    it("reports an empty ring as zero days rather than as a covered week", () => {
      resetCounters();
      const window = getSearchAnalytics().window_7d;
      assert.equal(window.entries, 0);
      assert.equal(window.data_days_available, 0);
      assert.equal(window.oldest_entry, null);
      assert.ok(window.coverage.startsWith("partial — 0 of 7 days"));
    });
  });

  describe("sanitizeSamplePath", () => {
    it("strips what could break out of a rendering context", () => {
      assert.equal(sanitizeSamplePath("/<script>x</script>"), "/scriptx/script");
      assert.equal(sanitizeSamplePath("/a bc"), "/abc");
      assert.equal(sanitizeSamplePath("/café"), "/caf");
      assert.equal(sanitizeSamplePath("/back\\slash"), "/backslash");
    });

    it("truncates rather than storing whatever length the request line had", () => {
      const out = sanitizeSamplePath(`/${"a".repeat(500)}`);
      assert.ok(out.length <= 83, `length ${out.length}`);
      assert.ok(out.endsWith("..."), "and says that it truncated");
    });

    it("survives a non-string, because the blob is stored data", () => {
      assert.equal(sanitizeSamplePath(undefined), "");
      assert.equal(sanitizeSamplePath(null), "");
      assert.equal(sanitizeSamplePath(42), "42");
    });
  });
});
