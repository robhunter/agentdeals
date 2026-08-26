import { createServer } from "node:http";
import { spawn } from "node:child_process";

const HELP = `End-to-end check for the durable daily MCP session count (#1052 criterion 0).

Boots the real dist/serve.js against a fake Upstash, opens real MCP sessions over
streamable HTTP (initialize -> tools/call), restarts the process against the same
store, and reads /api/stats and /api/traffic across the restart. Covers the thing
unit tests cannot: that a deploy no longer restarts the day.

Usage: node scripts/e2e-1052.mjs
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

const UA = { "User-Agent": "agentdeals-internal/1.0 (session series e2e)" };
const MCP_HEADERS = {
  ...UA,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function parseMcpBody(text) {
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const line = text.split("\n").find(l => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : null;
  }
  return text ? JSON.parse(text) : null;
}

async function openSession(base, clientName) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  const body = parseMcpBody(await res.text());
  return { status: res.status, sid, body };
}

async function initializeWithRawClientInfo(base, clientInfo) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, ...clientInfo },
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  const body = parseMcpBody(await res.text());
  return { status: res.status, sid, body };
}

async function callTool(base, sid) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sid },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_deals", arguments: { query: "postgres" } },
    }),
  });
  return { status: res.status, body: parseMcpBody(await res.text()) };
}

const today = new Date().toISOString().slice(0, 10);

async function stats(base) {
  return (await fetch(`${base}/api/stats`, { headers: UA })).json();
}
async function traffic(base) {
  return (await fetch(`${base}/api/traffic`, { headers: UA })).json();
}

async function main() {
  await new Promise(r => upstash.listen(0, r));
  const upstashUrl = `http://127.0.0.1:${upstash.address().port}`;
  const redisEnv = {
    UPSTASH_REDIS_REST_URL: upstashUrl,
    UPSTASH_REDIS_REST_TOKEN: "e2e-token",
  };

  console.log("\n1. A real MCP session is counted the moment it opens");
  let { proc, port } = await startServer(redisEnv);
  let base = `http://127.0.0.1:${port}`;

  const before = (await stats(base)).sessionsToday;
  check("a fresh store starts the day at zero", before === 0, `got ${before}`);

  const first = await openSession(base, "opencode");
  check("initialize returns 200", first.status === 200, String(first.status));
  check("initialize returns a session id", Boolean(first.sid));
  check("initialize returns a server result", Boolean(first.body?.result?.serverInfo));

  const afterOne = (await stats(base)).sessionsToday;
  check("the session is counted before any flush", afterOne === 1, `got ${afterOne}`);

  const tool = await callTool(base, first.sid);
  check("tools/call on that session returns 200", tool.status === 200, String(tool.status));
  check("tools/call returns content", Boolean(tool.body?.result));

  for (const name of ["claude-code", "glimind-probe", "mcp"]) {
    const s = await openSession(base, name);
    check(`initialize succeeds for ${name}`, s.status === 200);
  }

  for (const [label, raw] of [
    ["omits clientInfo", {}],
    ["sends clientInfo with no name", { clientInfo: {} }],
    ["sends a name with no version", { clientInfo: { name: "mcp" } }],
  ]) {
    const r = await initializeWithRawClientInfo(base, raw);
    check(`a client that ${label} is refused a session`, r.status === 400, String(r.status));
  }
  check("a refused initialize is not counted as a session",
    (await stats(base)).sessionsToday === 4, `got ${(await stats(base)).sessionsToday}`);

  const preRestart = await stats(base);
  check("all four sessions are on the day", preRestart.sessionsToday === 4,
    `got ${preRestart.sessionsToday}`);

  const preTraffic = await traffic(base);
  check("the traffic report dates the series to today",
    preTraffic.sessions.recording_since === today, String(preTraffic.sessions.recording_since));
  check("the traffic report agrees with /api/stats",
    preTraffic.sessions.today === 4, `got ${preTraffic.sessions.today}`);
  check("the series carries one entry per measured day",
    JSON.stringify(preTraffic.sessions.daily) === JSON.stringify([{ date: today, sessions: 4 }]),
    JSON.stringify(preTraffic.sessions.daily));
  check("the reading rule is published with the series",
    preTraffic.notes.some(n => n.includes("recording_since")));

  console.log("\n2. The count survives the event that used to reset it");
  await stop(proc);
  check("the outgoing process persisted the day", Boolean(store.get("agentdeals:pageviews")));
  const persisted = JSON.parse(store.get("agentdeals:pageviews") ?? "{}");
  check("the day is stored under its own date key", persisted.sessions?.[today] === 4,
    JSON.stringify(persisted.sessions));
  check("the clients that opened them are stored too",
    persisted.session_clients?.[today]?.opencode === 1,
    JSON.stringify(persisted.session_clients?.[today]));

  ({ proc, port } = await startServer(redisEnv));
  base = `http://127.0.0.1:${port}`;

  const afterRestart = await stats(base);
  check("a restart does not restart the day", afterRestart.sessionsToday === 4,
    `got ${afterRestart.sessionsToday}`);
  check("the restart is a genuinely new process",
    afterRestart.serverStarted !== preRestart.serverStarted);

  const post = await openSession(base, "codex-mcp-client");
  check("a post-restart initialize returns 200", post.status === 200);
  const final = await stats(base);
  check("a post-restart session adds to the day rather than replacing it",
    final.sessionsToday === 5, `got ${final.sessionsToday}`);

  const finalTraffic = await traffic(base);
  check("recording_since holds at the first measured date, not the restart",
    finalTraffic.sessions.recording_since === today,
    String(finalTraffic.sessions.recording_since));
  check("the lifetime total is reported apart from the dated series",
    finalTraffic.sessions.all_time >= final.sessionsToday,
    `all_time=${finalTraffic.sessions.all_time} today=${final.sessionsToday}`);

  console.log("\n3. A store written before the series existed reads as unmeasured");
  await stop(proc);
  store.set("agentdeals:pageviews", JSON.stringify({
    days: { [today]: 100 },
    all_time: {},
    updated_at: new Date().toISOString(),
  }));
  ({ proc, port } = await startServer(redisEnv));
  base = `http://127.0.0.1:${port}`;

  const legacy = await traffic(base);
  check("an old snapshot reports no measurement rather than zero sessions",
    legacy.sessions.recording_since === null, String(legacy.sessions.recording_since));
  check("an old snapshot carries an empty series",
    Array.isArray(legacy.sessions.daily) && legacy.sessions.daily.length === 0,
    JSON.stringify(legacy.sessions.daily));
  check("an old snapshot still reports the day as zero, not as missing",
    (await stats(base)).sessionsToday === 0);

  await stop(proc);
  upstash.close();

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
