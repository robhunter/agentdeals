import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { attributeConversion, markConversion, getRequestsByAgent } from "./referral-requests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const CLAWBACK_CONFIG_PATH = path.join(__dirname, "..", "data", "vendor_clawback.json");

// Revenue split: 70% to agent, 30% to AgentDeals
const AGENT_SHARE_RATE = 0.7;

export type EventType = "conversion" | "confirmation" | "clawback" | "payout";
export type LedgerStatus = "pending" | "confirmed" | "paid_out" | "clawed_back";

export interface LedgerEntry {
  id: string;
  agent_id: string | null;
  vendor: string;
  referral_code: string;
  event_type: EventType;
  commission_amount: number;
  agent_share: number;
  status: LedgerStatus;
  conversion_date: string;
  clawback_window_ends: string;
  confirmed_at: string | null;
  paid_out_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface AgentBalance {
  agent_id: string;
  pending_balance: number;
  confirmed_balance: number;
  total_earned: number;
  total_paid_out: number;
  updated_at: string;
}

export interface VendorClawbackConfig {
  vendor: string;
  clawback_days: number;
}

// --- Caches ---
let cachedLedger: LedgerEntry[] | null = null;
let cachedBalances: AgentBalance[] | null = null;
let cachedClawbackConfig: VendorClawbackConfig[] | null = null;

// --- Load/Save helpers ---

function loadLedger(): LedgerEntry[] {
  if (cachedLedger) return cachedLedger;
  if (!fs.existsSync(LEDGER_PATH)) {
    cachedLedger = [];
    return cachedLedger;
  }
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf-8");
    const data = JSON.parse(raw) as { ledger_entries?: LedgerEntry[] };
    cachedLedger = Array.isArray(data.ledger_entries) ? data.ledger_entries : [];
  } catch {
    cachedLedger = [];
  }
  return cachedLedger;
}

function saveLedger(entries: LedgerEntry[]): void {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: entries }, null, 2), "utf-8");
  cachedLedger = entries;
}

function loadBalances(): AgentBalance[] {
  if (cachedBalances) return cachedBalances;
  if (!fs.existsSync(BALANCES_PATH)) {
    cachedBalances = [];
    return cachedBalances;
  }
  try {
    const raw = fs.readFileSync(BALANCES_PATH, "utf-8");
    const data = JSON.parse(raw) as { agent_balances?: AgentBalance[] };
    cachedBalances = Array.isArray(data.agent_balances) ? data.agent_balances : [];
  } catch {
    cachedBalances = [];
  }
  return cachedBalances;
}

function saveBalances(balances: AgentBalance[]): void {
  fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: balances }, null, 2), "utf-8");
  cachedBalances = balances;
}

function loadClawbackConfig(): VendorClawbackConfig[] {
  if (cachedClawbackConfig) return cachedClawbackConfig;
  if (!fs.existsSync(CLAWBACK_CONFIG_PATH)) {
    cachedClawbackConfig = [];
    return cachedClawbackConfig;
  }
  try {
    const raw = fs.readFileSync(CLAWBACK_CONFIG_PATH, "utf-8");
    const data = JSON.parse(raw) as { vendors?: VendorClawbackConfig[] };
    cachedClawbackConfig = Array.isArray(data.vendors) ? data.vendors : [];
  } catch {
    cachedClawbackConfig = [];
  }
  return cachedClawbackConfig;
}

export function resetLedgerCache(): void {
  cachedLedger = null;
  cachedBalances = null;
  cachedClawbackConfig = null;
}

// --- ID generation ---

function generateLedgerId(): string {
  return `le_${randomBytes(16).toString("hex")}`;
}

// --- Clawback config ---

const DEFAULT_CLAWBACK_DAYS = 30;

export function getClawbackDays(vendor: string): number {
  const config = loadClawbackConfig();
  const entry = config.find(c => c.vendor.toLowerCase() === vendor.toLowerCase());
  return entry ? entry.clawback_days : DEFAULT_CLAWBACK_DAYS;
}

// --- Balance helpers ---

function getOrCreateBalance(agentId: string): AgentBalance {
  const balances = loadBalances();
  let balance = balances.find(b => b.agent_id === agentId);
  if (!balance) {
    balance = {
      agent_id: agentId,
      pending_balance: 0,
      confirmed_balance: 0,
      total_earned: 0,
      total_paid_out: 0,
      updated_at: new Date().toISOString(),
    };
    balances.push(balance);
  }
  return balance;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Core operations ---

/**
 * Record a new conversion. Looks up attribution, creates a ledger entry with
 * status "pending", and updates the agent's pending balance.
 */
export function recordConversion(opts: {
  vendor: string;
  referral_code: string;
  commission_amount: number;
  conversion_date?: string;
  metadata?: Record<string, unknown>;
}): LedgerEntry {
  const conversionDate = opts.conversion_date
    ? new Date(opts.conversion_date)
    : new Date();
  const conversionDateStr = conversionDate.toISOString().split("T")[0];

  // Look up attribution
  const agentId = attributeConversion(opts.vendor, conversionDate);

  const agentShare = roundCents(opts.commission_amount * AGENT_SHARE_RATE);
  const clawbackDays = getClawbackDays(opts.vendor);
  const clawbackEnd = new Date(conversionDate);
  clawbackEnd.setDate(clawbackEnd.getDate() + clawbackDays);

  const entry: LedgerEntry = {
    id: generateLedgerId(),
    agent_id: agentId,
    vendor: opts.vendor,
    referral_code: opts.referral_code,
    event_type: "conversion",
    commission_amount: roundCents(opts.commission_amount),
    agent_share: agentId ? agentShare : 0,
    status: "pending",
    conversion_date: conversionDateStr,
    clawback_window_ends: clawbackEnd.toISOString().split("T")[0],
    confirmed_at: null,
    paid_out_at: null,
    created_at: new Date().toISOString(),
    metadata: opts.metadata ?? {},
  };

  // Append to ledger (append-only)
  const ledger = loadLedger();
  ledger.push(entry);
  saveLedger(ledger);

  // Update agent balance if attributed
  if (agentId) {
    const balance = getOrCreateBalance(agentId);
    balance.pending_balance = roundCents(balance.pending_balance + agentShare);
    balance.updated_at = new Date().toISOString();
    saveBalances(loadBalances());

    // Mark the referral request as converted
    const requests = getRequestsByAgent(agentId);
    const vendorLower = opts.vendor.toLowerCase();
    const matchingRequest = requests
      .filter(r => r.vendor.toLowerCase() === vendorLower && !r.conversion_id)
      .sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime())[0];
    if (matchingRequest) {
      markConversion(matchingRequest.id, entry.id);
    }
  }

  return entry;
}

/**
 * Confirm all pending entries whose clawback window has passed.
 * Moves them from pending to confirmed and shifts balance accordingly.
 * Returns the list of confirmed entry IDs.
 */
export function confirmEligibleEntries(asOfDate?: Date): string[] {
  const now = asOfDate ?? new Date();
  const nowStr = now.toISOString().split("T")[0];
  const ledger = loadLedger();
  const confirmed: string[] = [];

  for (const entry of ledger) {
    if (entry.status !== "pending") continue;
    if (entry.clawback_window_ends > nowStr) continue;

    // Create a confirmation event (append-only)
    const confirmEntry: LedgerEntry = {
      id: generateLedgerId(),
      agent_id: entry.agent_id,
      vendor: entry.vendor,
      referral_code: entry.referral_code,
      event_type: "confirmation",
      commission_amount: entry.commission_amount,
      agent_share: entry.agent_share,
      status: "confirmed",
      conversion_date: entry.conversion_date,
      clawback_window_ends: entry.clawback_window_ends,
      confirmed_at: new Date().toISOString(),
      paid_out_at: null,
      created_at: new Date().toISOString(),
      metadata: { original_entry_id: entry.id },
    };
    ledger.push(confirmEntry);

    // Update original entry status
    entry.status = "confirmed";
    entry.confirmed_at = new Date().toISOString();
    confirmed.push(entry.id);

    // Update balance
    if (entry.agent_id) {
      const balance = getOrCreateBalance(entry.agent_id);
      balance.pending_balance = roundCents(balance.pending_balance - entry.agent_share);
      balance.confirmed_balance = roundCents(balance.confirmed_balance + entry.agent_share);
      balance.total_earned = roundCents(balance.total_earned + entry.agent_share);
      balance.updated_at = new Date().toISOString();
    }
  }

  if (confirmed.length > 0) {
    saveLedger(ledger);
    saveBalances(loadBalances());
  }

  return confirmed;
}

/**
 * Clawback a pending entry. Marks it as clawed_back and deducts from pending balance.
 * Returns true if successful.
 */
export function clawbackEntry(entryId: string, reason?: string): boolean {
  const ledger = loadLedger();
  const entry = ledger.find(e => e.id === entryId);
  if (!entry || entry.status !== "pending") return false;

  // Create clawback event (append-only)
  const clawbackEvent: LedgerEntry = {
    id: generateLedgerId(),
    agent_id: entry.agent_id,
    vendor: entry.vendor,
    referral_code: entry.referral_code,
    event_type: "clawback",
    commission_amount: entry.commission_amount,
    agent_share: entry.agent_share,
    status: "clawed_back",
    conversion_date: entry.conversion_date,
    clawback_window_ends: entry.clawback_window_ends,
    confirmed_at: null,
    paid_out_at: null,
    created_at: new Date().toISOString(),
    metadata: { original_entry_id: entry.id, reason: reason ?? "vendor_clawback" },
  };
  ledger.push(clawbackEvent);

  // Update original entry
  entry.status = "clawed_back";

  // Update balance
  if (entry.agent_id) {
    const balance = getOrCreateBalance(entry.agent_id);
    balance.pending_balance = roundCents(balance.pending_balance - entry.agent_share);
    balance.updated_at = new Date().toISOString();
  }

  saveLedger(ledger);
  saveBalances(loadBalances());
  return true;
}

/**
 * Get an agent's balance summary.
 */
export function getAgentBalance(agentId: string): AgentBalance | null {
  const balances = loadBalances();
  return balances.find(b => b.agent_id === agentId) ?? null;
}

/**
 * Get ledger entries for a specific agent.
 */
export function getAgentLedgerEntries(agentId: string): LedgerEntry[] {
  return loadLedger().filter(e => e.agent_id === agentId);
}

/**
 * Get a ledger entry by ID.
 */
export function getLedgerEntry(id: string): LedgerEntry | null {
  return loadLedger().find(e => e.id === id) ?? null;
}

/**
 * Get all conversion entries (for admin).
 */
export function getAllConversions(): LedgerEntry[] {
  return loadLedger().filter(e => e.event_type === "conversion");
}
