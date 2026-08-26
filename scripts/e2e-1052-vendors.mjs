import { createServer } from "node:http";
import { spawn } from "node:child_process";

const HELP = `End-to-end check for the private per-vendor daily series (#1052 Part A).

Boots the real dist/serve.js against a fake Upstash, drives real page requests at
vendor pages from several client addresses, restarts the process against the same
store, and asserts three things unit tests cannot: that the series survives a
deploy, that no public endpoint carries it, and that the export refuses a caller
without the token.

Usage: node scripts/e2e-1052-vendors.mjs
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const TOKEN = "e2e-analytics-token-0123456789";
const store = new Map();
const lists = new Map();

const upstash = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const args = JSON.parse(body || "[]");
    const cmd = String(args[0]).toUpperCase();
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

const failures = [];
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok    ${label}`);
  else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/serve.js"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("server startup timeout"));
    }, 30000);
    const onData = buf => {
      const m = buf.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
  });
}

async function stop(proc) {
  proc.kill("SIGTERM");
  await new Promise(r => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      r();
    }, 8000);
    proc.on("exit", () => {
      clearTimeout(t);
      r();
    });
  });
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function visit(base, path, address, ua = BROWSER_UA) {
  const res = await fetch(`${base}${path}`, {
    headers: { "User-Agent": ua, "X-Forwarded-For": address },
  });
  await res.arrayBuffer();
  return res.status;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function storedDay(date = today()) {
  const raw = store.get(`vendorseries:${date}`);
  return raw ? JSON.parse(raw) : null;
}

async function json(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "User-Agent": "agentdeals-internal/1.0 (vendor series e2e)", ...headers },
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, text };
}

const upstashPort = await new Promise(resolve => {
  upstash.listen(0, "127.0.0.1", () => resolve(upstash.address().port));
});

const ENV = {
  UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashPort}`,
  UPSTASH_REDIS_REST_TOKEN: "fake",
  TELEMETRY_FLUSH_INTERVAL_SECONDS: "5",
  VENDOR_SERIES_WRITE_INTERVAL_SECONDS: "1",
  ANALYTICS_EXPORT_TOKEN: TOKEN,
};

console.log("\n#1052 Part A — private per-vendor daily series\n");

let first = await startServer(ENV);
let base = `http://localhost:${first.port}`;

console.log("recording");

for (let i = 0; i < 12; i++) await visit(base, "/vendor/vercel", "203.0.113.10");
await visit(base, "/vendor/vercel", "203.0.113.11");
await visit(base, "/vendor/vercel", "203.0.113.12");
await visit(base, "/vendor/render", "203.0.113.10");
await visit(base, "/api/details/render", "203.0.113.99");
const notFoundStatus = await visit(base, "/vendor/definitely-not-a-vendor-xyz", "203.0.113.20");
await visit(base, "/vendor/vercel", "203.0.113.30", "agentdeals-internal/1.0 (probe)");
for (const path of ["/", "/shutdowns", "/criteria", "/search?q=postgres", "/api/offers"]) {
  await visit(base, path, "203.0.113.60");
}

await stop(first.proc);

let day = storedDay();
check("the day was written to its own key on shutdown", day !== null);
check("twelve requests from one address count as one client", day?.counts?.vercel === 3, JSON.stringify(day?.counts));
check("a second surface for the same vendor counts under one slug", day?.counts?.render === 2, JSON.stringify(day?.counts));
check("the 404 we served on a vendor path is not counted anywhere", notFoundStatus >= 400 && day?.counts?.__other_vendors__ === undefined, JSON.stringify(day?.counts));
check("a page that names no vendor is not counted", day?.counts?.__other_vendors__ === undefined && Object.keys(day?.counts ?? {}).length === 2, JSON.stringify(day?.counts));
check("the internal class is excluded", day?.counts?.vercel === 3);
check("one process start recorded", day?.process_starts === 1, String(day?.process_starts));
check("no address appears in the stored record", !JSON.stringify(day).includes("203.0.113"));
check("the key carries only slugs we publish", Object.keys(day?.counts ?? {}).every(k => k === "__other_vendors__" || /^[a-z0-9][a-z0-9-]*$/.test(k)));

console.log("\nsurviving a deploy");

const second = await startServer(ENV);
base = `http://localhost:${second.port}`;

await visit(base, "/vendor/vercel", "203.0.113.10");
await visit(base, "/vendor/fly-io", "203.0.113.40");
await new Promise(r => setTimeout(r, 7000));

const gauge = await json(base, "/api/traffic");
check("/api/traffic reports the series is recording", gauge.body?.vendor_series?.recording_date === today());
check("the published gauge names no vendor", !JSON.stringify(gauge.body.vendor_series).includes("vercel"));
check("the gauge says the series is not published", gauge.body?.vendor_series?.published === false);
check("the gauge says the store is configured", gauge.body?.vendor_series?.configured === true);

day = storedDay();
check("the restarted process adds to the same day", day?.counts?.vercel === 4, JSON.stringify(day?.counts));
check("process_starts is the upper bound on double counting", day?.process_starts === 2, String(day?.process_starts));

console.log("\nnot served publicly");

const publicSurfaces = ["/api/pageviews", "/api/traffic", "/api/metrics", "/api/analytics/history", "/api/signals", "/health"];
for (const path of publicSurfaces) {
  const res = await json(base, path);
  const carriesSeries = res.text.includes("vendorseries") || /"vercel"\s*:\s*\d/.test(res.text);
  check(`${path} carries no per-vendor count`, !carriesSeries);
}

const daily = await json(base, `/api/analytics/daily?date=${today()}`);
check("/api/analytics/daily keeps vendors null", daily.body?.vendors === null, JSON.stringify(daily.body?.vendors));

console.log("\nexport");

const anon = await json(base, "/api/analytics/vendors");
check("the export 404s without a token", anon.status === 404, String(anon.status));

const wrong = await json(base, "/api/analytics/vendors", { Authorization: "Bearer wrong-token-wrong-token" });
check("the export 404s with the wrong token", wrong.status === 404, String(wrong.status));

const authed = await json(base, "/api/analytics/vendors", { Authorization: `Bearer ${TOKEN}` });
check("the export 200s with the token", authed.status === 200, String(authed.status));
check("the export returns the day we recorded", authed.body?.days?.[0]?.counts?.vercel === 4, JSON.stringify(authed.body?.days?.[0]?.counts));
check("the export states the counting rule", (authed.body?.notes ?? []).some(n => n.includes("distinct clients per vendor per day")));
check("the export states the restart limit", (authed.body?.notes ?? []).some(n => n.includes("process_starts")));
check("the export defaults to the retention window", authed.body?.requested_days === 90, String(authed.body?.requested_days));

const ranged = await json(base, `/api/analytics/vendors?from=${today()}&to=${today()}`, { Authorization: `Bearer ${TOKEN}` });
check("a one-day range returns one day", ranged.body?.days?.length === 1, String(ranged.body?.days?.length));

const bad = await json(base, "/api/analytics/vendors?from=yesterday", { Authorization: `Bearer ${TOKEN}` });
check("a malformed date is rejected", bad.status === 400, String(bad.status));

const head = await fetch(`${base}/api/analytics/vendors`, { method: "HEAD" });
check("HEAD without a token is also refused", head.status === 404, String(head.status));

await stop(second.proc);

console.log("\nwithout a token configured");

const third = await startServer({ ...ENV, ANALYTICS_EXPORT_TOKEN: "" });
base = `http://localhost:${third.port}`;
const unconfigured = await json(base, "/api/analytics/vendors", { Authorization: `Bearer ${TOKEN}` });
check("the export 404s when no token is configured", unconfigured.status === 404, String(unconfigured.status));
await visit(base, "/vendor/vercel", "203.0.113.55");
await new Promise(r => setTimeout(r, 7000));
check("recording continues with the export closed", storedDay()?.counts?.vercel === 5, JSON.stringify(storedDay()?.counts));
await stop(third.proc);

upstash.close();

console.log(`\n${failures.length === 0 ? "PASS" : `FAIL — ${failures.length}`}: ${failures.join(", ")}\n`);
process.exit(failures.length === 0 ? 0 : 1);
