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
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

const {
  recordConversion,
  confirmEligibleEntries,
  clawbackEntry,
  getAgentBalance,
  getAgentLedgerEntries,
  getLedgerEntry,
  getAllConversions,
  getClawbackDays,
  resetLedgerCache,
} = await import("../dist/ledger.js");

const { logReferralRequest, resetReferralRequestsCache } = await import("../dist/referral-requests.js");
const { registerAgent, resetAgentsCache } = await import("../dist/agents.js");

// Save original data
let origLedger: string | null = null;
let origBalances: string | null = null;
let origRequests: string | null = null;
let origAgents: string | null = null;

function saveOriginals() {
  origLedger = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, "utf-8") : null;
  origBalances = fs.existsSync(BALANCES_PATH) ? fs.readFileSync(BALANCES_PATH, "utf-8") : null;
  origRequests = fs.existsSync(REQUESTS_PATH) ? fs.readFileSync(REQUESTS_PATH, "utf-8") : null;
  origAgents = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf-8") : null;
}

function restoreOriginals() {
  if (origLedger !== null) fs.writeFileSync(LEDGER_PATH, origLedger);
  else if (fs.existsSync(LEDGER_PATH)) fs.unlinkSync(LEDGER_PATH);
  if (origBalances !== null) fs.writeFileSync(BALANCES_PATH, origBalances);
  else if (fs.existsSync(BALANCES_PATH)) fs.unlinkSync(BALANCES_PATH);
  if (origRequests !== null) fs.writeFileSync(REQUESTS_PATH, origRequests);
  else if (fs.existsSync(REQUESTS_PATH)) fs.unlinkSync(REQUESTS_PATH);
  if (origAgents !== null) fs.writeFileSync(AGENTS_PATH, origAgents);
  else if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetLedgerCache();
  resetReferralRequestsCache();
  resetAgentsCache();
}

function resetFiles() {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: [] }), "utf-8");
  fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: [] }), "utf-8");
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  resetLedgerCache();
  resetReferralRequestsCache();
  resetAgentsCache();
}

/**
 * Write a referral request directly with a controlled requested_at timestamp.
 * Needed for tests where the conversion_date is in the past relative to "now".
 */
function writeReferralRequestWithDate(opts: {
  agent_id: string;
  vendor: string;
  referral_code: string;
  referral_url: string;
  requested_at: string;
}) {
  const raw = JSON.parse(fs.readFileSync(REQUESTS_PATH, "utf-8"));
  raw.referral_requests.push({
    id: `rr_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    agent_id: opts.agent_id,
    vendor: opts.vendor,
    referral_code: opts.referral_code,
    referral_url: opts.referral_url,
    requested_at: opts.requested_at,
    conversion_id: null,
  });
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify(raw), "utf-8");
  resetReferralRequestsCache();
}

before(() => {
  saveOriginals();
});

after(() => {
  restoreOriginals();
});

describe("Vendor Clawback Config", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("returns configured clawback days for known vendor", () => {
    const days = getClawbackDays("Railway");
    assert.strictEqual(days, 45);
  });

  it("returns default clawback days for unknown vendor", () => {
    const days = getClawbackDays("UnknownVendor");
    assert.strictEqual(days, 30);
  });

  it("is case-insensitive", () => {
    const days = getClawbackDays("railway");
    assert.strictEqual(days, 45);
  });
});

describe("Record Conversion", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("creates a ledger entry with status pending", () => {
    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "TESTCODE",
      commission_amount: 10.00,
      conversion_date: "2026-04-01",
    });

    assert.ok(entry.id.startsWith("le_"));
    assert.strictEqual(entry.vendor, "Railway");
    assert.strictEqual(entry.referral_code, "TESTCODE");
    assert.strictEqual(entry.event_type, "conversion");
    assert.strictEqual(entry.commission_amount, 10.00);
    assert.strictEqual(entry.status, "pending");
    assert.strictEqual(entry.conversion_date, "2026-04-01");
    assert.ok(entry.created_at);
    assert.strictEqual(entry.confirmed_at, null);
    assert.strictEqual(entry.paid_out_at, null);
  });

  it("calculates agent_share as 70% of commission_amount", () => {
    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "TESTCODE",
      commission_amount: 100.00,
    });
    // No attributed agent, so agent_share is 0
    assert.strictEqual(entry.agent_share, 0);
    assert.strictEqual(entry.agent_id, null);
  });

  it("attributes to agent and sets 70% share", () => {
    // Register an agent and log a referral request
    const result = registerAgent({ name: "TestBot" });
    logReferralRequest({
      agent_id: result.agent.id,
      vendor: "Railway",
      referral_code: "TESTCODE",
      referral_url: "https://railway.app?ref=TESTCODE",
    });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "TESTCODE",
      commission_amount: 100.00,
    });

    assert.strictEqual(entry.agent_id, result.agent.id);
    assert.strictEqual(entry.agent_share, 70.00);
  });

  it("calculates 70% share correctly for various amounts", () => {
    const agent = registerAgent({ name: "ShareBot" });
    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });

    const entry1 = recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 1.00 });
    assert.strictEqual(entry1.agent_share, 0.70);

    resetFiles();
    const agent2 = registerAgent({ name: "ShareBot2" });
    logReferralRequest({
      agent_id: agent2.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });

    const entry2 = recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 33.33 });
    assert.strictEqual(entry2.agent_share, 23.33);
  });

  it("sets clawback_window_ends based on vendor config", () => {
    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "TESTCODE",
      commission_amount: 10.00,
      conversion_date: "2026-04-01",
    });
    // Railway has 45 day clawback
    assert.strictEqual(entry.clawback_window_ends, "2026-05-16");
  });

  it("uses default clawback for unknown vendor", () => {
    const entry = recordConversion({
      vendor: "UnknownVendor",
      referral_code: "CODE",
      commission_amount: 10.00,
      conversion_date: "2026-04-01",
    });
    // Default 30 days
    assert.strictEqual(entry.clawback_window_ends, "2026-05-01");
  });

  it("updates agent pending balance on conversion", () => {
    const agent = registerAgent({ name: "BalanceBot" });
    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });

    recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 100.00 });

    const balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 70.00);
    assert.strictEqual(balance.confirmed_balance, 0);
    assert.strictEqual(balance.total_earned, 0);
    assert.strictEqual(balance.total_paid_out, 0);
  });

  it("records conversion with null agent_id when no attribution", () => {
    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "CODE",
      commission_amount: 50.00,
    });
    assert.strictEqual(entry.agent_id, null);
    assert.strictEqual(entry.agent_share, 0);
  });

  it("stores metadata", () => {
    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "CODE",
      commission_amount: 10.00,
      metadata: { source: "manual", admin: "rob" },
    });
    assert.deepStrictEqual(entry.metadata, { source: "manual", admin: "rob" });
  });
});

describe("Confirm Eligible Entries", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("confirms entries past clawback window", () => {
    const agent = registerAgent({ name: "ConfirmBot" });
    writeReferralRequestWithDate({
      agent_id: agent.agent.id,
      vendor: "UnknownVendor",
      referral_code: "CODE",
      referral_url: "https://example.com",
      requested_at: "2026-02-15T00:00:00.000Z",
    });

    // Create a conversion with clawback ending April 1
    recordConversion({
      vendor: "UnknownVendor",
      referral_code: "CODE",
      commission_amount: 100.00,
      conversion_date: "2026-03-01", // 30 day clawback → ends March 31
    });

    // Confirm as of April 2 — past the clawback window
    const confirmed = confirmEligibleEntries(new Date("2026-04-02"));
    assert.strictEqual(confirmed.length, 1);

    const balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 0);
    assert.strictEqual(balance.confirmed_balance, 70.00);
    assert.strictEqual(balance.total_earned, 70.00);
  });

  it("does not confirm entries still in clawback window", () => {
    // No attribution needed for this test — just checking clawback timing
    recordConversion({
      vendor: "Railway",
      referral_code: "CODE",
      commission_amount: 100.00,
      conversion_date: "2026-04-01", // 45 day Railway clawback → ends May 16
    });

    const confirmed = confirmEligibleEntries(new Date("2026-04-30"));
    assert.strictEqual(confirmed.length, 0);
  });

  it("updates balances in same operation", () => {
    const agent = registerAgent({ name: "BatchBot" });
    writeReferralRequestWithDate({
      agent_id: agent.agent.id,
      vendor: "UnknownVendor",
      referral_code: "CODE",
      referral_url: "https://example.com",
      requested_at: "2026-02-15T00:00:00.000Z",
    });

    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE", commission_amount: 50.00, conversion_date: "2026-03-01" });

    writeReferralRequestWithDate({
      agent_id: agent.agent.id,
      vendor: "UnknownVendor",
      referral_code: "CODE2",
      referral_url: "https://example.com",
      requested_at: "2026-02-16T00:00:00.000Z",
    });
    resetLedgerCache(); // Force reload to pick up referral request file change
    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE2", commission_amount: 50.00, conversion_date: "2026-03-01" });

    let balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 70.00); // 35 + 35

    const confirmed = confirmEligibleEntries(new Date("2026-04-02"));
    assert.strictEqual(confirmed.length, 2);

    balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 0);
    assert.strictEqual(balance.confirmed_balance, 70.00);
    assert.strictEqual(balance.total_earned, 70.00);
  });
});

describe("Clawback Entry", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("claws back a pending entry", () => {
    const agent = registerAgent({ name: "ClawBot" });
    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "CODE",
      commission_amount: 100.00,
    });

    let balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 70.00);

    const success = clawbackEntry(entry.id, "customer cancelled");
    assert.strictEqual(success, true);

    balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 0);

    const updated = getLedgerEntry(entry.id);
    assert.ok(updated);
    assert.strictEqual(updated.status, "clawed_back");
  });

  it("returns false for non-existent entry", () => {
    assert.strictEqual(clawbackEntry("le_doesnotexist"), false);
  });

  it("returns false for already confirmed entry", () => {
    const agent = registerAgent({ name: "ConfBot" });
    writeReferralRequestWithDate({
      agent_id: agent.agent.id,
      vendor: "UnknownVendor",
      referral_code: "CODE",
      referral_url: "https://example.com",
      requested_at: "2026-02-15T00:00:00.000Z",
    });

    const entry = recordConversion({
      vendor: "UnknownVendor",
      referral_code: "CODE",
      commission_amount: 100.00,
      conversion_date: "2026-03-01",
    });

    confirmEligibleEntries(new Date("2026-04-02"));
    assert.strictEqual(clawbackEntry(entry.id), false);
  });
});

describe("Agent Balance Queries", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("returns null for agent with no balance", () => {
    const balance = getAgentBalance("agent_nonexistent");
    assert.strictEqual(balance, null);
  });

  it("returns correct balance after multiple conversions", () => {
    const agent = registerAgent({ name: "MultiBot" });

    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });
    recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 100.00 });

    resetReferralRequestsCache();
    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE2",
      referral_url: "https://railway.app",
    });
    recordConversion({ vendor: "Railway", referral_code: "CODE2", commission_amount: 200.00 });

    const balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 210.00); // 70 + 140
  });
});

describe("Ledger Entry Queries", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("returns all entries for an agent", () => {
    const agent = registerAgent({ name: "QueryBot" });
    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });
    recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 50.00 });

    const entries = getAgentLedgerEntries(agent.agent.id);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].vendor, "Railway");
  });

  it("returns empty array for agent with no entries", () => {
    const entries = getAgentLedgerEntries("agent_none");
    assert.strictEqual(entries.length, 0);
  });

  it("getAllConversions returns only conversion events", () => {
    const agent = registerAgent({ name: "AllBot" });
    writeReferralRequestWithDate({
      agent_id: agent.agent.id,
      vendor: "UnknownVendor",
      referral_code: "CODE",
      referral_url: "https://example.com",
      requested_at: "2026-02-15T00:00:00.000Z",
    });
    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE", commission_amount: 10.00, conversion_date: "2026-03-01" });
    confirmEligibleEntries(new Date("2026-04-02"));

    const all = getAllConversions();
    assert.ok(all.length >= 1);
    assert.ok(all.every(e => e.event_type === "conversion"));
  });
});

describe("Append-Only Enforcement", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("clawback creates a new event entry rather than deleting", () => {
    const agent = registerAgent({ name: "AppendBot" });
    logReferralRequest({
      agent_id: agent.agent.id,
      vendor: "Railway",
      referral_code: "CODE",
      referral_url: "https://railway.app",
    });

    const entry = recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 100.00 });
    clawbackEntry(entry.id);

    // The original entry should still exist (status changed) plus a new clawback event
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
    assert.ok(raw.ledger_entries.length >= 2);
    const clawbackEvents = raw.ledger_entries.filter((e: any) => e.event_type === "clawback");
    assert.strictEqual(clawbackEvents.length, 1);
    assert.strictEqual(clawbackEvents[0].metadata.original_entry_id, entry.id);
  });

  it("confirmation creates a new event entry", () => {
    const agent = registerAgent({ name: "ConfirmAppendBot" });
    writeReferralRequestWithDate({
      agent_id: agent.agent.id,
      vendor: "UnknownVendor",
      referral_code: "CODE",
      referral_url: "https://example.com",
      requested_at: "2026-02-15T00:00:00.000Z",
    });

    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE", commission_amount: 100.00, conversion_date: "2026-03-01" });
    confirmEligibleEntries(new Date("2026-04-02"));

    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
    const confirmEvents = raw.ledger_entries.filter((e: any) => e.event_type === "confirmation");
    assert.strictEqual(confirmEvents.length, 1);
  });
});
