import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_PATH = path.join(REPO, "data", "agents.json");
const REQUESTS_PATH = path.join(REPO, "data", "referral_requests.json");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const originals = new Map();
for (const p of [AGENTS_PATH, REQUESTS_PATH]) {
  originals.set(p, existsSync(p) ? readFileSync(p, "utf-8") : null);
}
function restoreData() {
  for (const [p, held] of originals) if (held !== null) writeFileSync(p, held, "utf-8");
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
    server.listen(0, "127.0.0.1", () => resolve({ server, keys, url: `http://127.0.0.1:${server.address().port}` }));
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
  return {
    sessionId,
    ok: init.status === 200 && !!sessionId,
    async call(name, args) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id + 100, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
      const payload = JSON.parse(line.replace(/^data: /, ""));
      const content = payload?.result?.content?.[0]?.text ?? "";
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { parsed = null; }
      return { status: res.status, isError: payload?.result?.isError === true, text: content, json: parsed };
    },
    async list() {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id + 200, method: "tools/list", params: {} }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
      return JSON.parse(line.replace(/^data: /, ""))?.result?.tools ?? [];
    },
  };
}

const redis = await upstashDouble();
let first;
let second;
let plain;

try {
  writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }, null, 2), "utf-8");
  writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }, null, 2), "utf-8");

  const env = {
    UPSTASH_REDIS_REST_URL: redis.url,
    UPSTASH_REDIS_REST_TOKEN: "e2e-1163",
    AGENTDEALS_ROLLUP_DIR: "/tmp/e2e-1163-rollups",
  };

  console.log("A durable deployment");
  first = await startServer(env);
  const baseA = `http://127.0.0.1:${first.port}`;

  const statsA = await (await fetch(`${baseA}/api/stats`)).json();
  check("identity storage reports durable", statsA.identity_storage?.durable === true, JSON.stringify(statsA.identity_storage?.backend));
  check("every identity store was read from the backend", (statsA.identity_storage?.stores ?? []).every((s) => s.hydrated), "a store was not hydrated");
  check("all seven identity stores are covered", (statsA.identity_storage?.stores ?? []).length >= 7, `${statsA.identity_storage?.stores?.length} stores`);

  const sessionA = await mcpSession(baseA, "e2e-1163");
  check("MCP initialize returns a session", sessionA.ok);

  const name = `e2e-1163-probe-${Date.now()}`;
  const registered = await sessionA.call("register_agent", { name });
  const issuedKey = registered.json?.api_key;
  check("register_agent issues a key over MCP", !!issuedKey, registered.text.slice(0, 120));

  const onDisk = JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
  check("the registration did not go to the image's file", onDisk.agents.length === 0, `${onDisk.agents.length} on disk`);
  check("the registration went to the durable store", [...redis.keys.keys()].includes("agentdeals:store:agents"), [...redis.keys.keys()].join(","));

  first.proc.kill("SIGKILL");
  first = undefined;
  await new Promise((r) => setTimeout(r, 400));

  console.log("\nThe same deployment, restarted");
  second = await startServer(env);
  const baseB = `http://127.0.0.1:${second.port}`;

  const me = await fetch(`${baseB}/api/agents/me`, { headers: { Authorization: `Bearer ${issuedKey}` } });
  check("a key issued before the restart still authenticates", me.status === 200, `status ${me.status}`);

  const sessionB = await mcpSession(baseB, "e2e-1163-restarted");
  const attributed = await sessionB.call("get_referral_code", { vendor: "Railway", api_key: issuedKey });
  check("get_referral_code attributes the pre-restart key", attributed.json?.attribution === "attributed", attributed.text.slice(0, 160));
  check("the referral URL is unchanged", String(attributed.json?.referral_url ?? "").includes("referralCode=7RZL9q"), attributed.json?.referral_url);

  const unknown = await sessionB.call("get_referral_code", { vendor: "Railway", api_key: "agd_this_key_was_never_issued" });
  check("an unrecognised key is named as unrecognised", unknown.json?.attribution === "key_not_recognised", unknown.text.slice(0, 160));
  check("an unrecognised key still gets the code", !!unknown.json?.referral_url, "no code returned");
  check("the reason is stated, not left to inference", /not in the agent registry/i.test(String(unknown.json?.attribution_note ?? "")), unknown.json?.attribution_note);

  const anonymous = await sessionB.call("get_referral_code", { vendor: "Railway" });
  check("no key is distinguished from a bad key", anonymous.json?.attribution === "no_key", anonymous.text.slice(0, 160));

  const httpUnknown = await (await fetch(`${baseB}/api/referral/Railway`, { headers: { Authorization: "Bearer agd_nope" } })).json();
  check("the HTTP referral endpoint makes the same distinction", httpUnknown.attribution === "key_not_recognised", JSON.stringify(httpUnknown.attribution));

  const balance = await sessionB.call("check_balance", { api_key: issuedKey });
  check("check_balance reports that payouts are unavailable", balance.json?.payouts_available === false, balance.text.slice(0, 160));

  const payout = await sessionB.call("request_payout", { api_key: issuedKey });
  check("request_payout reports the missing capability", payout.isError && /not enabled/i.test(payout.text), payout.text.slice(0, 160));

  const tools = await sessionB.list();
  const balanceTool = tools.find((t) => t.name === "check_balance");
  const payoutTool = tools.find((t) => t.name === "request_payout");
  check("check_balance no longer calls the balance available for withdrawal", !/available for withdrawal/i.test(balanceTool?.description ?? ""), balanceTool?.description?.slice(0, 120));
  check("request_payout no longer promises a stablecoin transfer", !/stablecoin transfer/i.test(payoutTool?.description ?? ""), payoutTool?.description?.slice(0, 120));
  check("request_payout states that payouts are not enabled", /not enabled/i.test(payoutTool?.description ?? ""), payoutTool?.description?.slice(0, 120));

  const marketplace = await (await fetch(`${baseB}/marketplace`)).text();
  check("the marketplace page does not promise a payout at $10", !/request payouts when your confirmed balance reaches/i.test(marketplace), "the promise is still rendered");
  check("the marketplace page states why", /Payouts are not enabled yet/i.test(marketplace), "no reason rendered");
  check("the How It Works card does not promise payment via x402", !/Get paid when your codes convert via x402/.test(marketplace), "the card still promises payment");

  const offers = await (await fetch(`${baseB}/api/offers?limit=1`)).json();
  check("the read API is unaffected", offers.total > 1000, `total ${offers.total}`);

  second.proc.kill("SIGKILL");
  second = undefined;

  console.log("\nA deployment with no durable backend");
  plain = await startServer({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", AGENTDEALS_ROLLUP_DIR: "/tmp/e2e-1163-rollups" });
  const baseC = `http://127.0.0.1:${plain.port}`;
  const statsC = await (await fetch(`${baseC}/api/stats`)).json();
  check("identity storage reports the container filesystem", statsC.identity_storage?.backend === "container_filesystem", JSON.stringify(statsC.identity_storage?.backend));
  check("identity storage does not claim to survive a deploy", statsC.identity_storage?.survives_deploy === false, JSON.stringify(statsC.identity_storage));
  plain.proc.kill("SIGKILL");
  plain = undefined;
} finally {
  first?.proc.kill("SIGKILL");
  second?.proc.kill("SIGKILL");
  plain?.proc.kill("SIGKILL");
  redis.server.close();
  restoreData();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
