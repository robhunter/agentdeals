import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const CLAWBACK_PATH = path.join(__dirname, "..", "data", "vendor_clawback.json");
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

const {
  recordConversion,
  confirmEligibleEntries,
  getAgentBalance,
  getAgentLedgerEntries,
  recordPayout,
  MINIMUM_PAYOUT_AMOUNT,
  resetLedgerCache,
} = await import("../dist/ledger.js");

const { resetReferralRequestsCache } = await import("../dist/referral-requests.js");
const { resetReferralCodesCache } = await import("../dist/referral-codes.js");
const { registerAgent, resetAgentsCache, updateAgentX402Address } = await import("../dist/agents.js");
const { validateX402Address, setTransferFn, resetTransferFn, generateCorrelationId } = await import("../dist/x402.js");

let origLedger: string | null = null;
let origBalances: string | null = null;
let origRequests: string | null = null;
let origCodes: string | null = null;
let origAgents: string | null = null;

function saveOriginals() {
  origLedger = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, "utf-8") : null;
  origBalances = fs.existsSync(BALANCES_PATH) ? fs.readFileSync(BALANCES_PATH, "utf-8") : null;
  origRequests = fs.existsSync(REQUESTS_PATH) ? fs.readFileSync(REQUESTS_PATH, "utf-8") : null;
  origCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf-8") : null;
  origAgents = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf-8") : null;
}

function restoreOriginals() {
  if (origLedger !== null) fs.writeFileSync(LEDGER_PATH, origLedger);
  else if (fs.existsSync(LEDGER_PATH)) fs.unlinkSync(LEDGER_PATH);
  if (origBalances !== null) fs.writeFileSync(BALANCES_PATH, origBalances);
  else if (fs.existsSync(BALANCES_PATH)) fs.unlinkSync(BALANCES_PATH);
  if (origRequests !== null) fs.writeFileSync(REQUESTS_PATH, origRequests);
  else if (fs.existsSync(REQUESTS_PATH)) fs.unlinkSync(REQUESTS_PATH);
  if (origCodes !== null) fs.writeFileSync(CODES_PATH, origCodes);
  else if (fs.existsSync(CODES_PATH)) fs.unlinkSync(CODES_PATH);
  if (origAgents !== null) fs.writeFileSync(AGENTS_PATH, origAgents);
  else if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetLedgerCache();
  resetReferralRequestsCache();
  resetReferralCodesCache();
  resetAgentsCache();
  resetTransferFn();
}

function resetFiles() {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: [] }), "utf-8");
  fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: [] }), "utf-8");
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  resetLedgerCache();
  resetReferralRequestsCache();
  resetReferralCodesCache();
  resetAgentsCache();
  resetTransferFn();
}

function writeSubmittedCode(opts: { agent_id: string; vendor: string; code: string }) {
  const raw = JSON.parse(fs.readFileSync(CODES_PATH, "utf-8"));
  const now = new Date().toISOString();
  raw.referral_codes.push({
    id: `code_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    vendor: opts.vendor,
    code: opts.code,
    referral_url: "https://example.com?ref=test",
    description: "",
    commission_rate: null,
    expiry: null,
    submitted_by: opts.agent_id,
    source: "agent-submitted",
    status: "active",
    trust_tier_at_submission: "new",
    impressions: 0,
    clicks: 0,
    conversions: 0,
    submitted_at: now,
    updated_at: now,
  });
  fs.writeFileSync(CODES_PATH, JSON.stringify(raw), "utf-8");
  resetReferralCodesCache();
}

function setupAgentWithBalance(name: string, confirmedAmount: number, x402Address?: string) {
  const result = registerAgent({ name });
  const agentId = result.agent.id;

  if (x402Address) {
    updateAgentX402Address(agentId, x402Address);
  }

  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 60);

  writeSubmittedCode({ agent_id: agentId, vendor: "Railway", code: "TEST_CODE" });

  const commission = Math.round((confirmedAmount / 0.4) * 100) / 100;
  recordConversion({
    vendor: "Railway",
    referral_code: "TEST_CODE",
    commission_amount: commission,
    conversion_date: pastDate.toISOString().split("T")[0],
  });

  resetLedgerCache();

  confirmEligibleEntries();

  return { agentId, apiKey: result.api_key };
}

before(() => saveOriginals());
after(() => restoreOriginals());
beforeEach(() => resetFiles());

describe("x402 address validation", () => {
  it("accepts valid Ethereum address", () => {
    const result = validateX402Address("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");
    assert.strictEqual(result.valid, true);
  });

  it("accepts valid Solana address", () => {
    const result = validateX402Address("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV");
    assert.strictEqual(result.valid, true);
  });

  it("rejects empty address", () => {
    const result = validateX402Address("");
    assert.strictEqual(result.valid, false);
  });

  it("rejects invalid format", () => {
    const result = validateX402Address("not-an-address");
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("Invalid address format"));
  });

  it("rejects Ethereum address with wrong length", () => {
    const result = validateX402Address("0x742d35Cc6634C0532925a3b8");
    assert.strictEqual(result.valid, false);
  });
});

describe("updateAgentX402Address", () => {
  it("sets x402 address on agent", () => {
    const result = registerAgent({ name: "TestBot" });
    assert.strictEqual(result.agent.x402_address, null);

    const updated = updateAgentX402Address(result.agent.id, "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");
    assert.strictEqual(updated.x402_address, "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");
  });

  it("clears x402 address when set to null", () => {
    const result = registerAgent({ name: "TestBot" });
    updateAgentX402Address(result.agent.id, "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");
    const cleared = updateAgentX402Address(result.agent.id, null);
    assert.strictEqual(cleared.x402_address, null);
  });

  it("throws for unknown agent", () => {
    assert.throws(() => updateAgentX402Address("agent_nonexistent", "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"), /Agent not found/);
  });
});

describe("recordPayout", () => {
  it("creates payout ledger entry and updates balance", () => {
    const { agentId } = setupAgentWithBalance("PayoutBot", 50, "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");

    const balanceBefore = getAgentBalance(agentId);
    assert.ok(balanceBefore);
    assert.strictEqual(balanceBefore.confirmed_balance, 50);

    const entry = recordPayout({
      agent_id: agentId,
      x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      tx_hash: "0xabc123",
      correlation_id: "payout_test_001",
    });

    assert.ok(entry.id.startsWith("le_"));
    assert.strictEqual(entry.event_type, "payout");
    assert.strictEqual(entry.status, "paid_out");
    assert.strictEqual(entry.agent_share, 50);
    assert.ok(entry.paid_out_at);
    assert.strictEqual((entry.metadata as any).tx_hash, "0xabc123");
    assert.strictEqual((entry.metadata as any).correlation_id, "payout_test_001");

    const balanceAfter = getAgentBalance(agentId);
    assert.ok(balanceAfter);
    assert.strictEqual(balanceAfter.confirmed_balance, 0);
    assert.strictEqual(balanceAfter.total_paid_out, 50);
  });

  it("throws when confirmed balance is below minimum", () => {
    const { agentId } = setupAgentWithBalance("SmallBot", 5);

    assert.throws(
      () => recordPayout({
        agent_id: agentId,
        x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
        correlation_id: "payout_test_002",
      }),
      /Insufficient confirmed balance/
    );
  });

  it("throws when agent has zero balance", () => {
    const result = registerAgent({ name: "ZeroBot" });

    assert.throws(
      () => recordPayout({
        agent_id: result.agent.id,
        x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
        correlation_id: "payout_test_003",
      }),
      /Insufficient confirmed balance/
    );
  });

  it("pays out full confirmed balance (no partial)", () => {
    const { agentId } = setupAgentWithBalance("FullBot", 100);

    const entry = recordPayout({
      agent_id: agentId,
      x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      correlation_id: "payout_test_004",
    });

    assert.strictEqual(entry.agent_share, 100);
    const balance = getAgentBalance(agentId);
    assert.ok(balance);
    assert.strictEqual(balance.confirmed_balance, 0);
    assert.strictEqual(balance.total_paid_out, 100);
  });

  it("payout is append-only in ledger", () => {
    const { agentId } = setupAgentWithBalance("AppendBot", 50);
    const entriesBefore = getAgentLedgerEntries(agentId);
    const countBefore = entriesBefore.length;

    recordPayout({
      agent_id: agentId,
      x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      correlation_id: "payout_test_005",
    });

    const entriesAfter = getAgentLedgerEntries(agentId);
    assert.strictEqual(entriesAfter.length, countBefore + 1);
    const payoutEntry = entriesAfter.find(e => e.event_type === "payout");
    assert.ok(payoutEntry);
  });
});

describe("x402 transfer mock", () => {
  it("successful transfer records payout", async () => {
    const { agentId } = setupAgentWithBalance("TransferBot", 50, "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18");

    setTransferFn(async (req) => ({
      success: true,
      tx_hash: "0xmocktx123",
      chain: "base",
      token: "USDC",
      correlation_id: req.correlation_id,
    }));

    const { executeTransfer } = await import("../dist/x402.js");
    const correlationId = generateCorrelationId();
    const result = await executeTransfer({
      to_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      amount: 50,
      correlation_id: correlationId,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.tx_hash, "0xmocktx123");
    assert.strictEqual(result.chain, "base");

    const entry = recordPayout({
      agent_id: agentId,
      x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      tx_hash: result.tx_hash,
      correlation_id: correlationId,
    });

    assert.strictEqual(entry.event_type, "payout");
    assert.strictEqual((entry.metadata as any).tx_hash, "0xmocktx123");
  });

  it("failed transfer does not record payout", async () => {
    const { agentId } = setupAgentWithBalance("FailBot", 50);

    setTransferFn(async (req) => ({
      success: false,
      error: "Insufficient gas",
      correlation_id: req.correlation_id,
    }));

    const { executeTransfer } = await import("../dist/x402.js");
    const result = await executeTransfer({
      to_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      amount: 50,
      correlation_id: "test_fail",
    });

    assert.strictEqual(result.success, false);

    const balance = getAgentBalance(agentId);
    assert.ok(balance);
    assert.strictEqual(balance.confirmed_balance, 50);
    assert.strictEqual(balance.total_paid_out, 0);
  });
});

describe("generateCorrelationId", () => {
  it("generates unique IDs with payout_ prefix", () => {
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();
    assert.ok(id1.startsWith("payout_"));
    assert.ok(id2.startsWith("payout_"));
    assert.notStrictEqual(id1, id2);
  });
});

describe("payout endpoint integration", () => {
  it("MINIMUM_PAYOUT_AMOUNT is $10", () => {
    assert.strictEqual(MINIMUM_PAYOUT_AMOUNT, 10);
  });

  it("cannot payout pending balance (only confirmed)", () => {
    const result = registerAgent({ name: "PendingBot" });
    const agentId = result.agent.id;

    writeSubmittedCode({ agent_id: agentId, vendor: "Railway", code: "TEST_CODE" });

    recordConversion({
      vendor: "Railway",
      referral_code: "TEST_CODE",
      commission_amount: 100,
    });

    const balance = getAgentBalance(agentId);
    assert.ok(balance);
    assert.ok(balance.pending_balance > 0);
    assert.strictEqual(balance.confirmed_balance, 0);

    assert.throws(
      () => recordPayout({
        agent_id: agentId,
        x402_address: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
        correlation_id: "payout_pending_test",
      }),
      /Insufficient confirmed balance/
    );
  });
});
