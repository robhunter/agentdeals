import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");

let serverPort = 0;
let serverProc: ChildProcess;

let origAgents: string | null = null;
let origCodes: string | null = null;
let origLedger: string | null = null;
let origBalances: string | null = null;
let origRequests: string | null = null;

function saveOriginals() {
  origAgents = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf-8") : null;
  origCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf-8") : null;
  origLedger = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, "utf-8") : null;
  origBalances = fs.existsSync(BALANCES_PATH) ? fs.readFileSync(BALANCES_PATH, "utf-8") : null;
  origRequests = fs.existsSync(REQUESTS_PATH) ? fs.readFileSync(REQUESTS_PATH, "utf-8") : null;
}

function restoreOriginals() {
  if (origAgents !== null) fs.writeFileSync(AGENTS_PATH, origAgents, "utf-8");
  else if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  if (origCodes !== null) fs.writeFileSync(CODES_PATH, origCodes, "utf-8");
  else if (fs.existsSync(CODES_PATH)) fs.unlinkSync(CODES_PATH);
  if (origLedger !== null) fs.writeFileSync(LEDGER_PATH, origLedger, "utf-8");
  else if (fs.existsSync(LEDGER_PATH)) fs.unlinkSync(LEDGER_PATH);
  if (origBalances !== null) fs.writeFileSync(BALANCES_PATH, origBalances, "utf-8");
  else if (fs.existsSync(BALANCES_PATH)) fs.unlinkSync(BALANCES_PATH);
  if (origRequests !== null) fs.writeFileSync(REQUESTS_PATH, origRequests, "utf-8");
  else if (fs.existsSync(REQUESTS_PATH)) fs.unlinkSync(REQUESTS_PATH);
  resetAgentsCache();
  resetReferralCodesCache();
  resetLedgerCache();
}

function resetFiles() {
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: [] }), "utf-8");
  fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: [] }), "utf-8");
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
  resetAgentsCache();
  resetReferralCodesCache();
  resetLedgerCache();
}

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 15000);

    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const { registerAgent, resetAgentsCache, updateAgentX402Address } = await import("../dist/agents.js");
const { resetReferralCodesCache, submitReferralCode } = await import("../dist/referral-codes.js");
const { resetLedgerCache, recordConversion, confirmEligibleEntries } = await import("../dist/ledger.js");
const { logReferralRequest, resetReferralRequestsCache } = await import("../dist/referral-requests.js");

describe("Marketplace API Endpoints", () => {
  let testApiKey: string;
  let testAgentId: string;

  before(async () => {
    saveOriginals();
    resetFiles();

    const result = registerAgent({ name: "APITestBot" });
    testApiKey = result.api_key;
    testAgentId = result.agent.id;

    serverProc = await startHttpServer();
  });

  after(() => {
    serverProc?.kill();
    restoreOriginals();
  });

  // --- POST /api/conversions ---

  it("POST /api/conversions records a conversion", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendor: "Railway",
        referral_code: "TEST123",
        commission_amount: 5.00,
        conversion_date: "2026-04-13",
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.strictEqual(body.vendor, "Railway");
    assert.strictEqual(body.commission_amount, 5.00);
    assert.strictEqual(body.status, "pending");
  });

  it("POST /api/conversions rejects missing vendor", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commission_amount: 5.00 }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("vendor"));
  });

  it("POST /api/conversions rejects invalid commission_amount", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", commission_amount: -1 }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("commission_amount"));
  });

  it("POST /api/conversions rejects invalid JSON", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("Invalid JSON"));
  });

  // --- POST /api/conversions/confirm ---

  it("POST /api/conversions/confirm returns confirmed count", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions/confirm`, {
      method: "POST",
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok("confirmed_count" in body);
    assert.ok(Array.isArray(body.confirmed_ids));
  });

  // --- POST /api/conversions/clawback ---

  it("POST /api/conversions/clawback rejects missing entry_id", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions/clawback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("entry_id"));
  });

  it("POST /api/conversions/clawback returns 404 for nonexistent entry", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions/clawback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: "nonexistent_id" }),
    });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.ok(body.error.includes("not found"));
  });

  it("POST /api/conversions/clawback rejects invalid JSON", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/conversions/clawback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "bad-json",
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("Invalid JSON"));
  });

  // --- GET /api/agents/:id/balance ---

  it("GET /api/agents/:id/balance requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/${testAgentId}/balance`);
    assert.strictEqual(res.status, 401);
  });

  it("GET /api/agents/:id/balance returns balance for own agent", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/${testAgentId}/balance`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.agent_id, testAgentId);
    assert.ok("pending_balance" in body);
    assert.ok("confirmed_balance" in body);
    assert.ok("total_earned" in body);
    assert.ok("total_paid_out" in body);
  });

  it("GET /api/agents/:id/balance rejects access to other agent", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/other_agent_id/balance`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes("only view your own"));
  });

  // --- PATCH /api/agents/me ---

  it("PATCH /api/agents/me requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402_address: "0x1234567890abcdef1234567890abcdef12345678" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("PATCH /api/agents/me rejects invalid JSON", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: "bad-json",
    });
    assert.strictEqual(res.status, 400);
  });

  it("PATCH /api/agents/me rejects empty body", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("No updatable fields"));
  });

  it("PATCH /api/agents/me updates x402_address", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ x402_address: "0x1234567890abcdef1234567890abcdef12345678" }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.id, testAgentId);
    assert.strictEqual(body.x402_address, "0x1234567890abcdef1234567890abcdef12345678");
  });

  it("PATCH /api/agents/me clears x402_address with null", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ x402_address: null }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.x402_address, null);
  });

  // --- POST /api/agents/:id/payout ---

  it("POST /api/agents/:id/payout requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/${testAgentId}/payout`, {
      method: "POST",
    });
    assert.strictEqual(res.status, 401);
  });

  it("POST /api/agents/:id/payout rejects access to other agent", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/other_agent_id/payout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.strictEqual(res.status, 403);
  });

  it("POST /api/agents/:id/payout requires x402_address", async () => {
    // Clear the x402 address first
    await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ x402_address: null }),
    });

    const res = await fetch(`http://localhost:${serverPort}/api/agents/${testAgentId}/payout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.strictEqual(res.status, 402);
    const body = await res.json();
    assert.ok(body.error.includes("No x402 address"));
  });

  // --- POST /api/referral-codes ---

  it("POST /api/referral-codes requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", code: "TEST", referral_url: "https://railway.app" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("POST /api/referral-codes creates a code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({
        vendor: "Railway",
        code: "APITEST-RAILWAY",
        referral_url: "https://railway.app?ref=apitest",
        description: "Test referral code",
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(body.id.startsWith("code_"));
    assert.strictEqual(body.vendor, "Railway");
    assert.strictEqual(body.code, "APITEST-RAILWAY");
  });

  it("POST /api/referral-codes rejects missing vendor", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ code: "TEST", referral_url: "https://example.com" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("vendor"));
  });

  it("POST /api/referral-codes rejects missing code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ vendor: "Railway", referral_url: "https://example.com" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("code"));
  });

  it("POST /api/referral-codes rejects missing referral_url", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ vendor: "Railway", code: "TEST" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("referral_url"));
  });

  // --- GET /api/referral-codes/mine ---

  it("GET /api/referral-codes/mine requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/mine`);
    assert.strictEqual(res.status, 401);
  });

  it("GET /api/referral-codes/mine returns codes and metadata", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/mine`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.codes));
    assert.ok("trust_tier" in body);
    assert.ok("daily_submissions" in body);
    assert.ok("daily_limit" in body);
  });

  // --- PUT /api/referral-codes/:id ---

  it("PUT /api/referral-codes/:id requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/some_id`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "updated" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("PUT /api/referral-codes/:id returns 404 for nonexistent code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/nonexistent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
      body: JSON.stringify({ description: "updated" }),
    });
    assert.strictEqual(res.status, 404);
  });

  // --- DELETE /api/referral-codes/:id ---

  it("DELETE /api/referral-codes/:id requires auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/some_id`, {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 401);
  });

  it("DELETE /api/referral-codes/:id returns 404 for nonexistent code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/nonexistent`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.strictEqual(res.status, 404);
  });

  // --- GET /api/leaderboard ---

  it("GET /api/leaderboard returns leaderboard data", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/leaderboard`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.leaderboard));
    assert.ok("total" in body);
    assert.ok("limit" in body);
    assert.ok("offset" in body);
  });

  it("GET /api/leaderboard respects limit param", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/leaderboard?limit=5`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.limit, 5);
  });

  it("GET /api/leaderboard clamps limit to 50", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/leaderboard?limit=100`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.limit, 50);
  });

  it("GET /api/leaderboard has public cache header", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/leaderboard`);
    assert.ok(res.headers.get("cache-control")?.includes("public"));
  });
});
