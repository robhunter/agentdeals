import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  OUTBOUND_STORE_KEY,
  configureOutboundStore,
  flushOutbound,
  loadOutbound,
  outboundByVendor,
  outboundSlug,
  outboundTotals,
  recordOutboundClick,
  resetOutbound,
} = await import("../dist/outbound.js");
const { CLIENT_CLASSES } = await import("../dist/client-class.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { loadOffers } = await import("../dist/data.js");
const { offerRetired } = await import("../dist/retirement.js");
const { assertPopulationFloor } = await import("./population-floor.ts");

const EXPORT_TOKEN = "outbound-export-token-0123456789";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const AGENT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)";
const CRAWLER_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SDK_UA = "curl/8.5.0";

function memoryStore(seed: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(seed));
  const calls: { op: string; key: string }[] = [];
  let failReads = false;
  let failWrites = false;
  let holdReads: Promise<void> | null = null;
  return {
    values,
    calls,
    failReads: (on: boolean) => { failReads = on; },
    failWrites: (on: boolean) => { failWrites = on; },
    holdReadsUntil: (gate: Promise<void> | null) => { holdReads = gate; },
    store: {
      async get(key: string) {
        calls.push({ op: "get", key });
        if (holdReads) await holdReads;
        if (failReads) return { ok: false, value: null, error: "read refused" };
        return { ok: true, value: values.has(key) ? structuredClone(values.get(key)) : null };
      },
      async set(key: string, value: unknown) {
        calls.push({ op: "set", key });
        if (failWrites) return { ok: false, error: "write refused" };
        values.set(key, structuredClone(value));
        return { ok: true };
      },
    },
  };
}

function storedCounts(values: Map<string, unknown>): Record<string, Record<string, number>> {
  return (values.get(OUTBOUND_STORE_KEY) as { counts: Record<string, Record<string, number>> }).counts;
}

describe("/go/ path parsing", () => {
  const known = (slug: string) => slug === "supabase" || slug === "neon";

  it("names the vendor for a slug we publish, in any case and with a trailing slash", () => {
    assert.strictEqual(outboundSlug("/go/supabase", known), "supabase");
    assert.strictEqual(outboundSlug("/go/Supabase/", known), "supabase");
  });

  it("names no vendor for an unknown slug, an empty or nested path, or an encoded address", () => {
    for (const path of ["/go/", "/go", "/go/no-such-vendor", "/go/supabase/pricing", "/go/https:%2F%2Fexample.com", "/vendor/supabase"]) {
      assert.strictEqual(outboundSlug(path, known), null, path);
    }
  });
});

describe("outbound click counting", () => {
  beforeEach(() => resetOutbound());

  it("counts clicks per vendor and per request class", () => {
    recordOutboundClick("neon", "browser");
    recordOutboundClick("neon", "browser");
    recordOutboundClick("neon", "ai_agent");
    recordOutboundClick("render", "browser");
    assert.deepStrictEqual(outboundByVendor(), [
      { slug: "neon", total: 3, by_class: { browser: 2, ai_agent: 1 } },
      { slug: "render", total: 1, by_class: { browser: 1 } },
    ]);
  });

  it("totals every request class, including the ones with no clicks", () => {
    recordOutboundClick("neon", "browser");
    recordOutboundClick("render", "ai_agent");
    const totals = outboundTotals();
    assert.strictEqual(totals.total, 2);
    assert.deepStrictEqual(Object.keys(totals.by_class).sort(), [...CLIENT_CLASSES].sort());
    assert.strictEqual(totals.by_class.browser, 1);
    assert.strictEqual(totals.by_class.ai_agent, 1);
    assert.strictEqual(totals.by_class.search_crawler, 0);
  });

  it("names no vendor in the totals", () => {
    recordOutboundClick("neon", "browser");
    assert.doesNotMatch(JSON.stringify(outboundTotals()), /neon/);
  });
});

describe("outbound click persistence", () => {
  beforeEach(() => resetOutbound());

  it("writes the clicks under one key and reads them back into a fresh process", async () => {
    const harness = memoryStore();
    configureOutboundStore(harness.store);
    recordOutboundClick("neon", "browser");
    recordOutboundClick("neon", "ai_agent");
    assert.strictEqual(await flushOutbound(), true);
    assert.deepStrictEqual(storedCounts(harness.values), { neon: { browser: 1, ai_agent: 1 } });

    resetOutbound();
    configureOutboundStore(harness.store);
    assert.strictEqual(await loadOutbound(), true);
    assert.strictEqual(outboundTotals().total, 2);
    assert.strictEqual(outboundTotals().stored_total_read, true);
  });

  it("adds to what another process already stored", async () => {
    const harness = memoryStore({
      [OUTBOUND_STORE_KEY]: { schema: 1, counts: { neon: { browser: 5 }, fly: { sdk_client: 2 } }, first_recorded_at: "2026-10-01T00:00:00.000Z", updated_at: "" },
    });
    configureOutboundStore(harness.store);
    recordOutboundClick("neon", "browser");
    recordOutboundClick("render", "ai_agent");
    await flushOutbound();
    assert.deepStrictEqual(storedCounts(harness.values), {
      neon: { browser: 6 },
      fly: { sdk_client: 2 },
      render: { ai_agent: 1 },
    });
    assert.strictEqual(outboundTotals().recording_since, "2026-10-01T00:00:00.000Z");
  });

  it("does not add a click twice once it is written", async () => {
    const harness = memoryStore();
    configureOutboundStore(harness.store);
    recordOutboundClick("neon", "browser");
    await flushOutbound();
    await flushOutbound();
    assert.deepStrictEqual(storedCounts(harness.values), { neon: { browser: 1 } });
  });

  it("issues no storage command when there is nothing to write", async () => {
    const harness = memoryStore();
    configureOutboundStore(harness.store);
    assert.strictEqual(await flushOutbound(), false);
    assert.deepStrictEqual(harness.calls, []);
  });

  it("keeps the clicks when the write fails, and loses none on the retry", async () => {
    const harness = memoryStore();
    configureOutboundStore(harness.store);
    recordOutboundClick("neon", "browser");
    harness.failWrites(true);
    assert.strictEqual(await flushOutbound(), false);
    assert.strictEqual(outboundTotals().write_failures, 1);
    recordOutboundClick("neon", "browser");
    harness.failWrites(false);
    assert.strictEqual(await flushOutbound(), true);
    assert.deepStrictEqual(storedCounts(harness.values), { neon: { browser: 2 } });
  });

  it("keeps the clicks when the read fails", async () => {
    const harness = memoryStore();
    configureOutboundStore(harness.store);
    recordOutboundClick("neon", "browser");
    harness.failReads(true);
    assert.strictEqual(await flushOutbound(), false);
    assert.strictEqual(harness.calls.filter(c => c.op === "set").length, 0);
    harness.failReads(false);
    await flushOutbound();
    assert.deepStrictEqual(storedCounts(harness.values), { neon: { browser: 1 } });
  });

  it("counts a click made while a write is in flight in the next write", async () => {
    const harness = memoryStore();
    configureOutboundStore(harness.store);
    let release!: () => void;
    harness.holdReadsUntil(new Promise<void>(resolve => { release = resolve; }));
    recordOutboundClick("neon", "browser");
    const first = flushOutbound();
    recordOutboundClick("neon", "ai_agent");
    const second = flushOutbound();
    harness.holdReadsUntil(null);
    release();
    await Promise.all([first, second]);
    assert.deepStrictEqual(storedCounts(harness.values), { neon: { browser: 1, ai_agent: 1 } });
    assert.strictEqual(outboundTotals().pending_flush, false);
  });

  it("writes nothing and reports itself not durable when no store is configured", async () => {
    recordOutboundClick("neon", "browser");
    assert.strictEqual(await flushOutbound(), false);
    assert.strictEqual(outboundTotals().durable, false);
    assert.strictEqual(outboundTotals().total, 1);
  });
});

interface UpstashDouble {
  server: Server;
  url: string;
  keys: Map<string, string>;
  commands: { op: string; key: string }[];
}

function upstashDouble(): Promise<UpstashDouble> {
  const keys = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const commands: { op: string; key: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let cmd: (string | number)[];
      try { cmd = JSON.parse(body); } catch { cmd = []; }
      const op = String(cmd[0] ?? "").toUpperCase();
      const key = String(cmd[1] ?? "");
      commands.push({ op, key });
      let result: unknown = null;
      if (op === "SET") { keys.set(key, String(cmd[2])); result = "OK"; }
      else if (op === "GET") { result = keys.has(key) ? keys.get(key) : null; }
      else if (op === "MGET") { result = cmd.slice(1).map((k) => keys.get(String(k)) ?? null); }
      else if (op === "INCR") { const n = Number(keys.get(key) ?? "0") + 1; keys.set(key, String(n)); result = n; }
      else if (op === "INCRBY") { const n = Number(keys.get(key) ?? "0") + Number(cmd[2]); keys.set(key, String(n)); result = n; }
      else if (op === "LPUSH") { const list = lists.get(key) ?? []; for (const v of cmd.slice(2)) list.unshift(String(v)); lists.set(key, list); result = list.length; }
      else if (op === "LRANGE") { result = (lists.get(key) ?? []).slice(Number(cmd[2]), Number(cmd[3]) + 1); }
      else if (op === "LTRIM") { lists.set(key, (lists.get(key) ?? []).slice(Number(cmd[2]), Number(cmd[3]) + 1)); result = "OK"; }
      else if (op === "DEL") { keys.delete(key); lists.delete(key); result = 1; }
      else if (op === "EXPIRE") { result = 1; }
      else if (op === "SCAN") { result = ["0", [...keys.keys()]]; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as import("net").AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, keys, commands });
    });
  });
}

interface Started {
  proc: ChildProcess;
  base: string;
}

function startAgentDeals(redis: UpstashDouble | null, label: string): Promise<Started> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        UPSTASH_REDIS_REST_URL: redis ? redis.url : "",
        UPSTASH_REDIS_REST_TOKEN: redis ? "double" : "",
        ANALYTICS_EXPORT_TOKEN: EXPORT_TOKEN,
        AGENTDEALS_ROLLUP_DIR: path.join(os.tmpdir(), `outbound-rollups-${label}-${process.pid}`),
      },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${match[1]}` }); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function stop(started: Started | undefined): Promise<void> {
  if (!started || started.proc.exitCode !== null) return;
  const exited = once(started.proc, "exit");
  started.proc.kill("SIGTERM");
  await exited;
}

function request(base: string, slug: string, userAgent: string, method = "GET"): Promise<Response> {
  return fetch(`${base}/go/${slug}`, { method, redirect: "manual", headers: { "User-Agent": userAgent } });
}

async function click(base: string, slug: string, userAgent: string, method = "GET"): Promise<Response> {
  const res = await request(base, slug, userAgent, method);
  assert.strictEqual(res.status, 302, `/go/${slug} redirects`);
  return res;
}

interface MetricsOutbound {
  total: number;
  by_class: Record<string, number>;
  durable: boolean;
  stored_total_read: boolean;
  pending_flush: boolean;
}

async function metricsOutbound(base: string): Promise<MetricsOutbound> {
  const body = (await (await fetch(`${base}/api/metrics`)).json()) as { outbound_clicks: MetricsOutbound };
  return body.outbound_clicks;
}

async function vendorRows(base: string): Promise<{ slug: string; total: number; by_class: Record<string, number> }[]> {
  const res = await fetch(`${base}/api/analytics/vendors`, { headers: { Authorization: `Bearer ${EXPORT_TOKEN}` } });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { outbound: { by_vendor: { slug: string; total: number; by_class: Record<string, number> }[] } };
  return body.outbound.by_vendor;
}

function firstListing(slug: string): { url: string; tier: string } {
  const name = vendorSlugMap.get(slug);
  return loadOffers().find((o: { vendor: string }) => o.vendor === name);
}

function pricingUrlOnTheVendorPage(slug: string): string {
  return firstListing(slug).url;
}

function vendorsWhoseListing(ended: boolean): string[] {
  return [...vendorSlugMap.keys()].filter(slug => offerRetired(firstListing(slug)) === ended);
}

describe("/go/<slug> on a running server", () => {
  let redis: UpstashDouble;
  let server: Started | undefined;

  before(async () => {
    redis = await upstashDouble();
    server = await startAgentDeals(redis, "routes");
  });

  after(async () => {
    await stop(server);
    redis?.server.close();
  });

  it("redirects every vendor with a live listing to the pricing URL its vendor page links", async () => {
    const live = vendorsWhoseListing(false);
    assertPopulationFloor(live.length, 1000, "vendors with a live listing");
    const wrong: string[] = [];
    for (const slug of live) {
      const res = await request(server!.base, slug, SDK_UA, "HEAD");
      const location = res.headers.get("location");
      if (res.status !== 302 || location !== pricingUrlOnTheVendorPage(slug)) wrong.push(`${slug}: ${res.status} ${location}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("sends no reader to the URL of a listing that has ended, as its vendor page links none", async (t) => {
    const ended = vendorsWhoseListing(true);
    if (ended.length === 0) return t.skip("no vendor's first listing has ended");
    const wrong: string[] = [];
    for (const slug of ended) {
      const res = await request(server!.base, slug, SDK_UA);
      if (res.status !== 404 || res.headers.get("location") !== null) wrong.push(`${slug}: ${res.status} ${res.headers.get("location")}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("leads to the URL the vendor page's Pricing Page card shows, and the card links through /go/", async () => {
    for (const slug of ["supabase", "railway", "sentry"]) {
      const page = await (await fetch(`${server!.base}/vendor/${slug}`)).text();
      const card = page.match(/<div class="detail-label">Pricing Page<\/div>\s*<div class="detail-value"><a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      assert.ok(card, `${slug} has a Pricing Page card`);
      assert.strictEqual(card[1], `/go/${slug}`, slug);
      const location = (await click(server!.base, slug, SDK_UA, "HEAD")).headers.get("location");
      assert.strictEqual(location, card[2].replace(/&amp;/g, "&"), slug);
    }
  });

  it("answers 404 for anything that is not a vendor slug", async () => {
    for (const path of ["no-such-vendor-here", "", "supabase/pricing", "https:%2F%2Fexample.com"]) {
      const res = await request(server!.base, path, SDK_UA);
      assert.strictEqual(res.status, 404, `/go/${path}`);
      assert.strictEqual(res.headers.get("location"), null, `/go/${path}`);
    }
  });

  it("ignores any destination the caller supplies", async () => {
    const res = await fetch(`${server!.base}/go/supabase?to=https://example.com&url=https://example.com`, { redirect: "manual" });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), pricingUrlOnTheVendorPage("supabase"));
  });

  it("tells caches not to store the redirect, so each click reaches the counter", async () => {
    const res = await click(server!.base, "supabase", SDK_UA);
    assert.strictEqual(res.headers.get("cache-control"), "no-store");
  });

  it("counts each GET under its vendor and request class, and does not count HEAD", async () => {
    const before = await metricsOutbound(server!.base);
    const rowsBefore = new Map((await vendorRows(server!.base)).map(r => [r.slug, r]));
    await click(server!.base, "neon", BROWSER_UA);
    await click(server!.base, "neon", AGENT_UA);
    await click(server!.base, "neon", CRAWLER_UA);
    await click(server!.base, "render", BROWSER_UA);
    await click(server!.base, "render", BROWSER_UA, "HEAD");
    const after = await metricsOutbound(server!.base);
    assert.strictEqual(after.total - before.total, 4);
    assert.strictEqual(after.by_class.browser - before.by_class.browser, 2);
    assert.strictEqual(after.by_class.ai_agent - before.by_class.ai_agent, 1);
    assert.strictEqual(after.by_class.search_crawler - before.by_class.search_crawler, 1);

    const rows = new Map((await vendorRows(server!.base)).map(r => [r.slug, r]));
    const added = (slug: string, cls: string) => (rows.get(slug)?.by_class[cls] ?? 0) - (rowsBefore.get(slug)?.by_class[cls] ?? 0);
    assert.strictEqual(added("neon", "browser"), 1);
    assert.strictEqual(added("neon", "ai_agent"), 1);
    assert.strictEqual(added("neon", "search_crawler"), 1);
    assert.strictEqual(added("render", "browser"), 1);
  });

  it("publishes totals by class on /api/metrics and names no vendor there", async () => {
    await click(server!.base, "upstash", BROWSER_UA);
    const outbound = await metricsOutbound(server!.base);
    assert.deepStrictEqual(Object.keys(outbound.by_class).sort(), [...CLIENT_CLASSES].sort());
    assert.doesNotMatch(JSON.stringify(outbound), /upstash|neon|render/);
  });

  it("gives per-vendor counts only to a caller holding the export token", async () => {
    await click(server!.base, "upstash", BROWSER_UA);
    const anonymous = await fetch(`${server!.base}/api/analytics/vendors`);
    assert.strictEqual(anonymous.status, 404);
    assert.doesNotMatch(await anonymous.text(), /upstash/);
    const rows = await vendorRows(server!.base);
    assert.ok(rows.some(r => r.slug === "upstash" && r.by_class.browser >= 1));
  });

  it("issues no storage command for a click", async () => {
    const touching = () => redis.commands.filter(c => c.key === OUTBOUND_STORE_KEY).length;
    const before = touching();
    for (let i = 0; i < 20; i++) await click(server!.base, "neon", BROWSER_UA);
    assert.strictEqual(touching(), before);
  });
});

describe("outbound clicks across a deploy", () => {
  let redis: UpstashDouble;
  const running: Started[] = [];

  before(async () => {
    redis = await upstashDouble();
  });

  after(async () => {
    for (const started of running) await stop(started);
    redis?.server.close();
  });

  it("keeps the counts when the process is replaced", async () => {
    const first = await startAgentDeals(redis, "deploy-a");
    running.push(first);
    await click(first.base, "neon", BROWSER_UA);
    await click(first.base, "neon", AGENT_UA);
    await click(first.base, "render", BROWSER_UA);
    const beforeStop = redis.commands.filter(c => c.key === OUTBOUND_STORE_KEY && c.op === "SET").length;
    await stop(first);
    assert.strictEqual(redis.commands.filter(c => c.key === OUTBOUND_STORE_KEY && c.op === "SET").length, beforeStop + 1);

    const second = await startAgentDeals(redis, "deploy-b");
    running.push(second);
    const outbound = await metricsOutbound(second.base);
    assert.strictEqual(outbound.total, 3);
    assert.strictEqual(outbound.by_class.browser, 2);
    assert.strictEqual(outbound.by_class.ai_agent, 1);
    assert.strictEqual(outbound.durable, true);
    assert.strictEqual(outbound.stored_total_read, true);
    assert.strictEqual(outbound.pending_flush, false);
    const rows = await vendorRows(second.base);
    assert.deepStrictEqual(rows.find(r => r.slug === "neon")?.by_class, { browser: 1, ai_agent: 1 });

    await click(second.base, "neon", BROWSER_UA);
    assert.strictEqual((await metricsOutbound(second.base)).total, 4);
    await stop(second);
  });

  it("adds both processes' clicks when the old process is still serving after the new one starts", async () => {
    const stored = () => {
      const raw = redis.keys.get(OUTBOUND_STORE_KEY);
      return raw ? (JSON.parse(raw) as { counts: Record<string, Record<string, number>> }).counts : {};
    };
    const start = stored()["fly-io"]?.browser ?? 0;
    const old = await startAgentDeals(redis, "overlap-old");
    running.push(old);
    const next = await startAgentDeals(redis, "overlap-new");
    running.push(next);
    await click(old.base, "fly-io", BROWSER_UA);
    await click(old.base, "fly-io", BROWSER_UA);
    await click(next.base, "fly-io", BROWSER_UA);
    await stop(old);
    await stop(next);
    assert.strictEqual((stored()["fly-io"]?.browser ?? 0) - start, 3);

    const after = await startAgentDeals(redis, "overlap-after");
    running.push(after);
    const rows = await vendorRows(after.base);
    assert.strictEqual((rows.find(r => r.slug === "fly-io")?.by_class.browser ?? 0) - start, 3);
    await stop(after);
  });
});
