import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const CLAWBACK_PATH = path.join(__dirname, "..", "data", "vendor_clawback.json");
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");
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

const { resetReferralCodesCache } = await import("../dist/referral-codes.js");
const { registerAgent, resetAgentsCache } = await import("../dist/agents.js");

// Save original data
let origLedger: string | null = null;
let origBalances: string | null = null;
let origCodes: string | null = null;
let origAgents: string | null = null;

function saveOriginals() {
  origLedger = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, "utf-8") : null;
  origBalances = fs.existsSync(BALANCES_PATH) ? fs.readFileSync(BALANCES_PATH, "utf-8") : null;
  origCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf-8") : null;
  origAgents = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf-8") : null;
}

function restoreOriginals() {
  if (origLedger !== null) fs.writeFileSync(LEDGER_PATH, origLedger);
  else if (fs.existsSync(LEDGER_PATH)) fs.unlinkSync(LEDGER_PATH);
  if (origBalances !== null) fs.writeFileSync(BALANCES_PATH, origBalances);
  else if (fs.existsSync(BALANCES_PATH)) fs.unlinkSync(BALANCES_PATH);
  if (origCodes !== null) fs.writeFileSync(CODES_PATH, origCodes);
  else if (fs.existsSync(CODES_PATH)) fs.unlinkSync(CODES_PATH);
  if (origAgents !== null) fs.writeFileSync(AGENTS_PATH, origAgents);
  else if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetLedgerCache();
  resetReferralCodesCache();
  resetAgentsCache();
}

function resetFiles() {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: [] }), "utf-8");
  fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: [] }), "utf-8");
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  resetLedgerCache();
  resetReferralCodesCache();
  resetAgentsCache();
}

/**
 * Write a submission record straight to the store, so a conversion reported
 * against this code resolves to this agent. Bypasses submitReferralCode's
 * offers-index check, which lets these tests keep using a vendor that is
 * deliberately absent from the index to exercise the default clawback window.
 */
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

  it("credits no agent when the code is not one an agent submitted", () => {
    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "TESTCODE",
      commission_amount: 100.00,
    });
    assert.strictEqual(entry.agent_share, 0);
    assert.strictEqual(entry.agent_id, null);
  });

  it("credits the submitting agent 40% of the commission", () => {
    const result = registerAgent({ name: "TestBot" });
    writeSubmittedCode({ agent_id: result.agent.id, vendor: "Railway", code: "TESTCODE" });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "TESTCODE",
      commission_amount: 100.00,
    });

    assert.strictEqual(entry.agent_id, result.agent.id);
    assert.strictEqual(entry.agent_share, 40.00);
  });

  it("calculates the submitter share correctly for various amounts", () => {
    const agent = registerAgent({ name: "ShareBot" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE" });

    const entry1 = recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 1.00 });
    assert.strictEqual(entry1.agent_share, 0.40);

    resetFiles();
    const agent2 = registerAgent({ name: "ShareBot2" });
    writeSubmittedCode({ agent_id: agent2.agent.id, vendor: "Railway", code: "CODE" });

    const entry2 = recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 33.33 });
    assert.strictEqual(entry2.agent_share, 13.33);
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

  it("updates the submitting agent's pending balance on conversion", () => {
    const agent = registerAgent({ name: "BalanceBot" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE" });

    recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 100.00 });

    const balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 40.00);
    assert.strictEqual(balance.confirmed_balance, 0);
    assert.strictEqual(balance.total_earned, 0);
    assert.strictEqual(balance.total_paid_out, 0);
  });

  it("credits no agent when the conversion names no code at all", () => {
    const agent = registerAgent({ name: "EmptyCodeBot" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "" });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "",
      commission_amount: 100.00,
    });

    assert.strictEqual(entry.agent_id, null);
    assert.strictEqual(entry.agent_share, 0);
    assert.strictEqual(getAgentBalance(agent.agent.id), null);
  });

  it("records conversion with null agent_id when no agent submitted the code", () => {
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
      metadata: { source: "manual", recorded_by: "platform" },
    });
    assert.deepStrictEqual(entry.metadata, { source: "manual", recorded_by: "platform" });
  });
});

describe("Confirm Eligible Entries", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("confirms entries past clawback window", () => {
    const agent = registerAgent({ name: "ConfirmBot" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "UnknownVendor", code: "CODE" });

    // Create a conversion with clawback ending March 31
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
    assert.strictEqual(balance.confirmed_balance, 40.00);
    assert.strictEqual(balance.total_earned, 40.00);
  });

  it("does not confirm entries still in clawback window", () => {
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
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "UnknownVendor", code: "CODE" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "UnknownVendor", code: "CODE2" });

    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE", commission_amount: 50.00, conversion_date: "2026-03-01" });
    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE2", commission_amount: 50.00, conversion_date: "2026-03-01" });

    let balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 40.00); // 20 + 20

    const confirmed = confirmEligibleEntries(new Date("2026-04-02"));
    assert.strictEqual(confirmed.length, 2);

    balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 0);
    assert.strictEqual(balance.confirmed_balance, 40.00);
    assert.strictEqual(balance.total_earned, 40.00);
  });
});

describe("Clawback Entry", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("claws back a pending entry", () => {
    const agent = registerAgent({ name: "ClawBot" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE" });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "CODE",
      commission_amount: 100.00,
    });

    let balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 40.00);

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
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "UnknownVendor", code: "CODE" });

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
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE2" });

    recordConversion({ vendor: "Railway", referral_code: "CODE", commission_amount: 100.00 });
    recordConversion({ vendor: "Railway", referral_code: "CODE2", commission_amount: 200.00 });

    const balance = getAgentBalance(agent.agent.id);
    assert.ok(balance);
    assert.strictEqual(balance.pending_balance, 120.00); // 40 + 80
  });
});

describe("Ledger Entry Queries", () => {
  beforeEach(() => {
    resetFiles();
  });

  it("returns all entries for an agent", () => {
    const agent = registerAgent({ name: "QueryBot" });
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE" });
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
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "UnknownVendor", code: "CODE" });
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
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "Railway", code: "CODE" });

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
    writeSubmittedCode({ agent_id: agent.agent.id, vendor: "UnknownVendor", code: "CODE" });

    recordConversion({ vendor: "UnknownVendor", referral_code: "CODE", commission_amount: 100.00, conversion_date: "2026-03-01" });
    confirmEligibleEntries(new Date("2026-04-02"));

    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
    const confirmEvents = raw.ledger_entries.filter((e: any) => e.event_type === "confirmation");
    assert.strictEqual(confirmEvents.length, 1);
  });
});
