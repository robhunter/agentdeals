import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `End-to-end check for the durable daily analytics rollup.

Boots the real dist/serve.js against a fake Upstash holding a production-shaped
snapshot, reads the real endpoint, runs the real collector script against it, and
restarts the server pointed at the files the collector wrote. Covers the two things
unit tests cannot: that the endpoint is wired to the stored snapshot, and that a
process which starts with an empty Redis still reports the history on disk.

Usage: node scripts/e2e-1056.mjs
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

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

const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
const YESTERDAY = day(1);
const TWO_DAYS_AGO = day(2);

const SECRET_VENDOR = "neon";
const SECRET_CALLER_TEXT = "a product nobody here carries";
const SECRET_RAW_EVENT = "an-event-we-never-listed";

function seededDay(scale) {
  return {
    total: 100 * scale + 21,
    "/vendor/:slug": 60 * scale,
    "/search": 25 * scale,
    "/": 15 * scale,
    __not_found__: 14,
    __redirect__: 7,
    __unmatched__: 0,
  };
}

const SEEDED = {
  days: { [TWO_DAYS_AGO]: seededDay(1), [YESTERDAY]: seededDay(2), [TODAY]: seededDay(3) },
  referrers: { [YESTERDAY]: { "news.ycombinator.com": 9 }, [TODAY]: { "google.com": 31 } },
  all_time: { total: 0, "/vendor/:slug": 360, "/search": 150 },
  updated_at: new Date().toISOString(),
  classes: {
    [TWO_DAYS_AGO]: { browser: 60, ai_agent: 20, seo_crawler: 20 },
    [YESTERDAY]: { browser: 120, ai_agent: 40, seo_crawler: 40 },
    [TODAY]: { browser: 180, ai_agent: 60, seo_crawler: 60 },
  },
  class_routes: {
    [YESTERDAY]: { "ai_agent|/vendor/:slug": 30, "browser|/search": 55 },
    [TODAY]: { "ai_agent|/vendor/:slug": 45, "browser|/search": 70 },
  },
  families: { [YESTERDAY]: { claude: 22, gptbot: 18 }, [TODAY]: { claude: 33, gptbot: 27 } },
  mcp: { [TWO_DAYS_AGO]: 11, [YESTERDAY]: 22, [TODAY]: 33 },
  not_found: { [YESTERDAY]: { other_bot: 14 }, [TODAY]: { other_bot: 14 } },
  redirects: { [YESTERDAY]: { browser: 7 }, [TODAY]: { browser: 7 } },
  not_found_sample: [],
  signals: {
    [YESTERDAY]: {
      total: 9,
      "e:recommended": 8,
      "e:converted": 1,
      "t:post": 9,
      "c:ai_agent": 9,
      "s:/vendor/:slug": 6,
      "a:a-reporting-agent": 9,
      [`v:recommended:${SECRET_VENDOR}`]: 5,
      "v:recommended:supabase": 3,
      [`v:converted:${SECRET_VENDOR}`]: 1,
      [`u:${SECRET_CALLER_TEXT}`]: 2,
      [`x:${SECRET_RAW_EVENT}`]: 1,
    },
    [TODAY]: { total: 2, "e:recommended": 2, "t:post": 2, "c:sdk_client": 2 },
  },
  signals_all_time: { total: 11, "e:recommended": 10, "e:converted": 1 },
  signal_notes: [],
  signals_from: TWO_DAYS_AGO,
  all_time_trustworthy_from: TWO_DAYS_AGO,
  outcome_split_from: TWO_DAYS_AGO,
};

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

function runCollector(args) {
  return new Promise(resolve => {
    const proc = spawn("node", ["scripts/rollup-analytics.js", ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    proc.stdout.on("data", d => (out += d.toString()));
    proc.stderr.on("data", d => (out += d.toString()));
    proc.on("exit", code => resolve({ code, out }));
  });
}

const UA = { "User-Agent": "agentdeals-internal/1.0 (rollup e2e)" };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "rollup-e2e-"));
  await new Promise(r => upstash.listen(0, r));
  const upstashUrl = `http://127.0.0.1:${upstash.address().port}`;
  store.set("agentdeals:pageviews", JSON.stringify(SEEDED));

  const redisEnv = {
    UPSTASH_REDIS_REST_URL: upstashUrl,
    UPSTASH_REDIS_REST_TOKEN: "e2e-token",
  };

  console.log("\n1. Endpoint serves the stored day, redacted");
  let { proc, port } = await startServer({ ...redisEnv, AGENTDEALS_ROLLUP_DIR: dir });
  const base = `http://127.0.0.1:${port}`;

  const dayRes = await fetch(`${base}/api/analytics/daily?date=${YESTERDAY}`, { headers: UA });
  const dayBody = await dayRes.json();
  check("endpoint returns 200", dayRes.status === 200, String(dayRes.status));
  check("served count comes from the route keys, not the stored total",
    dayBody.page_views.served === 200, `got ${dayBody.page_views?.served}`);
  check("not-found stays out of served", dayBody.page_views.not_found === 14);
  check("redirects stay out of served", dayBody.page_views.redirects === 7);
  check("every route is carried", Object.keys(dayBody.page_views.by_route).length === 3);
  check("mcp calls carried", dayBody.mcp_tool_calls === 22);
  check("classes carried", dayBody.traffic.by_class.browser === 120);
  check("families carried", dayBody.traffic.ai_agent_families.claude === 22);
  check("referrers carried", dayBody.referrers["news.ycombinator.com"] === 9);
  check("signal total carried", dayBody.signals.total === 9);
  check("signal source carried", dayBody.signals.by_source["/vendor/:slug"] === 6);
  check("vendor keys counted", dayBody.signals.vendor_key_count === 3);
  check("vendor detail withheld", dayBody.vendors === null);
  check("past day marked final", dayBody.complete === true);

  const dayText = JSON.stringify(dayBody);
  check("no vendor slug in the response", !dayText.includes(SECRET_VENDOR));
  check("no second vendor slug in the response", !dayText.includes("supabase"));
  check("no caller-supplied name in the response", !dayText.includes(SECRET_CALLER_TEXT));
  check("no caller-supplied event in the response", !dayText.includes(SECRET_RAW_EVENT));

  const todayRes = await fetch(`${base}/api/analytics/daily?date=${TODAY}`, { headers: UA });
  const todayBody = await todayRes.json();
  check("current day marked incomplete", todayBody.complete === false);
  check("dates on offer include all three seeded days",
    [TWO_DAYS_AGO, YESTERDAY, TODAY].every(d => todayBody.dates_available.includes(d)),
    JSON.stringify(todayBody.dates_available));

  const badRes = await fetch(`${base}/api/analytics/daily?date=nonsense`, { headers: UA });
  check("a malformed date is refused", badRes.status === 400, String(badRes.status));

  console.log("\n2. Collector writes one file per day");
  let run = await runCollector(["--base", base, "--dir", dir]);
  check("collector exits clean", run.code === 0, run.out);
  const written = readdirSync(dir).sort();
  check("a file per seeded day", written.length === 3, written.join(","));
  check("named by date", written.includes(`${YESTERDAY}.json`), written.join(","));

  const storedYesterday = JSON.parse(readFileSync(join(dir, `${YESTERDAY}.json`), "utf-8"));
  check("stored day keeps the served count", storedYesterday.page_views.served === 200);
  check("stored day is final", storedYesterday.complete === true);
  check("stored day drops the live dates list", storedYesterday.dates_available === undefined);

  const allText = written.map(f => readFileSync(join(dir, f), "utf-8")).join("\n");
  check("no vendor slug reaches disk", !allText.includes(SECRET_VENDOR));
  check("no caller-supplied name reaches disk", !allText.includes(SECRET_CALLER_TEXT));
  check("no caller-supplied event reaches disk", !allText.includes(SECRET_RAW_EVENT));

  console.log("\n3. Re-running does not rewrite a day already final");
  const beforeMtime = readFileSync(join(dir, `${YESTERDAY}.json`), "utf-8");
  writeFileSync(join(dir, `${TODAY}.json`), readFileSync(join(dir, `${TODAY}.json`), "utf-8"));
  run = await runCollector(["--base", base, "--dir", dir]);
  check("second run exits clean", run.code === 0, run.out);
  check("past days reported already final", /Already final: 2/.test(run.out), run.out);
  check("the current day is still rewritten", /Rolled up: 1/.test(run.out), run.out);
  check("a final day is untouched",
    readFileSync(join(dir, `${YESTERDAY}.json`), "utf-8") === beforeMtime);

  await stop(proc);

  console.log("\n4. A cold start with empty storage still reports the history on disk");
  store.clear();
  ({ proc, port } = await startServer({ ...redisEnv, AGENTDEALS_ROLLUP_DIR: dir }));
  const coldBase = `http://127.0.0.1:${port}`;
  const signals = await (await fetch(`${coldBase}/api/signals`, { headers: UA })).json();
  check("signals reports durable rollup coverage", signals.durable_rollup !== null && signals.durable_rollup !== undefined);
  check("coverage names the first day", signals.durable_rollup?.first_date === TWO_DAYS_AGO,
    JSON.stringify(signals.durable_rollup));
  check("coverage names the last day", signals.durable_rollup?.last_date === TODAY);
  check("coverage names the last complete day", signals.durable_rollup?.last_complete_date === YESTERDAY);
  check("coverage counts the days", signals.durable_rollup?.days === 3);
  check("coverage says where the files are", signals.durable_rollup?.path === dir);
  check("live windows are empty on a cleared store", signals.all_time.total === 0,
    String(signals.all_time?.total));

  const history = await (await fetch(`${coldBase}/api/analytics/history`, { headers: UA })).json();
  check("history serves a day per stored file", history.days.length === 3, String(history.days?.length));
  check("history is ordered oldest first", history.days[0].date === TWO_DAYS_AGO);
  check("history carries counts Redis no longer holds",
    history.days.find(d => d.date === YESTERDAY)?.served === 200,
    JSON.stringify(history.days));
  check("history carries the class split", history.days.find(d => d.date === YESTERDAY)?.by_class.browser === 120);
  check("history reports its own coverage", history.coverage.days === 3);
  const historyText = JSON.stringify(history);
  check("history leaks no vendor slug", !historyText.includes(SECRET_VENDOR));
  check("history leaks no caller-supplied name", !historyText.includes(SECRET_CALLER_TEXT));
  await stop(proc);

  console.log("\n5. Without storage the endpoint refuses rather than reporting zeros");
  ({ proc, port } = await startServer({ AGENTDEALS_ROLLUP_DIR: dir }));
  const bareBase = `http://127.0.0.1:${port}`;
  const bareRes = await fetch(`${bareBase}/api/analytics/daily?date=${YESTERDAY}`, { headers: UA });
  const bareBody = await bareRes.json();
  check("endpoint answers 503", bareRes.status === 503, String(bareRes.status));
  check("endpoint says why", bareBody.error === "redis-not-configured", JSON.stringify(bareBody));
  check("endpoint does not claim availability", bareBody.available === false);

  const emptyDir = mkdtempSync(join(tmpdir(), "rollup-e2e-empty-"));
  run = await runCollector(["--base", bareBase, "--dir", emptyDir]);
  check("collector refuses to write", run.code !== 0, run.out);
  check("collector wrote nothing", readdirSync(emptyDir).length === 0);
  rmSync(emptyDir, { recursive: true, force: true });
  await stop(proc);

  rmSync(dir, { recursive: true, force: true });
  upstash.close();

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
