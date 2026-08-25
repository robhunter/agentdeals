// Client-class traffic attribution — storage and reporting (#1019).
//
// client-class.test.ts proves the classifier is right. This proves the counters built on
// it are right: that bot traffic is *counted* rather than dropped, that the human
// page-view figure did not change meaning underneath us, that observing the service does
// not register as using it, and — the constraint #1023 left behind — that measuring all
// of this costs zero additional Redis commands.
//
// Hermetic: Upstash is replaced by an in-process fake that actually stores values.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const {
  recordTraffic: recordTrafficRaw,
  TRAFFIC_CLASSES,
  recordPageView,
  recordToolCall,
  getTrafficReport,
  getPageViews,
  resetTelemetryHealth,
  resetTelemetryBuffers,
  resetCounters,
  loadTelemetry,
  flushPending,
  normalizeRoutePath,
  UNMATCHED_PAGE_KEY,
  OVERFLOW_PAGE_KEY,
  NOT_FOUND_KEY,
} = await import("../dist/stats.js");
const { classifyRequest, CLIENT_CLASSES } = await import("../dist/client-class.js");

// The server classifies and hands the result to storage; these tests go through the same
// path so a change to either half shows up here.
function recordTraffic(path: string, ua: string | undefined, status?: number): void {
  recordTrafficRaw(classifyRequest(path, ua), path, status);
}

const PAGE_VIEWS_KEY = "agentdeals:pageviews";

const UA = {
  chatgpt: "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
  oai: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  claude: "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  ahrefs: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  curl: "curl/8.5.0",
};

type Call = { cmd: string; args: unknown[] };

class FakeUpstash {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();
  calls: Call[] = [];
  failWith: string | null = null;
  failOnly: Set<string> | null = null;

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
    const body = redis.shouldFail(cmd) ? { error: redis.failWith } : redis.exec(cmd, args);
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

describe("client-class traffic attribution (#1019)", () => {
  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    redis = new FakeUpstash();
    telemetryFile = join(tmpdir(), `traffic-${randomUUID()}.json`);
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

  it("counts the AI-agent traffic the old bot filter discarded", async () => {
    await boot();
    recordTraffic("/vendor/hetzner", UA.chatgpt, 200);
    recordTraffic("/vendor/cloudflare", UA.chatgpt, 200);
    recordTraffic("/vendor/directus", UA.oai, 200);
    recordTraffic("/vendor/brave-search-api", UA.claude, 200);

    const report = getTrafficReport();
    assert.equal(report.available, true);
    assert.equal(report.today.by_class.ai_agent, 4, "all four AI-agent hits are counted");
    assert.deepEqual(report.today.ai_agent_by_family, {
      "ChatGPT-User": 2,
      "OAI-SearchBot": 1,
      "Claude-User": 1,
    });
  });

  it("is additive — the human page-view figure does not change meaning", async () => {
    await boot();
    // One human and three bots hit the same page.
    recordPageView("/vendor/neon", UA.chrome, undefined, 200);
    recordTraffic("/vendor/neon", UA.chrome, 200);
    for (const ua of [UA.chatgpt, UA.googlebot, UA.ahrefs]) {
      recordPageView("/vendor/neon", ua, undefined, 200);
      recordTraffic("/vendor/neon", ua, 200);
    }

    const pv = await getPageViews();
    assert.equal(pv.today.total, 1, "page views stay human-only, as before #1019");

    const report = getTrafficReport();
    assert.equal(report.today.hits_total, 4, "traffic attribution sees all four");
    assert.equal(report.today.by_class.browser, 1);
    assert.equal(report.today.by_class.ai_agent, 1);
    assert.equal(report.today.by_class.search_crawler, 1);
    assert.equal(report.today.by_class.seo_crawler, 1);
  });

  it("observing the service is not using it", async () => {
    await boot();
    recordTraffic("/best/free-databases", UA.chrome, 200);
    // An operator polling our own dashboards, exactly as during #1023 verification.
    for (let i = 0; i < 20; i++) {
      recordTraffic("/api/pageviews", UA.curl, 200);
      recordTraffic("/api/traffic", UA.curl, 200);
    }

    const report = getTrafficReport();
    assert.equal(report.today.by_class.internal, 40);
    assert.equal(report.today.hits_total, 41, "internal hits are still visible");
    assert.equal(report.today.hits_excluding_internal, 1, "...but out of the quotable number");
    assert.equal(report.web_vs_mcp.today.web_hits, 1);
  });

  it("costs zero Redis commands to measure, and one SET to persist", async () => {
    await boot();
    for (let i = 0; i < 200; i++) {
      recordTraffic(`/vendor/v${i}`, i % 2 ? UA.chatgpt : UA.chrome, 200);
    }
    assert.equal(redis.commandCount(), 0, "attribution must not touch Redis on the request path");

    await flushPending();
    assert.equal(redis.commandCount("SET"), 1, "the whole interval is one snapshot write");

    // The load-bearing property from #1023: cost is O(flush intervals), not O(requests).
    const afterFirst = redis.commandCount();
    for (let i = 0; i < 5000; i++) recordTraffic("/vendor/x", UA.oai, 200);
    assert.equal(redis.commandCount(), afterFirst, "25x the traffic, still zero commands");
    await flushPending();
    assert.equal(redis.commandCount("SET"), 2, "still exactly one write for the interval");
  });

  it("web_vs_mcp compares the same window on both sides", async () => {
    await boot();
    for (let i = 0; i < 30; i++) recordTraffic("/vendor/neon", UA.chatgpt, 200);
    for (let i = 0; i < 12; i++) recordTraffic("/best/free-databases", UA.chrome, 200);
    for (let i = 0; i < 3; i++) recordToolCall("search_deals", "opencode");

    const w = getTrafficReport().web_vs_mcp.today;
    assert.equal(w.web_hits, 42);
    assert.equal(w.ai_agent_hits, 30);
    assert.equal(w.mcp_tool_calls, 3);
    assert.equal(w.web_to_mcp_ratio, 14);
    assert.equal(w.ai_agent_to_mcp_ratio, 10);
  });

  it("reports no ratio rather than a fake one when there are no tool calls", async () => {
    await boot();
    recordTraffic("/vendor/neon", UA.chatgpt, 200);
    const w = getTrafficReport().web_vs_mcp.today;
    assert.equal(w.mcp_tool_calls, 0);
    assert.equal(w.web_to_mcp_ratio, null, "dividing by zero must not produce Infinity");
    assert.equal(w.ai_agent_to_mcp_ratio, null);
  });

  it("survives a restart", async () => {
    await boot();
    recordTraffic("/vendor/neon", UA.chatgpt, 200);
    recordTraffic("/vendor/neon", UA.googlebot, 200);
    recordToolCall("search_deals", "opencode");
    await flushPending();

    const persisted = storedSnapshot();
    assert.equal(persisted.classes[today()].ai_agent, 1);
    assert.equal(persisted.mcp[today()], 1);

    // New process, same storage.
    resetTelemetryBuffers();
    resetCounters();
    await boot();
    const report = getTrafficReport();
    assert.equal(report.today.by_class.ai_agent, 1, "restored from storage");
    assert.equal(report.today.by_class.search_crawler, 1);
    assert.equal(report.web_vs_mcp.today.mcp_tool_calls, 1);
  });

  it("reads a snapshot written before this feature as empty, not as broken", async () => {
    redis.values.set(
      PAGE_VIEWS_KEY,
      JSON.stringify({ days: { [today()]: { "/": 5, total: 5 } }, referrers: {}, all_time: { "/": 5 }, updated_at: "" }),
    );
    await boot();
    const report = getTrafficReport();
    assert.equal(report.available, true);
    assert.equal(report.today.hits_total, 0, "no attribution history is zero, not a crash");
    const pv = await getPageViews();
    assert.equal(pv.today.total, 5, "the pre-existing page-view history still loads");
  });

  it("never reports an unreadable store as measured zeros", async () => {
    redis.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000";
    await loadTelemetry(telemetryFile);
    redis.reset();
    recordTraffic("/vendor/neon", UA.chatgpt, 200);

    const report = getTrafficReport();
    assert.equal(report.available, false, "a failed load is not a measurement (#1018 Defect B)");
    assert.ok(report.error, "and it says why");
    // The in-memory tally is still a real observation and stays visible.
    assert.equal(report.since_boot_by_class.ai_agent, 1);
  });

  it("bounds the route key space, and overflow never crosses a class", async () => {
    await boot();
    // Single-segment paths each mint their own route key (a slugged path would collapse
    // to one and never reach the cap), so 400 of them across two classes forces overflow.
    for (let i = 0; i < 400; i++) {
      recordTraffic(`/p${i}`, UA.chatgpt, 200);
      recordTraffic(`/q${i}`, UA.googlebot, 200);
    }
    await flushPending();

    const routes = storedSnapshot().class_routes[today()];
    const keys = Object.keys(routes);
    // The cap admits 200 ordinary keys; each class's overflow bucket is exempt from the
    // check (otherwise overflow would have nowhere to go), so the true ceiling is
    // 200 + one bucket per class. Bounded is what matters, and this is the bound.
    assert.ok(keys.length <= 208, `class_routes grew to ${keys.length} keys — cap not enforced`);
    assert.ok(
      keys.includes(`ai_agent|${OVERFLOW_PAGE_KEY}`) && keys.includes(`search_crawler|${OVERFLOW_PAGE_KEY}`),
      "overflow folds into a per-class bucket, not a shared one",
    );
    // Nothing is dropped, and nothing moves between classes on a busy day.
    const sum = (cls: string) =>
      keys.filter(k => k.startsWith(`${cls}|`)).reduce((n, k) => n + routes[k], 0);
    assert.equal(sum("ai_agent"), 400, "every ai_agent hit is still in an ai_agent bucket");
    assert.equal(sum("search_crawler"), 400);
  });

  // Contract changed by #1029: a 404 no longer mints a route key *at all*, rather than
  // minting the shared unmatched one. A client that only ever 404s is not a client that
  // read our pages, so it must not appear in that class's hit count or route list.
  it("a 404 is counted apart from served traffic and mints no route key", async () => {
    await boot();
    recordTraffic("/wp-login.php", UA.curl, 404);
    recordTraffic("/vendor/real", UA.curl, 200);
    await flushPending();

    const snapshot = storedSnapshot();
    const routes = snapshot.class_routes[today()];
    assert.equal(routes["sdk_client|/vendor/:slug"], 1);
    assert.equal(routes[`sdk_client|${UNMATCHED_PAGE_KEY}`], undefined, "no route key for a 404");
    assert.equal(routes[`sdk_client|${OVERFLOW_PAGE_KEY}`], undefined);
    assert.equal(snapshot.classes[today()].sdk_client, 1, "only the served request is a hit");
    assert.equal(snapshot.not_found[today()].sdk_client, 1, "the 404 is counted, under its own name");

    const window = getTrafficReport().today;
    assert.equal(window.hits_total, 1);
    assert.equal(window.by_class.sdk_client, 1);
    assert.equal(window.not_found_total, 1);
    assert.equal(window.not_found_by_class.sdk_client, 1);
  });

  it("counts a 3xx apart from both — the redirect and its target are one hit", async () => {
    await boot();
    recordTraffic("/vendors/neon", UA.chrome, 301);
    recordTraffic("/vendor/neon", UA.chrome, 200);
    await flushPending();

    const window = getTrafficReport().today;
    assert.equal(window.hits_total, 1, "a redirect plus the request that follows it is one hit");
    assert.equal(window.redirect_total, 1);
    assert.equal(window.not_found_total, 0, "a redirect is not a not-found");
    assert.equal(storedSnapshot().redirects[today()].browser, 1);
  });

  it("normalizeRoutePath keeps API routes bounded too", () => {
    assert.equal(normalizeRoutePath("/api/offers?q=postgres"), "/api/offers");
    assert.equal(normalizeRoutePath("/api/vendor/neon"), "/api/vendor/:slug");
    assert.equal(normalizeRoutePath("/vendor/neon"), "/vendor/:slug");
    assert.equal(normalizeRoutePath("/api/openapi.json"), "/api/openapi.json");
    assert.equal(normalizeRoutePath("/mcp"), "/mcp");
    assert.equal(normalizeRoutePath("/$(pwd)/.env"), UNMATCHED_PAGE_KEY);
    assert.equal(normalizeRoutePath(""), UNMATCHED_PAGE_KEY);
  });

  it("reports every class in the taxonomy, including the ones with no traffic", async () => {
    await boot();
    recordTraffic("/vendor/neon", UA.chatgpt, 200);
    const byClass = getTrafficReport().today.by_class;
    for (const cls of ["internal", "ai_agent", "search_crawler", "seo_crawler", "other_bot", "sdk_client", "browser", "unknown"]) {
      assert.ok(cls in byClass, `${cls} missing — an absent key reads as "unknown", not "none"`);
    }
    assert.equal(byClass.browser, 0);
  });

  it("ranks route patterns within each class", async () => {
    await boot();
    for (let i = 0; i < 9; i++) recordTraffic("/vendor/x", UA.oai, 200);
    for (let i = 0; i < 4; i++) recordTraffic("/best/y", UA.oai, 200);
    recordTraffic("/", UA.chrome, 200);

    const top = getTrafficReport().today.top_routes_by_class;
    assert.deepEqual(top.ai_agent, [
      { route: "/vendor/:slug", hits: 9 },
      { route: "/best/:slug", hits: 4 },
    ]);
    assert.deepEqual(top.browser, [{ route: "/", hits: 1 }]);
  });
});

describe("taxonomy drift", () => {
  // stats.ts deliberately does not import client-class.ts (Node's type stripping cannot
  // resolve a relative import out of a .ts file, and several tests load stats.ts from
  // source). It restates the class list instead. This is what stops the two copies
  // diverging: a class added to one and not the other would silently stop being
  // zero-filled in the report, so it would read as "unknown" rather than "none".
  it("the storage-side class list matches the classifier's", () => {
    assert.deepEqual([...TRAFFIC_CLASSES], [...CLIENT_CLASSES]);
  });
});

describe("window honesty and storage bounds", () => {
  it("says how many days actually back the detail maps", async () => {
    const report = getTrafficReport();
    assert.equal(report.today.detail_days, 1);
    assert.equal(report.last_7d.detail_days, 7);
    // The 30-day window reports 30 days of class totals but only 7 of route/family
    // detail, because that is all we retain. Presenting the shorter series as if it
    // covered the window would understate it silently.
    assert.equal(report.last_30d.days, 30);
    assert.equal(report.last_30d.detail_days, 7);
  });

  it("keeps the worst-case snapshot well inside Upstash's request limit", () => {
    // Every cap saturated on every retained day. If this ever exceeds the limit the SET
    // fails and the whole snapshot is lost — the exact failure #1018 was about — so the
    // bound is asserted rather than assumed. Raise a cap and this test tells you the cost.
    const CLASSES = [...TRAFFIC_CLASSES];
    const day = (i: number) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const snap: any = { days: {}, referrers: {}, all_time: {}, updated_at: new Date().toISOString(), classes: {}, class_routes: {}, families: {}, mcp: {} };
    for (let i = 0; i < 7; i++) {
      const d = day(i);
      snap.days[d] = { total: 999999 };
      for (let k = 0; k < 300; k++) snap.days[d][`/some-page-slug-${k}`] = 99999;
      snap.referrers[d] = {};
      for (let k = 0; k < 100; k++) snap.referrers[d][`referrer-domain-${k}.example.com`] = 99999;
      snap.class_routes[d] = {};
      for (let k = 0; k < 208; k++) snap.class_routes[d][`${CLASSES[k % CLASSES.length]}|/some-page-slug-${k}`] = 99999;
      snap.families[d] = {};
      for (let k = 0; k < 40; k++) snap.families[d][`SomeAgentFamily-${k}`] = 99999;
    }
    for (let i = 0; i < 30; i++) {
      snap.classes[day(i)] = Object.fromEntries(CLASSES.map(c => [c, 9999999]));
      snap.mcp[day(i)] = 999999;
    }
    for (let k = 0; k < 300; k++) snap.all_time[`/some-page-slug-${k}`] = 99999999;
    // #1029's additions: two class-keyed outcome maps over the same 30 days, and the
    // bounded not-found sample at its cap with the longest path each entry can hold.
    snap.not_found = {};
    snap.redirects = {};
    for (let i = 0; i < 30; i++) {
      snap.not_found[day(i)] = Object.fromEntries(CLASSES.map(c => [c, 9999999]));
      snap.redirects[day(i)] = Object.fromEntries(CLASSES.map(c => [c, 9999999]));
    }
    snap.not_found_sample = Array.from({ length: 50 }, () => ({
      ts: new Date().toISOString(),
      client_class: "search_crawler",
      status: 404,
      path: `/${"a".repeat(80)}...`,
    }));
    snap.all_time_trustworthy_from = "2026-08-25";
    snap.outcome_split_from = "2026-08-25";

    const bytes = JSON.stringify(snap).length;
    assert.ok(bytes < 400_000, `worst-case snapshot is ${(bytes / 1024).toFixed(0)}KB`);
  });
});
