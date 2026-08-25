// End-to-end verification for #1029 against production-shaped stored data.
//
// Unit + wiring tests cover the logic and the hooks. This covers the thing neither can:
// booting the real dist/serve.js against a stored snapshot with the actual shape
// production holds today — junk all-time keys, a legacy day whose total counted its 404s,
// and class counters recorded before the outcome split — then driving real traffic
// through it and reading the real endpoints.
//
// Usage: node scripts/e2e-1029.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";

const store = new Map();
const lists = new Map();
const commands = [];

// --- Fake Upstash -----------------------------------------------------------------
const upstash = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const args = JSON.parse(body || "[]");
    const cmd = String(args[0]).toUpperCase();
    commands.push(cmd);
    let result;
    switch (cmd) {
      case "GET": result = store.get(String(args[1])) ?? null; break;
      case "SET": store.set(String(args[1]), String(args[2])); result = "OK"; break;
      case "MGET": result = args.slice(1).map(k => store.get(String(k)) ?? null); break;
      case "SCAN": {
        const pattern = String(args[3] ?? "*");
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        result = ["0", [...store.keys()].filter(k => k.startsWith(prefix))];
        break;
      }
      case "LPUSH": {
        const key = String(args[1]);
        const list = lists.get(key) ?? [];
        for (const v of args.slice(2)) list.unshift(String(v));
        lists.set(key, list);
        result = list.length;
        break;
      }
      case "LTRIM": {
        const key = String(args[1]);
        lists.set(key, (lists.get(key) ?? []).slice(Number(args[2]), Number(args[3]) + 1));
        result = "OK";
        break;
      }
      case "LRANGE":
        result = (lists.get(String(args[1])) ?? []).slice(Number(args[2]), Number(args[3]) + 1);
        break;
      default: result = 1;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
  });
});

const today = new Date().toISOString().slice(0, 10);

// The exact junk keys the PM quoted from the live all_time.top_pages, plus the real
// shape of today's counters: a day total that counted its own 404s, and class counters
// with the 404s already inside them.
const SEEDED = {
  days: {
    [today]: {
      total: 3862,
      "/": 49,
      "/vendor/:slug": 199,
      "/category/:slug": 123,
      "/best/:slug": 94,
      __unmatched__: 3013,
    },
  },
  referrers: {},
  all_time: {
    "/": 9701,
    "/vendor/:slug": 400,
    __unmatched__: 3866,
    "/%2f%2eenv": 31,
    "/%2eenv": 28,
    "/%2fbackend%2f%2eenv": 28,
    "/%2egit/%63onfig": 27,
    "/%2f%2eaws%2fcredentials": 27,
    "/$(pwd)/.env": 9,
    "/$(pwd)/.env.local": 9,
    "/$(pwd)/.git/config": 9,
    "/$(pwd)/*.auto.tfvars": 9,
  },
  updated_at: new Date().toISOString(),
  classes: { [today]: { sdk_client: 3361, browser: 279, seo_crawler: 883, internal: 68 } },
  class_routes: { [today]: { "sdk_client|__unmatched__": 3065, "browser|/vendor/:slug": 66 } },
  families: {},
  mcp: { [today]: 2 },
};

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SCANNER = "python-httpx/0.27.0";
const AGENT = "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)";

const fail = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) fail.push(label);
}

await new Promise(r => upstash.listen(0, r));
const upstashPort = upstash.address().port;
store.set("agentdeals:pageviews", JSON.stringify(SEEDED));

const proc = spawn("node", ["dist/serve.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: "0",
    BASE_URL: "http://localhost",
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashPort}`,
    UPSTASH_REDIS_REST_TOKEN: "fake",
    TELEMETRY_FLUSH_INTERVAL_SECONDS: "5",
  },
});
let stderr = "";
proc.stderr.on("data", d => { stderr += d.toString(); });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server start timeout\n${stderr}`)), 30000);
  proc.stderr.on("data", d => {
    const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});

const hit = async (p, ua) => {
  const res = await fetch(`http://localhost:${port}${p}`, { headers: { "user-agent": ua }, redirect: "manual" });
  await res.arrayBuffer();
  return res.status;
};
const observe = async p => (await fetch(`http://localhost:${port}${p}`, {
  headers: { "user-agent": "agentdeals-internal/1.0 (coder e2e)" },
})).json();

console.log("\n=== 1. the repair, on the stored snapshot ===");
const pv0 = await observe("/api/pageviews");
check("all_time.total excludes the junk and the legacy bucket", pv0.all_time.total, 9701 + 400);
check("all_time.not_found holds the repaired junk", pv0.all_time.not_found, 31 + 28 + 28 + 27 + 27 + 9 + 9 + 9 + 9);
check("all_time.unclassified_legacy holds the un-splittable bucket", pv0.all_time.unclassified_legacy, 3866);
check("no junk path survives in top_pages",
  pv0.all_time.top_pages.filter(p => /%|\$/.test(p.path)).length, 0);
check("today.total is the named pages, not the inflated counter", pv0.today.total, 49 + 199 + 123 + 94);
// The seeded day lists 4 named pages against a stored total of 3,862 — deliberately
// partial, as a legacy day whose smaller keys have expired would be. So the unnameable
// remainder is larger than the __unmatched__ bucket alone, and the report says so rather
// than dropping the difference. What must hold is that the arithmetic closes.
check("today.unclassified_legacy carries everything unnameable", pv0.today.unclassified_legacy, 3862 - 465);
check("and the arithmetic closes against the old total",
  pv0.today.total + pv0.today.unclassified_legacy, 3862);
check("trustworthy_from is stamped", pv0.all_time_trustworthy_from, today);

console.log("\n=== 2. real traffic, real statuses ===");
const before = await observe("/api/traffic");
const cmdsBefore = commands.length;
for (let i = 0; i < 40; i++) await hit(`/wp-admin-${i}/setup.php`, SCANNER);
for (let i = 0; i < 5; i++) await hit("/vendor/neon", BROWSER);
await hit("/vendor/neon", AGENT);
check("a scanned path 404s", await hit("/zzz-e2e-probe", SCANNER), 404);
check("a plural vendor path 301s", await hit("/vendors/neon", BROWSER), 301);

const after = await observe("/api/traffic");
check("40+1 scanner 404s counted apart",
  after.since_boot_not_found - before.since_boot_not_found, 41);
check("none of them counted as a page the scanner read",
  after.since_boot_by_class.sdk_client - before.since_boot_by_class.sdk_client, 0);
check("the browser's 5 page views counted",
  after.since_boot_by_class.browser - before.since_boot_by_class.browser, 5);
check("the redirect counted apart from both",
  after.since_boot_redirects - before.since_boot_redirects, 1);
check("the AI agent hit counted", after.since_boot_by_class.ai_agent - before.since_boot_by_class.ai_agent, 1);

console.log("\n=== 3. the sample makes the excluded traffic attributable ===");
const sample = after.not_found_sample;
check("sample is bounded", sample.length <= 50, true);
check("newest first", sample[0].path, "/zzz-e2e-probe");
check("carries the client class", sample[0].client_class, "sdk_client");
check("carries the status", sample[0].status, 404);
console.log(`  sample head: ${JSON.stringify(sample.slice(0, 3))}`);

console.log("\n=== 4. the window states its own denominator ===");
check("today is complete", after.today.coverage.split(";")[0], "complete");
check("30d says how thin it is", after.last_30d.coverage.split(";")[0].startsWith("partial — 1 of 30 days"), true);
check("and names the pre-split day", after.today.pre_split_dates, [today]);
console.log(`  coverage(30d): ${after.last_30d.coverage}`);

console.log("\n=== 5. the command budget still binds ===");
const cmdsForTraffic = commands.length - cmdsBefore;
console.log(`  ${cmdsForTraffic} Redis commands for 48 requests + 2 observability reads`);
check("no command on the request path", cmdsForTraffic <= 1, true);

console.log("\n=== 6. one flush writes one snapshot, repaired ===");
const flushBefore = commands.length;
await new Promise(r => setTimeout(r, 6500));
const flushCmds = commands.slice(flushBefore);
console.log(`  flush spent: ${JSON.stringify(flushCmds)}`);
check("exactly one SET for the snapshot", flushCmds.filter(c => c === "SET").length, 1);
check("no SCAN", flushCmds.includes("SCAN"), false);

const stored = JSON.parse(store.get("agentdeals:pageviews"));
check("the junk is gone from storage", Object.keys(stored.all_time).some(k => /%|\$/.test(k)), false);
check("stored not_found key holds the repaired hits", stored.all_time.__not_found__ >= 177, true);
check("the sample persisted", stored.not_found_sample.length > 0, true);
check("trustworthy_from persisted", stored.all_time_trustworthy_from, today);
check("outcome_split_from persisted", stored.outcome_split_from, today);
check("snapshot size stays sane", JSON.stringify(stored).length < 400_000, true);
console.log(`  stored snapshot: ${(JSON.stringify(stored).length / 1024).toFixed(1)}KB`);

console.log("\n=== 7. MCP still works, and lands on the MCP side ===");
let mcpSession;
const mcp = async payload => {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST", headers, body: JSON.stringify(payload),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSession = sid;
  return res.text();
};
const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coder-e2e", version: "1" } } });
check("initialize answers", init.includes("serverInfo"), true);
await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
const call = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_deals", arguments: { query: "postgres" } } });
check("tools/call answers", call.includes("result") && !call.includes('"error"'), true);
if (!call.includes("result")) console.log(`  tools/call raw: ${call.slice(0, 400)}`);

console.log("\n=== 8. the search window says how thin it is ===");
const metrics = await observe("/api/metrics");
console.log(`  window_7d: ${JSON.stringify(metrics.search_analytics.window_7d)}`);
check("search window is disclosed", typeof metrics.search_analytics.window_7d.coverage, "string");
check("page_views_today excludes the 404s", metrics.page_views_today, 5);

console.log("\n=== 9. idempotence: a second boot must not re-repair ===");
proc.kill("SIGTERM");
await new Promise(r => setTimeout(r, 1500));
const storedAfterShutdown = JSON.parse(store.get("agentdeals:pageviews"));
const proc2 = spawn("node", ["dist/serve.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env, PORT: "0", BASE_URL: "http://localhost",
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashPort}`,
    UPSTASH_REDIS_REST_TOKEN: "fake", TELEMETRY_FLUSH_INTERVAL_SECONDS: "5",
  },
});
const port2 = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("second boot timeout")), 30000);
  proc2.stderr.on("data", d => {
    const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});
const pv2 = await (await fetch(`http://localhost:${port2}/api/pageviews`, {
  headers: { "user-agent": "agentdeals-internal/1.0 (coder e2e)" },
})).json();
check("all-time total unchanged on reboot", pv2.all_time.total, JSON.parse(JSON.stringify(
  Object.entries(storedAfterShutdown.all_time)
    .filter(([k]) => !["total", "__not_found__", "__redirect__", "__unmatched__"].includes(k))
    .reduce((s, [, v]) => s + v, 0))));
check("trustworthy_from not reset to a later date", pv2.all_time_trustworthy_from, today);
proc2.kill("SIGKILL");

upstash.close();
console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${fail.join(", ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
