import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { updateAgentTrustTier, getAgentById } from "./agents.js";
import { calculateTrustTier, getCodesByAgent, submitterOfCode } from "./referral-codes.js";
import { createDurableStore } from "./durable-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const CLAWBACK_CONFIG_PATH = path.join(__dirname, "..", "data", "vendor_clawback.json");

export const SUBMITTER_SHARE_RATE = 0.4;

export const MAX_COMMISSION_AMOUNT = 10_000;

export type EventType = "conversion" | "confirmation" | "clawback" | "payout";
export type LedgerStatus = "pending" | "confirmed" | "paid_out" | "clawed_back";

export interface LedgerEntry {
  id: string;
  agent_id: string | null;
  submitter_id?: string | null;
  vendor: string;
  referral_code: string;
  event_type: EventType;
  commission_amount: number;
  agent_share: number;
  submitter_share?: number;
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

let cachedClawbackConfig: VendorClawbackConfig[] | null = null;

const ledgerStore = createDurableStore<LedgerEntry>({
  name: "ledger_entries",
  property: "ledger_entries",
  filePath: () => LEDGER_PATH,
});

const balanceStore = createDurableStore<AgentBalance>({
  name: "agent_balances",
  property: "agent_balances",
  filePath: () => BALANCES_PATH,
});

function loadLedger(): LedgerEntry[] {
  return ledgerStore.read();
}

function saveLedger(entries: LedgerEntry[]): void {
  ledgerStore.save(entries);
}

function loadBalances(): AgentBalance[] {
  return balanceStore.read();
}

function saveBalances(balances: AgentBalance[]): void {
  balanceStore.save(balances);
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
  ledgerStore.reset();
  balanceStore.reset();
  cachedClawbackConfig = null;
}

function generateLedgerId(): string {
  return `le_${randomBytes(16).toString("hex")}`;
}

const DEFAULT_CLAWBACK_DAYS = 30;

export function getClawbackDays(vendor: string): number {
  const config = loadClawbackConfig();
  const entry = config.find(c => c.vendor.toLowerCase() === vendor.toLowerCase());
  return entry ? entry.clawback_days : DEFAULT_CLAWBACK_DAYS;
}

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

  const submitterId = submitterOfCode(opts.vendor, opts.referral_code);

  const clawbackDays = getClawbackDays(opts.vendor);
  const clawbackEnd = new Date(conversionDate);
  clawbackEnd.setDate(clawbackEnd.getDate() + clawbackDays);

  const commission = roundCents(opts.commission_amount);
  const submitterShare = submitterId ? roundCents(commission * SUBMITTER_SHARE_RATE) : 0;

  const entry: LedgerEntry = {
    id: generateLedgerId(),
    agent_id: submitterId,
    submitter_id: submitterId,
    vendor: opts.vendor,
    referral_code: opts.referral_code,
    event_type: "conversion",
    commission_amount: commission,
    agent_share: submitterShare,
    submitter_share: 0,
    status: "pending",
    conversion_date: conversionDateStr,
    clawback_window_ends: clawbackEnd.toISOString().split("T")[0],
    confirmed_at: null,
    paid_out_at: null,
    created_at: new Date().toISOString(),
    metadata: opts.metadata ?? {},
  };

  const ledger = loadLedger();
  ledger.push(entry);
  saveLedger(ledger);

  if (submitterId && submitterShare > 0) {
    const submitterBalance = getOrCreateBalance(submitterId);
    submitterBalance.pending_balance = roundCents(submitterBalance.pending_balance + submitterShare);
    submitterBalance.updated_at = new Date().toISOString();
    saveBalances(loadBalances());
  }

  return entry;
}

export function confirmEligibleEntries(asOfDate?: Date): string[] {
  const now = asOfDate ?? new Date();
  const nowStr = now.toISOString().split("T")[0];
  const ledger = loadLedger();
  const confirmed: string[] = [];

  for (const entry of ledger) {
    if (entry.status !== "pending") continue;
    if (entry.clawback_window_ends > nowStr) continue;

    const confirmEntry: LedgerEntry = {
      id: generateLedgerId(),
      agent_id: entry.agent_id,
      submitter_id: entry.submitter_id,
      vendor: entry.vendor,
      referral_code: entry.referral_code,
      event_type: "confirmation",
      commission_amount: entry.commission_amount,
      agent_share: entry.agent_share,
      submitter_share: entry.submitter_share,
      status: "confirmed",
      conversion_date: entry.conversion_date,
      clawback_window_ends: entry.clawback_window_ends,
      confirmed_at: new Date().toISOString(),
      paid_out_at: null,
      created_at: new Date().toISOString(),
      metadata: { original_entry_id: entry.id },
    };
    ledger.push(confirmEntry);

    entry.status = "confirmed";
    entry.confirmed_at = new Date().toISOString();
    confirmed.push(entry.id);

    if (entry.agent_id && entry.agent_share > 0) {
      const balance = getOrCreateBalance(entry.agent_id);
      balance.pending_balance = roundCents(balance.pending_balance - entry.agent_share);
      balance.confirmed_balance = roundCents(balance.confirmed_balance + entry.agent_share);
      balance.total_earned = roundCents(balance.total_earned + entry.agent_share);
      balance.updated_at = new Date().toISOString();
    }

    const submitterShare = entry.submitter_share ?? 0;
    if (entry.submitter_id && submitterShare > 0 && entry.submitter_id !== entry.agent_id) {
      const submitterBalance = getOrCreateBalance(entry.submitter_id);
      submitterBalance.pending_balance = roundCents(submitterBalance.pending_balance - submitterShare);
      submitterBalance.confirmed_balance = roundCents(submitterBalance.confirmed_balance + submitterShare);
      submitterBalance.total_earned = roundCents(submitterBalance.total_earned + submitterShare);
      submitterBalance.updated_at = new Date().toISOString();
    }
  }

  if (confirmed.length > 0) {
    saveLedger(ledger);
    saveBalances(loadBalances());

    const affectedAgents = new Set<string>();
    for (const entryId of confirmed) {
      const entry = ledger.find(e => e.id === entryId);
      if (entry?.agent_id) affectedAgents.add(entry.agent_id);
    }
    for (const agentId of affectedAgents) {
      const newTier = calculateTrustTier(agentId, ledger);
      updateAgentTrustTier(agentId, newTier);
    }
  }

  return confirmed;
}

export function clawbackEntry(entryId: string, reason?: string): boolean {
  const ledger = loadLedger();
  const entry = ledger.find(e => e.id === entryId);
  if (!entry || entry.status !== "pending") return false;

  const clawbackEvent: LedgerEntry = {
    id: generateLedgerId(),
    agent_id: entry.agent_id,
    submitter_id: entry.submitter_id,
    vendor: entry.vendor,
    referral_code: entry.referral_code,
    event_type: "clawback",
    commission_amount: entry.commission_amount,
    agent_share: entry.agent_share,
    submitter_share: entry.submitter_share,
    status: "clawed_back",
    conversion_date: entry.conversion_date,
    clawback_window_ends: entry.clawback_window_ends,
    confirmed_at: null,
    paid_out_at: null,
    created_at: new Date().toISOString(),
    metadata: { original_entry_id: entry.id, reason: reason ?? "vendor_clawback" },
  };
  ledger.push(clawbackEvent);

  entry.status = "clawed_back";

  if (entry.agent_id && entry.agent_share > 0) {
    const balance = getOrCreateBalance(entry.agent_id);
    balance.pending_balance = roundCents(balance.pending_balance - entry.agent_share);
    balance.updated_at = new Date().toISOString();
  }

  const submitterShare = entry.submitter_share ?? 0;
  if (entry.submitter_id && submitterShare > 0 && entry.submitter_id !== entry.agent_id) {
    const submitterBalance = getOrCreateBalance(entry.submitter_id);
    submitterBalance.pending_balance = roundCents(submitterBalance.pending_balance - submitterShare);
    submitterBalance.updated_at = new Date().toISOString();
  }

  saveLedger(ledger);
  saveBalances(loadBalances());

  if (entry.agent_id) {
    const newTier = calculateTrustTier(entry.agent_id, ledger);
    updateAgentTrustTier(entry.agent_id, newTier);
  }

  return true;
}

const MINIMUM_PAYOUT_AMOUNT = 10;

export function recordPayout(opts: {
  agent_id: string;
  x402_address: string;
  tx_hash?: string;
  correlation_id: string;
  metadata?: Record<string, unknown>;
}): LedgerEntry {
  const balances = loadBalances();
  const balance = balances.find(b => b.agent_id === opts.agent_id);
  const confirmedBalance = balance ? balance.confirmed_balance : 0;

  if (confirmedBalance < MINIMUM_PAYOUT_AMOUNT) {
    throw new Error(`Insufficient confirmed balance: $${confirmedBalance.toFixed(2)}. Minimum payout is $${MINIMUM_PAYOUT_AMOUNT}.`);
  }

  const payoutAmount = confirmedBalance;

  const entry: LedgerEntry = {
    id: generateLedgerId(),
    agent_id: opts.agent_id,
    vendor: "AgentDeals",
    referral_code: "",
    event_type: "payout",
    commission_amount: payoutAmount,
    agent_share: payoutAmount,
    status: "paid_out",
    conversion_date: new Date().toISOString().split("T")[0],
    clawback_window_ends: new Date().toISOString().split("T")[0],
    confirmed_at: null,
    paid_out_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    metadata: {
      x402_address: opts.x402_address,
      tx_hash: opts.tx_hash ?? null,
      correlation_id: opts.correlation_id,
      ...opts.metadata,
    },
  };

  const ledger = loadLedger();
  ledger.push(entry);
  saveLedger(ledger);

  if (balance) {
    balance.confirmed_balance = 0;
    balance.total_paid_out = roundCents(balance.total_paid_out + payoutAmount);
    balance.updated_at = new Date().toISOString();
    saveBalances(balances);
  }

  return entry;
}

export { MINIMUM_PAYOUT_AMOUNT };

export function getAgentBalance(agentId: string): AgentBalance | null {
  const balances = loadBalances();
  return balances.find(b => b.agent_id === agentId) ?? null;
}

export function getAgentLedgerEntries(agentId: string): LedgerEntry[] {
  return loadLedger().filter(e => e.agent_id === agentId);
}

export function getLedgerEntry(id: string): LedgerEntry | null {
  return loadLedger().find(e => e.id === id) ?? null;
}

export function getAllConversions(): LedgerEntry[] {
  return loadLedger().filter(e => e.event_type === "conversion");
}

export interface LeaderboardEntry {
  agent_id: string;
  agent_name: string;
  trust_tier: string;
  total_conversions: number;
  active_codes: number;
  total_earnings: number;
}

export function getLeaderboard(opts?: { limit?: number; offset?: number }): { entries: LeaderboardEntry[]; total: number } {
  const limit = Math.min(opts?.limit ?? 10, 50);
  const offset = opts?.offset ?? 0;

  const ledger = loadLedger();
  const balances = loadBalances();

  const agentConversions = new Map<string, number>();
  for (const entry of ledger) {
    if (entry.event_type === "conversion" && entry.agent_id && entry.status !== "clawed_back") {
      agentConversions.set(entry.agent_id, (agentConversions.get(entry.agent_id) ?? 0) + 1);
    }
    if (entry.event_type === "conversion" && entry.submitter_id && entry.submitter_id !== entry.agent_id && entry.status !== "clawed_back") {
      agentConversions.set(entry.submitter_id, (agentConversions.get(entry.submitter_id) ?? 0) + 1);
    }
  }

  const entries: LeaderboardEntry[] = [];
  for (const [agentId, conversions] of agentConversions) {
    const agent = getAgentById(agentId);
    if (!agent) continue;

    const agentCodes = getCodesByAgent(agentId);
    const activeCodes = agentCodes.filter(c => c.status === "active").length;

    const balance = balances.find(b => b.agent_id === agentId);
    const totalEarnings = balance ? balance.total_earned + balance.pending_balance + balance.confirmed_balance : 0;

    entries.push({
      agent_id: agentId,
      agent_name: agent.name,
      trust_tier: agent.trust_tier,
      total_conversions: conversions,
      active_codes: activeCodes,
      total_earnings: roundCents(totalEarnings),
    });
  }

  entries.sort((a, b) => b.total_conversions - a.total_conversions);

  return {
    entries: entries.slice(offset, offset + limit),
    total: entries.length,
  };
}
