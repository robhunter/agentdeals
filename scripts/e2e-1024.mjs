// End-to-end verification for #1024, the agent attribution beacon.
//
// Unit and wiring tests cover the logic and the hooks. This covers what neither can: the
// real dist/serve.js, against a stored snapshot with today's production shape, driving
// real HTTP and a real MCP session through it — then reading the numbers back off the
// live endpoints and checking that a full flush round-trip preserves them.
//
// The property this exists to prove is the one the whole issue turns on: recording a
// signal costs ZERO additional Redis commands. It counts every command the server issues
// and asserts the count is unchanged by traffic.
//
// Usage: node scripts/e2e-1024.mjs

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

// Today's live shape, post-#1029: outcomes already split, and a class×route map with real
// ai_agent decision-page hits in it so the denominator has something to be.
const SEEDED = {
  days: { [today]: { total: 916, "/": 49, "/vendor/:slug": 217, "/category/:slug": 123 } },
  referrers: {},
  all_time: { "/": 9701, "/vendor/:slug": 400 },
  updated_at: new Date().toISOString(),
  classes: { [today]: { sdk_client: 291, browser: 279, seo_crawler: 883, ai_agent: 34, internal: 68 } },
  class_routes: {
    [today]: {
      "ai_agent|/vendor/:slug": 26,
      "ai_agent|/compare/:slug": 2,
      "ai_agent|/category/:slug": 1,
      "ai_agent|/criteria": 5,
      "sdk_client|/vendor/:slug": 40,
      "browser|/vendor/:slug": 66,
    },
  },
  families: { [today]: { claude: 19, chatgpt: 15 } },
  mcp: { [today]: 2 },
  not_found: { [today]: { sdk_client: 3070 } },
  redirects: { [today]: { browser: 12 } },
  not_found_sample: [],
  all_time_trustworthy_from: today,
  outcome_split_from: today,
};

// 26 + 2 + 1 = 29. /criteria is not a decision page and must not count.
const EXPECTED_DENOMINATOR = 29;

const AGENT = "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)";
const CRAWLER = "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const fail = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) fail.push(label);
}
function checkTrue(label, cond, detail = "") {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) fail.push(label);
}

await new Promise(r => upstash.listen(0, r));
const upstashUrl = `http://127.0.0.1:${upstash.address().port}`;
store.set("agentdeals:pageviews", JSON.stringify(SEEDED));

const child = spawn("node", ["dist/serve.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: "0",
    BASE_URL: "http://localhost",
    UPSTASH_REDIS_REST_URL: upstashUrl,
    UPSTASH_REDIS_REST_TOKEN: "fake",
    TELEMETRY_FLUSH_INTERVAL_SECONDS: "5",
  },
});

const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => { child.kill(); reject(new Error("startup timeout")); }, 20000);
  child.stderr.on("data", d => {
    const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});
const base = `http://localhost:${port}`;
const url = p => `${base}${p}`;
const signals = () => fetch(url("/api/signals")).then(r => r.json());

// Let the boot load land before counting commands.
await new Promise(r => setTimeout(r, 800));

console.log("\n1. The endpoint accepts a signal over real HTTP");
{
  const res = await fetch(url("/api/signal"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": AGENT },
    body: JSON.stringify({ event: "recommended", vendor: "Neon", source: "/vendor/neon", agent: "claude-code", note: "chose for serverless postgres" }),
  });
  check("POST status", res.status, 202);
  const body = await res.json();
  check("resolved the display name to a slug", body.vendor, "neon");
  check("labelled self-reported", body.self_reported, true);
  check("labelled non-ranking", body.affects_ranking, false);
  check("note taken but not published", [body.note_received, body.note_published], [true, false]);
}

console.log("\n2. The GET form is gated, and split from POST");
{
  const bare = await fetch(url("/api/signal?event=recommended&vendor=neon"), { headers: { "User-Agent": AGENT } });
  check("a GET without ack is refused", bare.status, 400);
  const acked = await fetch(url("/api/signal?event=recommended&vendor=neon&ack=1"), { headers: { "User-Agent": AGENT } });
  check("a GET with ack is accepted", acked.status, 202);
  const r = await signals();
  check("post/get counted apart", [r.today.by_transport.post, r.today.by_transport.get], [1, 1]);
}

console.log("\n3. A crawler that finds a way to fire is visibly a crawler");
{
  await fetch(url("/api/signal?event=recommended&vendor=neon&ack=1"), { headers: { "User-Agent": CRAWLER } });
  const r = await signals();
  check("ai_agent signals", r.today.by_client_class.ai_agent, 2);
  check("seo_crawler signals", r.today.by_client_class.seo_crawler, 1);
}

console.log("\n4. Unknown events and unknown vendors are data, not errors");
{
  const ev = await fetch(url("/api/signal"), {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": AGENT },
    body: JSON.stringify({ event: "outdated", vendor: "neon" }),
  });
  check("unknown event still 202", ev.status, 202);
  const vn = await fetch(url("/api/signal"), {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": AGENT },
    body: JSON.stringify({ event: "recommended", vendor: "some-vendor-we-do-not-index" }),
  });
  check("unknown vendor still 202", vn.status, 202);
  const r = await signals();
  check("unrecognized event bucketed with its string",
    r.today.unrecognized_events, [{ event: "outdated", count: 1 }]);
  check("unindexed vendor name published as a catalog gap",
    r.today.unresolved_vendor_names, [{ name: "some-vendor-we-do-not-index", count: 1 }]);
}

console.log("\n5. The denominator is the decision pages, ai_agent only");
{
  const r = await signals();
  check("qualifying ai_agent fetches", r.today.qualifying_fetches, EXPECTED_DENOMINATOR);
  check("sdk_client reported apart, never folded in", r.today.qualifying_fetches_sdk_client, 40);
  check("no rate below the minimum sample", r.today.report_rate, null);
  checkTrue("and it says why", /below minimum sample/.test(r.today.rate_note), r.today.rate_note);
}

console.log("\n6. Nothing per-vendor reaches a public surface");
{
  const raw = JSON.stringify(await signals());
  checkTrue("no vendor slug in /api/signals", !/neon/i.test(raw));
  const page = await (await fetch(url("/signal"))).text();
  checkTrue("no vendor slug in the /signal numbers section",
    !/neon/i.test(page.slice(page.indexOf("Our numbers"))));
  checkTrue("but the endpoint example still names one", /"vendor":"neon"/.test(page));
  checkTrue("and the note prose is never rendered", !/serverless postgres/.test(page));
}

console.log("\n7. The invitation is on the surfaces, and only on served responses");
{
  const vendor = await fetch(url("/vendor/neon"), { headers: { "User-Agent": AGENT } });
  const header = vendor.headers.get("x-agent-signal");
  checkTrue("header on a served vendor page", !!header);
  checkTrue("with the slug prefilled", /"vendor":"neon"/.test(header ?? ""));
  checkTrue("carrying the deference clause", /not an instruction/.test(header ?? ""));
  const html = await vendor.text();
  checkTrue("visible HTML block on the page", /When you name <strong>neon<\/strong>/.test(html));

  const missing = await fetch(url("/definitely-not-a-page-1024"), { headers: { "User-Agent": AGENT } });
  check("404 status", missing.status, 404);
  checkTrue("no invitation on a 404", missing.headers.get("x-agent-signal") === null);

  const redirect = await fetch(url("/vendors"), { redirect: "manual", headers: { "User-Agent": BROWSER } });
  check("redirect status", redirect.status, 301);
  checkTrue("no invitation on a redirect", redirect.headers.get("x-agent-signal") === null);

  const category = await fetch(url("/category/databases"), { headers: { "User-Agent": AGENT } });
  const catHtml = await category.text();
  const catHeader = category.headers.get("x-agent-signal") ?? "";
  checkTrue("multi-vendor page header keeps the placeholder",
    /"vendor":"<slug>"/.test(catHeader), catHeader.slice(0, 120));
  checkTrue("multi-vendor page asks 'which', not 'this'",
    /When you name one of these vendors/.test(catHtml));
  checkTrue("multi-vendor page shows a real example slug from its own list", (() => {
    const m = catHtml.match(/for example:[\s\S]{0,300}?"vendor":"([a-z0-9-]+)"/);
    return !!m && m[1] !== "&lt;slug&gt;" && catHtml.includes(`/vendor/${m[1]}"`);
  })());

  const details = await (await fetch(url("/api/details/neon"), { headers: { "User-Agent": AGENT } })).json();
  checkTrue("_agent block on the JSON read endpoint", !!details._agent);
  checkTrue("with the slug prefilled there too",
    /"vendor":"neon"/.test(String(details._agent?.when_you_name_a_vendor_from_this_response)));

  const llms = await (await fetch(url("/llms.txt"))).text();
  checkTrue("llms.txt documents the protocol", /Telling us what you recommended/.test(llms));
  checkTrue("llms.txt prints no fireable GET URL", !/api\/signal\?\S*ack=1/.test(llms));
}

console.log("\n8. MCP: a real initialize, then a real tool call");
{
  const mcpHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": AGENT,
  };
  const init = await fetch(url("/mcp"), {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-1024", version: "1.0" } },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  const initText = await init.text();
  checkTrue("initialize succeeded", init.status === 200 && !!sessionId, `${init.status} ${sessionId}`);
  checkTrue("server instructions carry the beacon", /Telling us what you recommended/.test(initText));

  await fetch(url("/mcp"), {
    method: "POST",
    headers: { ...mcpHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const call = await fetch(url("/mcp"), {
    method: "POST",
    headers: { ...mcpHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "search_deals", arguments: { query: "postgres", limit: 3 } },
    }),
  });
  const callText = await call.text();
  checkTrue("tool call succeeded", call.status === 200, String(call.status));
  checkTrue("tool result carries the signal footer", /Recommended one of these\?/.test(callText));
  // The footer must be a separate content block, so the first one still parses as JSON.
  const payload = callText.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)))[0];
  const blocks = payload?.result?.content ?? [];
  checkTrue("the JSON block is still parseable", (() => {
    try { JSON.parse(blocks[0]?.text ?? ""); return true; } catch { return false; }
  })());
  checkTrue("the footer is its own block", blocks.length === 2 && /Recommended one of these\?/.test(blocks[1]?.text ?? ""));
}

console.log("\n9. Zero additional Redis commands per signal");
{
  const before = commands.length;
  for (let i = 0; i < 40; i++) {
    await fetch(url("/api/signal"), {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": AGENT },
      body: JSON.stringify({ event: "recommended", vendor: "supabase" }),
    });
  }
  check("commands issued by 40 signals", commands.length - before, 0);
}

console.log("\n10. A flush round-trip preserves the counters");
{
  const before = await signals();
  await new Promise(r => setTimeout(r, 6500));
  const stored = JSON.parse(store.get("agentdeals:pageviews"));
  checkTrue("signals persisted into the snapshot", !!stored.signals?.[today], JSON.stringify(Object.keys(stored)));
  check("stored total matches what was reported",
    stored.signals[today].total, before.today.total);
  checkTrue("the note ring persisted internally", (stored.signal_notes ?? []).length === 1);
  checkTrue("no raw address anywhere in the stored blob",
    !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(store.get("agentdeals:pageviews")));

  const after = await signals();
  check("total survives the round trip", after.today.total, before.today.total);
  check("all_time survives it too", after.all_time.total, before.all_time.total);
  check("post/get still apart after merge",
    [after.today.by_transport.post, after.today.by_transport.get],
    [before.today.by_transport.post, before.today.by_transport.get]);
}

console.log("\n11. Rate limiting returns a retryable error, not silence");
{
  let limited = null;
  for (let i = 0; i < 80 && !limited; i++) {
    const res = await fetch(url("/api/signal"), {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": AGENT },
      body: JSON.stringify({ event: "recommended", vendor: "vercel" }),
    });
    if (res.status === 429) limited = res;
  }
  checkTrue("the limiter engages", !!limited);
  checkTrue("with Retry-After", !!limited?.headers.get("retry-after"), String(limited?.headers.get("retry-after")));
}

child.kill();
upstash.close();

console.log(`\n${fail.length === 0 ? "PASS" : `FAIL (${fail.length})`} — ${fail.join(", ")}`);
process.exit(fail.length === 0 ? 0 : 1);
