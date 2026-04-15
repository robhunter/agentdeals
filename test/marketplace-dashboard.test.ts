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

// Save/restore originals
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
    }, 10000);

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

// Pre-create a test agent with known API key before the server starts
const { registerAgent, resetAgentsCache } = await import("../dist/agents.js");
const { resetReferralCodesCache, submitReferralCode } = await import("../dist/referral-codes.js");
const { resetLedgerCache, recordConversion } = await import("../dist/ledger.js");

describe("Marketplace Page", () => {
  before(async () => {
    saveOriginals();
    serverProc = await startHttpServer();
  });

  after(() => {
    serverProc?.kill();
    restoreOriginals();
  });

  it("GET /marketplace returns 200 with HTML", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const html = await res.text();
    assert.ok(html.includes("Agent Marketplace"));
  });

  it("marketplace page has JSON-LD schema", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("application/ld+json"));
    assert.ok(html.includes('"@type":"WebPage"'));
  });

  it("marketplace page has canonical URL", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes('rel="canonical"'));
    assert.ok(html.includes("/marketplace"));
  });

  it("marketplace page explains trust tiers", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("Trust Tiers"));
    assert.ok(html.includes("verified"));
    assert.ok(html.includes("trusted"));
  });

  it("marketplace page explains revenue splits", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("Revenue Splits"));
    assert.ok(html.includes("70%"));
    assert.ok(html.includes("80%"));
    assert.ok(html.includes("40%"));
  });

  it("marketplace page has registration instructions with curl example", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("/api/agents/register"));
    assert.ok(html.includes("curl"));
  });

  it("marketplace page explains code ranking", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("Code Ranking"));
    assert.ok(html.includes("Trust weight"));
    assert.ok(html.includes("Conversion rate"));
  });

  it("marketplace page links to disclosure", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("/disclosure"));
  });

  it("marketplace page is mobile-responsive", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes("viewport"));
    assert.ok(html.includes("max-width:768px"));
  });

  it("marketplace page has global nav with Marketplace active", async () => {
    const res = await fetch(`http://localhost:${serverPort}/marketplace`);
    const html = await res.text();
    assert.ok(html.includes('class="global-nav"'));
  });
});

describe("Agent Dashboard", () => {
  let testApiKey: string;
  let testAgentId: string;

  before(async () => {
    saveOriginals();
    // Reset data files for clean state
    fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
    fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
    fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: [] }), "utf-8");
    fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: [] }), "utf-8");
    fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
    resetAgentsCache();
    resetReferralCodesCache();
    resetLedgerCache();

    // Create a test agent
    const result = registerAgent({ name: "DashboardTestBot" });
    testApiKey = result.api_key;
    testAgentId = result.agent.id;

    // Submit a referral code for this agent
    submitReferralCode({
      vendor: "Railway",
      code: "TESTCODE",
      referral_url: "https://railway.app?ref=test",
      description: "Test code",
      agent_id: testAgentId,
      trust_tier: "new",
    });

    // Start server after data setup
    serverProc = await startHttpServer();
  });

  after(() => {
    serverProc?.kill();
    restoreOriginals();
    resetAgentsCache();
    resetReferralCodesCache();
    resetLedgerCache();
  });

  it("GET /agents/dashboard without key returns 401", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard`);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.includes("API key required"));
  });

  it("GET /agents/dashboard with invalid key returns 401", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=invalid_key`);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.includes("Invalid API key"));
  });

  it("GET /agents/dashboard with valid key returns 200 HTML", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const html = await res.text();
    assert.ok(html.includes("DashboardTestBot"));
  });

  it("dashboard shows agent trust tier", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("tier-new") || html.includes("tier-verified") || html.includes("tier-trusted"));
  });

  it("dashboard shows balance information", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("Current Balance"));
    assert.ok(html.includes("Total Earned"));
  });

  it("dashboard shows x402 address status", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("x402 Address"));
    assert.ok(html.includes("Not set") || html.includes("Configured"));
  });

  it("dashboard lists submitted referral codes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("My Referral Codes"));
    assert.ok(html.includes("Railway"));
  });

  it("dashboard shows performance section with leaderboard rank", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("Leaderboard Rank"));
    assert.ok(html.includes("7-Day Trend"));
    assert.ok(html.includes("Active Codes"));
  });

  it("dashboard shows quick actions", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("Quick Actions"));
    assert.ok(html.includes("Submit a Code"));
  });

  it("dashboard has noindex meta tag (private page)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes('name="robots" content="noindex"'));
  });

  it("dashboard has private cache control", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    assert.ok(res.headers.get("cache-control")?.includes("private"));
  });

  it("dashboard is mobile-responsive", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("viewport"));
    assert.ok(html.includes("max-width:768px"));
  });

  it("dashboard shows registration date", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("Registered"));
  });

  it("dashboard links to marketplace", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agents/dashboard?key=${testApiKey}`);
    const html = await res.text();
    assert.ok(html.includes("/marketplace"));
  });
});

describe("Marketplace in Sitemap", () => {
  before(async () => {
    if (!serverProc || serverProc.killed) {
      serverProc = await startHttpServer();
    }
  });

  after(() => {
    serverProc?.kill();
  });

  it("sitemap includes /marketplace", async () => {
    const res = await fetch(`http://localhost:${serverPort}/sitemap-pages.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("/marketplace"));
  });
});
