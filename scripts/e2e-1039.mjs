import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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

const fail = [];
function checkTrue(label, cond, detail = "") {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) fail.push(label);
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) fail.push(label);
}

const AGENTS_PATH = "data/agents.json";
const agentsBefore = existsSync(AGENTS_PATH) ? readFileSync(AGENTS_PATH, "utf8") : null;
function restoreAgentStore() {
  if (agentsBefore !== null) writeFileSync(AGENTS_PATH, agentsBefore);
}
process.on("exit", restoreAgentStore);

const SEARCH_TEXT = "wildebeest-migration-tracker";
const REGISTRATION_NAME = `quokka-registry-probe-${process.pid}`;
const CLIENT_NAME = "pangolin-mcp-client";

await new Promise(r => upstash.listen(0, r));
const upstashUrl = `http://127.0.0.1:${upstash.address().port}`;

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

function rawRequest(path, userAgent) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "localhost", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: ${userAgent}\r\nConnection: close\r\n\r\n`,
      );
    });
    let response = "";
    socket.on("data", d => (response += d.toString()));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
    setTimeout(() => { socket.destroy(); resolve(response); }, 5000);
  });
}

console.log(`\nserver on ${base}, storage on ${upstashUrl}\n`);

console.log("1. Drive real traffic through the free-text intakes");
{
  const r1 = await fetch(url(`/api/offers?q=${encodeURIComponent(SEARCH_TEXT)}&category=Infrastructure&limit=5`));
  checkTrue("search with free text accepted", r1.status === 200, String(r1.status));

  const r2 = await fetch(url("/api/agents/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: REGISTRATION_NAME }),
  });
  checkTrue(`registration reached its handler (status ${r2.status})`, [200, 201, 400, 403, 409, 503].includes(r2.status), String(r2.status));
}

console.log("\n2. Open a real MCP session and call a tool");
let mcpSessionId = null;
{
  const mcpHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  const init = await fetch(url("/mcp"), {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "9.9.9" } },
    }),
  });
  mcpSessionId = init.headers.get("mcp-session-id");
  await init.text();
  checkTrue("initialize succeeded", init.status === 200 && !!mcpSessionId, `${init.status} ${mcpSessionId}`);

  await fetch(url("/mcp"), {
    method: "POST",
    headers: { ...mcpHeaders, "mcp-session-id": mcpSessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  for (const query of [SEARCH_TEXT, "postgres"]) {
    const call = await fetch(url("/mcp"), {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": mcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "search_deals", arguments: { query, limit: 3 } },
      }),
    });
    await call.text();
    checkTrue(`tool call for ${query.slice(0, 12)} succeeded`, call.status === 200, String(call.status));
  }
}

console.log("\n3. What the public endpoint publishes");
const published = await (await fetch(url("/api/query-log?limit=200"))).json();
const body = JSON.stringify(published);
{
  checkTrue("the log is available", published.available === true, JSON.stringify(published.error));
  checkTrue("it has entries", published.count > 0, String(published.count));

  checkTrue("the search text is absent", !body.includes(SEARCH_TEXT));
  checkTrue("the registration name is absent", !body.includes(REGISTRATION_NAME));
  checkTrue("no entry carries a params object", !body.includes('"params"'));
  checkTrue("no entry carries a session identifier", !body.includes('"session_id"'));
  if (mcpSessionId) checkTrue("the live session identifier is absent", !body.includes(mcpSessionId));

  const searchEntry = published.entries.find(e => e.endpoint === "/api/offers");
  checkTrue("the search entry is present", !!searchEntry);
  check("its parameter lengths", searchEntry?.param_lengths, {
    q: SEARCH_TEXT.length, category: "Infrastructure".length, limit: 1, offset: 1,
  });

  const registerEntry = published.entries.find(e => e.endpoint === "/api/agents/register");
  if (registerEntry) {
    check("the registration name is published as a length", registerEntry.param_lengths, { name: REGISTRATION_NAME.length });
  } else {
    console.log("  --    registration was not logged on this build; skipping");
  }

  const sessionEntries = published.entries.filter(e => e.session_index !== undefined);
  checkTrue("session entries carry an index instead", sessionEntries.length > 0, String(sessionEntries.length));
  const indexes = new Set(sessionEntries.map(e => e.session_index));
  checkTrue("every index is a small integer", [...indexes].every(i => Number.isInteger(i) && i >= 1 && i <= sessionEntries.length));
  checkTrue("the tool calls share one index", indexes.size === 1, `indexes: ${[...indexes].join(",")}`);

  const withClient = published.entries.find(e => e.client_info);
  checkTrue("the client name is still published", withClient?.client_info?.name === CLIENT_NAME, JSON.stringify(withClient?.client_info));
}

console.log("\n4. A caller cannot use the log to republish prose on this domain");
{
  const longAgent = `evil/1.0 ${"A".repeat(4000)} trailing-contact-details`;
  await fetch(url("/api/offers?q=probe&limit=1"), { headers: { "User-Agent": longAgent } });
  const after = await (await fetch(url("/api/query-log?limit=200"))).json();
  const longEntry = after.entries.find(e => (e.user_agent ?? "").startsWith("evil/1.0"));
  checkTrue("an oversized user agent was logged", !!longEntry, "entry not found, the checks below would pass vacuously");
  if (longEntry) {
    check("it is bounded", longEntry.user_agent.length, 200);
    checkTrue("its tail was dropped", !longEntry.user_agent.includes("trailing-contact-details"));
  }

  for (const code of [0, 7, 27, 127]) {
    const response = await rawRequest("/api/offers?q=probe&limit=1", `evil/1.0 ${String.fromCharCode(code)} tail`);
    checkTrue(
      `a user agent carrying control character ${code} is refused at the HTTP layer`,
      response.startsWith("HTTP/1.1 400"),
      response.split("\r\n")[0] || "(no response)",
    );
  }

  const escape = String.fromCharCode(27);
  const hostileClient = `evil${escape}[31m${String.fromCharCode(7)}${"B".repeat(900)}`;
  const init = await fetch(url("/mcp"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: hostileClient, version: "1.0" } },
    }),
  });
  await init.text();
  const afterMcp = await (await fetch(url("/api/query-log?limit=200"))).json();
  const hostileEntry = afterMcp.entries.find(e => (e.client_info?.name ?? "").startsWith("evil"));
  checkTrue("a hostile client name reached the log through the JSON body", !!hostileEntry, "entry not found, the checks below would pass vacuously");
  if (hostileEntry) {
    check("the client name is bounded", hostileEntry.client_info.name.length, 200);
    checkTrue("the client name carries no control characters", ![...hostileEntry.client_info.name].some(ch => {
      const c = ch.codePointAt(0) ?? 0;
      return c < 0x20 || c === 0x7f;
    }));
  }
}

console.log("\n5. Retention is unchanged: the values are still in storage");
{
  await new Promise(r => setTimeout(r, 7000));
  const stored = lists.get("agentdeals:request_log") ?? [];
  checkTrue("the request log reached storage", stored.length > 0, String(stored.length));
  const storedBody = stored.join("\n");
  checkTrue("the search text is retained", storedBody.includes(SEARCH_TEXT));
  checkTrue("the session identifier is retained", !mcpSessionId || storedBody.includes(mcpSessionId));
  checkTrue("raw parameter values are retained", storedBody.includes('"params"'));
}

console.log("\n6. The published schema matches what is served");
{
  const spec = await (await fetch(url("/api/openapi.json"))).json();
  const props = spec.paths["/api/query-log"].get.responses["200"].content["application/json"].schema.properties.entries.items.properties;
  checkTrue("the schema describes param_lengths", !!props.param_lengths);
  checkTrue("the schema describes session_index", !!props.session_index);
  checkTrue("the schema no longer describes session_id", !props.session_id);
  checkTrue("the schema no longer describes params", !props.params);
}

child.kill();
upstash.close();

console.log(`\n${fail.length === 0 ? "PASS" : `FAIL (${fail.length})`}`);
if (fail.length) {
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
