import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(process.argv[2] ?? ".");
const SECRET = "e2e-1164-platform-secret";
const dataFiles = ["agents.json", "ledger_entries.json", "agent_balances.json", "referral_requests.json"].map(f =>
  path.join(repo, "data", f),
);
const saved = new Map(dataFiles.map(f => [f, existsSync(f) ? readFileSync(f, "utf8") : null]));

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(repo, "dist", "serve.js")], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", ...env },
    });
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    proc.stderr.on("data", b => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc, port: parseInt(m[1], 10) }); }
    });
    proc.on("error", e => { clearTimeout(timeout); reject(e); });
  });
}

const post = (base, route, { credential, body } = {}) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function resetData() {
  writeFileSync(dataFiles[0], JSON.stringify({ agents: [] }));
  writeFileSync(dataFiles[1], JSON.stringify({ ledger_entries: [] }));
  writeFileSync(dataFiles[2], JSON.stringify({ agent_balances: [] }));
  writeFileSync(dataFiles[3], JSON.stringify({ referral_requests: [] }));
}

function restoreData() {
  for (const [f, contents] of saved) {
    if (contents === null) { if (existsSync(f)) unlinkSync(f); }
    else writeFileSync(f, contents);
  }
}

try {
  resetData();

  console.log("\nA configured deployment");
  const configured = await startServer({ AGENTDEALS_PLATFORM_SECRET: SECRET, AGENTDEALS_REGISTER_LIMIT_PER_HOUR: "3" });
  const base = `http://127.0.0.1:${configured.port}`;

  const reg = await post(base, "/api/agents/register", { body: { name: "E2E1164Bot" } });
  const agentKey = (await reg.json()).api_key;
  check("registration is still open to anyone", reg.status === 201, `status ${reg.status}`);
  check("registration reports its own allowance", reg.headers.get("x-ratelimit-limit") === "3", reg.headers.get("x-ratelimit-limit") ?? "no header");

  for (const [route, body] of [
    ["/api/conversions", { vendor: "Railway", commission_amount: 100000 }],
    ["/api/conversions/confirm", undefined],
    ["/api/conversions/clawback", { entry_id: "le_x" }],
  ]) {
    const anon = await post(base, route, { body });
    check(`${route} refuses an anonymous caller`, anon.status === 401, `status ${anon.status}`);
    const asAgent = await post(base, route, { credential: agentKey, body });
    check(`${route} refuses an agent API key`, asAgent.status === 401, `status ${asAgent.status}`);
    const wrong = await post(base, route, { credential: "wrong-secret", body });
    check(`${route} refuses a wrong credential`, wrong.status === 401, `status ${wrong.status}`);
  }

  const ledgerAfterRefusals = JSON.parse(readFileSync(dataFiles[1], "utf8")).ledger_entries;
  check("nothing was written to the ledger by any refused call", ledgerAfterRefusals.length === 0, `${ledgerAfterRefusals.length} entries`);

  const recorded = await post(base, "/api/conversions", {
    credential: SECRET,
    body: { vendor: "Railway", referral_code: "E2E", commission_amount: 12.5, conversion_date: "2026-08-01" },
  });
  const entry = await recorded.json();
  check("a credentialled caller records a conversion", recorded.status === 201 && entry.commission_amount === 12.5, `status ${recorded.status}`);

  const confirmed = await post(base, "/api/conversions/confirm", { credential: SECRET });
  check("a credentialled caller runs the confirmation sweep", confirmed.status === 200, `status ${confirmed.status}`);

  const clawed = await post(base, "/api/conversions/clawback", { credential: SECRET, body: { entry_id: entry.id } });
  check("a credentialled caller claws an entry back", clawed.status === 200, `status ${clawed.status}`);

  const tooLarge = await post(base, "/api/conversions", { credential: SECRET, body: { vendor: "Railway", commission_amount: 10001 } });
  check("an unbounded commission is refused", tooLarge.status === 400, `status ${tooLarge.status}`);

  const unheld = await post(base, "/api/conversions", { credential: SECRET, body: { vendor: "Vercel", commission_amount: 5 } });
  check("a vendor we hold no link into is refused", unheld.status === 400, `status ${unheld.status}`);

  const second = await post(base, "/api/agents/register", { body: { name: "E2E1164BotTwo" } });
  const third = await post(base, "/api/agents/register", { body: { name: "E2E1164BotThree" } });
  const fourth = await post(base, "/api/agents/register", { body: { name: "E2E1164BotFour" } });
  check("registration admits its allowance", second.status === 201 && third.status === 201, `${second.status}, ${third.status}`);
  check("registration refuses past its allowance", fourth.status === 429, `status ${fourth.status}`);
  check("a refused registration says when to retry", Number(fourth.headers.get("retry-after")) > 0, fourth.headers.get("retry-after") ?? "no header");

  const agents = JSON.parse(readFileSync(dataFiles[0], "utf8")).agents.map(a => a.name);
  check("the refused identity was not created", !agents.includes("E2E1164BotFour"), agents.join(", "));

  const developers = await (await fetch(`${base}/developers`)).text();
  check("the API page states the limit this server enforces", developers.includes("allows 3 registrations per hour per client"));
  check("the API page names the headers the endpoint returns", developers.includes("X-RateLimit-Limit"));
  check("the API page no longer claims the whole API is unlimited", !/no rate limits\.?<\/p>/.test(developers));

  const mcpInit = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-1164", version: "1.0.0" } },
    }),
  });
  const sessionId = mcpInit.headers.get("mcp-session-id");
  check("MCP initialize returns a session", mcpInit.status === 200 && !!sessionId, `status ${mcpInit.status}`);

  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const toolCall = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "get_referral_code", arguments: { vendor: "Railway" } },
    }),
  });
  const toolBody = await toolCall.text();
  check("MCP get_referral_code still resolves Railway", toolCall.status === 200 && toolBody.includes("referralCode=7RZL9q"), `status ${toolCall.status}`);

  configured.proc.kill("SIGKILL");

  console.log("\nAn unconfigured deployment");
  resetData();
  const unconfigured = await startServer({ AGENTDEALS_PLATFORM_SECRET: "" });
  const closedBase = `http://127.0.0.1:${unconfigured.port}`;
  for (const [route, body] of [
    ["/api/conversions", { vendor: "Railway", commission_amount: 5 }],
    ["/api/conversions/confirm", undefined],
    ["/api/conversions/clawback", { entry_id: "le_x" }],
  ]) {
    const anon = await post(closedBase, route, { body });
    const guessed = await post(closedBase, route, { credential: "", body });
    check(`${route} is closed rather than open when no secret is set`, anon.status === 401 && guessed.status === 401, `${anon.status}, ${guessed.status}`);
  }
  const offers = await (await fetch(`${closedBase}/api/offers?limit=1`)).json();
  check("the read API is unaffected", offers.total > 1000, `total ${offers.total}`);
  unconfigured.proc.kill("SIGKILL");
} finally {
  restoreData();
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
