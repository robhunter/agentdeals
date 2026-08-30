import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED = [
  "agents.json",
  "referral_requests.json",
  "referral_codes.json",
  "ledger_entries.json",
  "agent_balances.json",
].map((f) => path.join(REPO, "data", f));

const PLATFORM_SECRET = "e2e-split-secret";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const originals = new Map();
for (const p of TRACKED) originals.set(p, existsSync(p) ? readFileSync(p, "utf-8") : null);
function restoreData() {
  for (const [p, held] of originals) {
    if (held !== null) writeFileSync(p, held, "utf-8");
    else if (existsSync(p)) unlinkSync(p);
  }
}

function upstashDouble() {
  const keys = new Map();
  const lists = new Map();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let cmd = [];
      try { cmd = JSON.parse(body); } catch { cmd = []; }
      const op = String(cmd[0] ?? "").toUpperCase();
      const key = String(cmd[1] ?? "");
      let result = null;
      if (op === "SET") { keys.set(key, String(cmd[2])); result = "OK"; }
      else if (op === "GET") { result = keys.has(key) ? keys.get(key) : null; }
      else if (op === "MGET") { result = cmd.slice(1).map((k) => keys.get(String(k)) ?? null); }
      else if (op === "INCR") { const n = Number(keys.get(key) ?? "0") + 1; keys.set(key, String(n)); result = n; }
      else if (op === "INCRBY") { const n = Number(keys.get(key) ?? "0") + Number(cmd[2]); keys.set(key, String(n)); result = n; }
      else if (op === "LPUSH") { const l = lists.get(key) ?? []; for (const v of cmd.slice(2)) l.unshift(String(v)); lists.set(key, l); result = l.length; }
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
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", ...env },
    });
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("startup timeout")); }, 30000);
    proc.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc, port: parseInt(m[1], 10) }); }
    });
    proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function mcpSession(base, clientName) {
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  let id = 1;
  const rpc = async (method, params, offset) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id + offset, method, params }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
    return { res, payload: JSON.parse(line.replace(/^data: /, "")) };
  };
  return {
    ok: init.status === 200 && !!sessionId,
    async call(name, args) {
      const { res, payload } = await rpc("tools/call", { name, arguments: args }, 100);
      const content = payload?.result?.content?.[0]?.text ?? "";
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { parsed = null; }
      return { status: res.status, text: content, json: parsed };
    },
    async list() {
      const { payload } = await rpc("tools/list", {}, 200);
      return payload?.result?.tools ?? [];
    },
  };
}

const redis = await upstashDouble();
let server;

try {
  for (const p of TRACKED) {
    const property = path.basename(p, ".json");
    writeFileSync(p, JSON.stringify({ [property]: [] }, null, 2), "utf-8");
  }

  server = await startServer({
    UPSTASH_REDIS_REST_URL: redis.url,
    UPSTASH_REDIS_REST_TOKEN: "e2e-split",
    AGENTDEALS_PLATFORM_SECRET: PLATFORM_SECRET,
    AGENTDEALS_ROLLUP_DIR: "/tmp/e2e-1163-split-rollups",
  });
  const base = `http://127.0.0.1:${server.port}`;

  const stats = await (await fetch(`${base}/api/stats`)).json();
  check("identity storage is durable for this run", stats.identity_storage?.durable === true);

  console.log("\nA the published split");
  const marketplace = await (await fetch(`${base}/marketplace`)).text();
  const splits = marketplace.slice(marketplace.indexOf("Revenue Splits"), marketplace.indexOf("Code Ranking"));
  check("split table names the submitter and the platform", /<th>Submitter<\/th><th>Platform<\/th>/.test(splits));
  check("split table names no surfer", !/>\s*Surfer\s*</.test(splits));
  check("agent-submitted row publishes 40/60", /An agent-submitted code converts<\/td><td>40%<\/td><td>60%<\/td>/.test(splits));
  check("our own code publishes 100% platform", /One of our own codes converts<\/td><td>&mdash;<\/td><td>100%<\/td>/.test(splits));
  check("page states there is no share for surfacing", splits.includes("There is no share for surfacing a code."));
  check("no 70% or 80% share is published", !splits.includes("70%") && !splits.includes("80%"));

  console.log("\nB two agents");
  const reg = async (name) => (await (await fetch(`${base}/api/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, api_key: true }),
  })).json());
  const submitter = await reg("e2e-split-submitter");
  const requester = await reg("e2e-split-requester");
  check("submitter registered", !!submitter.api_key, JSON.stringify(submitter).slice(0, 120));
  check("requester registered", !!requester.api_key);

  const vendor = "Railway";
  const submitted = await (await fetch(`${base}/api/referral-codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${submitter.api_key}` },
    body: JSON.stringify({
      vendor,
      code: "E2ESPLIT",
      referral_url: "https://railway.app?ref=e2esplit",
      description: "End-to-end split check",
    }),
  })).json();
  check("submitter's code is stored", submitted.code === "E2ESPLIT", JSON.stringify(submitted).slice(0, 160));

  console.log("\nC the requester asks for the code over MCP");
  const mcp = await mcpSession(base, "e2e-split-client");
  check("MCP session established", mcp.ok);
  const tools = await mcp.list();
  const getCode = tools.find((t) => t.name === "get_referral_code");
  check("get_referral_code no longer promises credit for asking", !/you'll be credited/.test(getCode?.description ?? ""), getCode?.description?.slice(0, 120));
  check("get_referral_code names the submitter as the credited agent", /submitted the code/.test(getCode?.description ?? ""));

  const fetched = await mcp.call("get_referral_code", { vendor, api_key: requester.api_key });
  check("code is still returned to the requester", !!fetched.json?.referral_code || !!fetched.json?.code || fetched.text.length > 0);
  check("request is reported as recorded", fetched.json?.attribution === "attributed", JSON.stringify(fetched.json?.attribution));
  check("the note says asking does not earn a share", /does not itself earn a share/.test(fetched.json?.attribution_note ?? ""), fetched.json?.attribution_note);

  console.log("\nD a conversion on the submitted code");
  const conv = await fetch(`${base}/api/conversions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PLATFORM_SECRET}` },
    body: JSON.stringify({ vendor, referral_code: "E2ESPLIT", commission_amount: 100 }),
  });
  const entry = await conv.json();
  check("conversion recorded", conv.status === 201, `${conv.status} ${JSON.stringify(entry).slice(0, 160)}`);
  check("credited agent is the submitter", entry.agent_id === submitter.id, `${entry.agent_id} vs ${submitter.id}`);
  check("submitter share is 40 of 100", entry.agent_share === 40, String(entry.agent_share));

  const balOf = async (agent) => (await (await fetch(`${base}/api/agents/${agent.id}/balance`, {
    headers: { Authorization: `Bearer ${agent.api_key}` },
  })).json());
  const submitterBalance = await balOf(submitter);
  const requesterBalance = await balOf(requester);
  check("submitter's pending balance is 40", submitterBalance.pending_balance === 40, String(submitterBalance.pending_balance));
  check("requester earned nothing by asking", requesterBalance.pending_balance === 0, String(requesterBalance.pending_balance));

  console.log("\nE a conversion on one of our own codes");
  const ourConv = await fetch(`${base}/api/conversions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PLATFORM_SECRET}` },
    body: JSON.stringify({ vendor, referral_code: "railway-platform-code", commission_amount: 100 }),
  });
  const ourEntry = await ourConv.json();
  check("conversion recorded", ourConv.status === 201, String(ourConv.status));
  check("no agent is credited", ourEntry.agent_id === null, String(ourEntry.agent_id));
  check("no agent share accrues", ourEntry.agent_share === 0, String(ourEntry.agent_share));
  const afterOurs = await balOf(requester);
  check("the last requester still earned nothing", afterOurs.pending_balance === 0, String(afterOurs.pending_balance));

  console.log("\nF the leaderboard");
  const lb = await (await fetch(`${base}/api/leaderboard`)).json();
  check("leaderboard lists exactly one agent", lb.total === 1, JSON.stringify(lb.leaderboard?.map((e) => e.agent_name)));
  check("that agent is the submitter", lb.leaderboard?.[0]?.agent_name === "e2e-split-submitter");

  console.log("\nG check_balance over MCP");
  const balance = await mcp.call("check_balance", { api_key: submitter.api_key });
  check("check_balance reports the submitter's 40", balance.json?.pending_balance === 40, JSON.stringify(balance.json).slice(0, 160));
  check("payouts still report unavailable", balance.json?.payouts_available === false);
} finally {
  if (server) server.proc.kill("SIGKILL");
  redis.server.close();
  restoreData();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
