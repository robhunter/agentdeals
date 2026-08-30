import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDurableStore } from "./durable-store.js";
import { getAgentById } from "./agents.js";
import { loadOffers } from "./data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");

export type CodeStatus = "pending" | "active" | "expired" | "revoked";
export type TrustTier = "new" | "verified" | "trusted";

export interface SubmittedReferralCode {
  id: string;
  vendor: string;
  code: string;
  referral_url: string;
  description: string;
  commission_rate: number | null;
  expiry: string | null;
  submitted_by: string;
  source: "agent-submitted";
  status: CodeStatus;
  trust_tier_at_submission: TrustTier;
  impressions: number;
  clicks: number;
  conversions: number;
  submitted_at: string;
  updated_at: string;
}

const codeStore = createDurableStore<SubmittedReferralCode>({
  name: "referral_codes",
  property: "referral_codes",
  filePath: () => CODES_PATH,
});

function loadCodes(): SubmittedReferralCode[] {
  return codeStore.read();
}

function saveCodes(codes: SubmittedReferralCode[]): void {
  codeStore.save(codes);
}

export function resetReferralCodesCache(): void {
  codeStore.reset();
}

function generateCodeId(): string {
  return `code_${randomBytes(12).toString("hex")}`;
}

export function calculateTrustTier(agentId: string, ledgerEntries: { event_type: string; agent_id: string | null; status: string }[]): TrustTier {
  const agentEntries = ledgerEntries.filter(e => e.agent_id === agentId);
  const conversions = agentEntries.filter(e => e.event_type === "conversion" && e.status !== "clawed_back");
  const clawbacks = agentEntries.filter(e => e.event_type === "clawback");

  const conversionCount = conversions.length;
  const clawbackCount = clawbacks.length;

  if (conversionCount >= 20) {
    const totalEvents = conversionCount + clawbackCount;
    const clawbackRate = totalEvents > 0 ? clawbackCount / totalEvents : 0;
    if (clawbackRate < 0.05) return "trusted";
  }

  if (conversionCount >= 3 && clawbackCount === 0) return "verified";

  return "new";
}

const DAILY_LIMITS: Record<TrustTier, number> = {
  new: 10,
  verified: 10,
  trusted: 50,
};

export function getDailySubmissionCount(agentId: string): number {
  const codes = loadCodes();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStr = todayStart.toISOString();

  return codes.filter(c =>
    c.submitted_by === agentId && c.submitted_at >= todayStr
  ).length;
}

export function getDailyLimit(tier: TrustTier): number {
  return DAILY_LIMITS[tier];
}

function validateVendorExists(vendor: string): boolean {
  const offers = loadOffers();
  return offers.some(o => o.vendor.toLowerCase() === vendor.toLowerCase());
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export interface SubmitCodeOpts {
  vendor: string;
  code: string;
  referral_url: string;
  description: string;
  commission_rate?: number;
  expiry?: string;
  agent_id: string;
  trust_tier: TrustTier;
}

export function submitReferralCode(opts: SubmitCodeOpts): SubmittedReferralCode {
  if (!validateVendorExists(opts.vendor)) {
    throw new Error(`Vendor "${opts.vendor}" not found in the offers index`);
  }

  if (!opts.code || opts.code.length > 100) {
    throw new Error("code must be a non-empty string, max 100 characters");
  }

  if (!isValidUrl(opts.referral_url)) {
    throw new Error("referral_url must be a valid URL");
  }

  const agent = getAgentById(opts.agent_id);
  if (!agent || agent.status !== "active") {
    throw new Error("Agent must be active to submit referral codes");
  }

  const codes = loadCodes();
  const existingActive = codes.find(c =>
    c.submitted_by === opts.agent_id &&
    c.vendor.toLowerCase() === opts.vendor.toLowerCase() &&
    (c.status === "active" || c.status === "pending")
  );
  if (existingActive) {
    throw new Error(`You already have an active/pending code for "${opts.vendor}". Revoke it first to submit a new one.`);
  }

  const dailyCount = getDailySubmissionCount(opts.agent_id);
  const dailyLimit = getDailyLimit(opts.trust_tier);
  if (dailyCount >= dailyLimit) {
    throw new Error(`Daily submission limit reached (${dailyLimit}/day for ${opts.trust_tier} tier). Try again tomorrow.`);
  }

  if (opts.expiry) {
    const expiryDate = new Date(opts.expiry);
    if (isNaN(expiryDate.getTime())) {
      throw new Error("expiry must be a valid ISO date string");
    }
    if (expiryDate <= new Date()) {
      throw new Error("expiry must be in the future");
    }
  }

  const status: CodeStatus = "active";

  const now = new Date().toISOString();
  const entry: SubmittedReferralCode = {
    id: generateCodeId(),
    vendor: opts.vendor,
    code: opts.code,
    referral_url: opts.referral_url,
    description: opts.description || "",
    commission_rate: opts.commission_rate ?? null,
    expiry: opts.expiry ?? null,
    submitted_by: opts.agent_id,
    source: "agent-submitted",
    status,
    trust_tier_at_submission: opts.trust_tier,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    submitted_at: now,
    updated_at: now,
  };

  codes.push(entry);
  saveCodes(codes);
  return entry;
}

export function getCodesByAgent(agentId: string): SubmittedReferralCode[] {
  return loadCodes().filter(c => c.submitted_by === agentId);
}

export function getCodeById(id: string): SubmittedReferralCode | null {
  return loadCodes().find(c => c.id === id) ?? null;
}

export function submitterOfCode(vendorName: string, code: string): string | null {
  if (!code) return null;
  const lowerName = vendorName.toLowerCase();
  const match = loadCodes().find(c => c.vendor.toLowerCase() === lowerName && c.code === code);
  return match ? match.submitted_by : null;
}

export function updateCode(id: string, agentId: string, updates: {
  code?: string;
  referral_url?: string;
  description?: string;
  commission_rate?: number;
  expiry?: string | null;
}): SubmittedReferralCode {
  const codes = loadCodes();
  const entry = codes.find(c => c.id === id);

  if (!entry) {
    throw new Error("Code not found");
  }

  if (entry.submitted_by !== agentId) {
    throw new Error("You can only update your own codes");
  }

  if (entry.status === "revoked") {
    throw new Error("Cannot update a revoked code");
  }

  if (updates.code !== undefined) {
    if (!updates.code || updates.code.length > 100) {
      throw new Error("code must be a non-empty string, max 100 characters");
    }
    entry.code = updates.code;
  }

  if (updates.referral_url !== undefined) {
    if (!isValidUrl(updates.referral_url)) {
      throw new Error("referral_url must be a valid URL");
    }
    entry.referral_url = updates.referral_url;
  }

  if (updates.description !== undefined) {
    entry.description = updates.description;
  }

  if (updates.commission_rate !== undefined) {
    entry.commission_rate = updates.commission_rate;
  }

  if (updates.expiry !== undefined) {
    if (updates.expiry !== null) {
      const expiryDate = new Date(updates.expiry);
      if (isNaN(expiryDate.getTime())) {
        throw new Error("expiry must be a valid ISO date string");
      }
    }
    entry.expiry = updates.expiry;
  }

  entry.updated_at = new Date().toISOString();
  saveCodes(codes);
  return entry;
}

export function revokeCode(id: string, agentId: string): SubmittedReferralCode {
  const codes = loadCodes();
  const entry = codes.find(c => c.id === id);

  if (!entry) {
    throw new Error("Code not found");
  }

  if (entry.submitted_by !== agentId) {
    throw new Error("You can only revoke your own codes");
  }

  if (entry.status === "revoked") {
    throw new Error("Code is already revoked");
  }

  entry.status = "revoked";
  entry.updated_at = new Date().toISOString();
  saveCodes(codes);
  return entry;
}

export function getActiveCodesForVendor(vendorName: string): SubmittedReferralCode[] {
  const codes = loadCodes();
  const lowerName = vendorName.toLowerCase();

  const now = new Date();
  let changed = false;
  for (const code of codes) {
    if (code.status === "active" && code.expiry) {
      const expiryDate = new Date(code.expiry);
      if (expiryDate <= now) {
        code.status = "expired";
        code.updated_at = now.toISOString();
        changed = true;
      }
    }
  }
  if (changed) saveCodes(codes);

  return codes.filter(c =>
    c.vendor.toLowerCase() === lowerName && c.status === "active"
  );
}

export function getAllActiveCodes(): SubmittedReferralCode[] {
  const codes = loadCodes();
  const now = new Date();
  let changed = false;
  for (const code of codes) {
    if (code.status === "active" && code.expiry) {
      const expiryDate = new Date(code.expiry);
      if (expiryDate <= now) {
        code.status = "expired";
        code.updated_at = now.toISOString();
        changed = true;
      }
    }
  }
  if (changed) saveCodes(codes);

  return codes.filter(c => c.status === "active");
}

const TRUST_WEIGHTS: Record<TrustTier, number> = {
  new: 1.0,
  verified: 1.5,
  trusted: 2.0,
};

const COLD_START_IMPRESSIONS = 50;
const RECENCY_DECAY_RATE = 0.05;
const RECENCY_FLOOR = 0.5;
const MIN_IMPRESSIONS_FOR_RATE = 10;

export function calculateCodeScore(code: SubmittedReferralCode, now?: Date): number {
  const currentDate = now ?? new Date();
  const trustWeight = TRUST_WEIGHTS[code.trust_tier_at_submission] ?? 1.0;

  let conversionRate: number;
  if (code.impressions < MIN_IMPRESSIONS_FOR_RATE) {
    conversionRate = 0.5;
  } else {
    conversionRate = code.conversions / code.impressions;
  }

  const submittedAt = new Date(code.submitted_at);
  const daysSinceSubmission = Math.max(0, (currentDate.getTime() - submittedAt.getTime()) / (1000 * 60 * 60 * 24));
  let recencyFactor: number;
  if (daysSinceSubmission <= 7) {
    recencyFactor = 1.0;
  } else {
    const weeksAfterFirst = (daysSinceSubmission - 7) / 7;
    recencyFactor = Math.max(RECENCY_FLOOR, 1.0 - weeksAfterFirst * RECENCY_DECAY_RATE);
  }

  return trustWeight * conversionRate * recencyFactor;
}

export function isInColdStart(code: SubmittedReferralCode): boolean {
  return code.impressions < COLD_START_IMPRESSIONS;
}

export function getRankedCodesForVendor(vendorName: string, now?: Date): SubmittedReferralCode[] {
  const activeCodes = getActiveCodesForVendor(vendorName);
  if (activeCodes.length === 0) return [];

  const coldStart = activeCodes.filter(c => isInColdStart(c));
  const ranked = activeCodes.filter(c => !isInColdStart(c));

  coldStart.sort((a, b) => a.impressions - b.impressions);

  ranked.sort((a, b) => calculateCodeScore(b, now) - calculateCodeScore(a, now));

  return [...coldStart, ...ranked];
}

export function recordImpression(codeId: string): void {
  const codes = loadCodes();
  const code = codes.find(c => c.id === codeId);
  if (code) {
    code.impressions += 1;
    saveCodes(codes);
  }
}

export function recordCodeConversion(codeId: string): void {
  const codes = loadCodes();
  const code = codes.find(c => c.id === codeId);
  if (code) {
    code.conversions += 1;
    saveCodes(codes);
  }
}
