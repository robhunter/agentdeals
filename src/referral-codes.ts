import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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

let cachedCodes: SubmittedReferralCode[] | null = null;

function loadCodes(): SubmittedReferralCode[] {
  if (cachedCodes) return cachedCodes;

  if (!fs.existsSync(CODES_PATH)) {
    cachedCodes = [];
    return cachedCodes;
  }

  try {
    const raw = fs.readFileSync(CODES_PATH, "utf-8");
    const data = JSON.parse(raw) as { referral_codes?: SubmittedReferralCode[] };
    cachedCodes = Array.isArray(data.referral_codes) ? data.referral_codes : [];
  } catch {
    cachedCodes = [];
  }
  return cachedCodes;
}

function saveCodes(codes: SubmittedReferralCode[]): void {
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: codes }, null, 2), "utf-8");
  cachedCodes = codes;
}

export function resetReferralCodesCache(): void {
  cachedCodes = null;
}

function generateCodeId(): string {
  return `code_${randomBytes(12).toString("hex")}`;
}

// --- Trust tier calculation ---

/**
 * Calculate an agent's trust tier based on their conversion/clawback history.
 * - new: default (just registered)
 * - verified: 3+ successful conversions, 0 clawbacks
 * - trusted: 20+ conversions, <5% clawback rate
 */
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

// --- Rate limiting ---

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

// --- Validation ---

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

// --- Core operations ---

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
  // Validate vendor exists
  if (!validateVendorExists(opts.vendor)) {
    throw new Error(`Vendor "${opts.vendor}" not found in the offers index`);
  }

  // Validate code
  if (!opts.code || opts.code.length > 100) {
    throw new Error("code must be a non-empty string, max 100 characters");
  }

  // Validate URL
  if (!isValidUrl(opts.referral_url)) {
    throw new Error("referral_url must be a valid URL");
  }

  // Validate agent is active
  const agent = getAgentById(opts.agent_id);
  if (!agent || agent.status !== "active") {
    throw new Error("Agent must be active to submit referral codes");
  }

  // Check one active code per vendor per agent
  const codes = loadCodes();
  const existingActive = codes.find(c =>
    c.submitted_by === opts.agent_id &&
    c.vendor.toLowerCase() === opts.vendor.toLowerCase() &&
    (c.status === "active" || c.status === "pending")
  );
  if (existingActive) {
    throw new Error(`You already have an active/pending code for "${opts.vendor}". Revoke it first to submit a new one.`);
  }

  // Rate limit check
  const dailyCount = getDailySubmissionCount(opts.agent_id);
  const dailyLimit = getDailyLimit(opts.trust_tier);
  if (dailyCount >= dailyLimit) {
    throw new Error(`Daily submission limit reached (${dailyLimit}/day for ${opts.trust_tier} tier). Try again tomorrow.`);
  }

  // Validate expiry if provided
  if (opts.expiry) {
    const expiryDate = new Date(opts.expiry);
    if (isNaN(expiryDate.getTime())) {
      throw new Error("expiry must be a valid ISO date string");
    }
    if (expiryDate <= new Date()) {
      throw new Error("expiry must be in the future");
    }
  }

  // Determine initial status based on trust tier
  const status: CodeStatus = opts.trust_tier === "new" ? "pending" : "active";

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

/**
 * Get all codes submitted by a specific agent.
 */
export function getCodesByAgent(agentId: string): SubmittedReferralCode[] {
  return loadCodes().filter(c => c.submitted_by === agentId);
}

/**
 * Get a submitted code by ID.
 */
export function getCodeById(id: string): SubmittedReferralCode | null {
  return loadCodes().find(c => c.id === id) ?? null;
}

/**
 * Update a submitted code. Only the owner can update.
 * Returns the updated code or throws.
 */
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

/**
 * Soft-delete (revoke) a submitted code. Only the owner can revoke.
 */
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

/**
 * Get all active agent-submitted codes for a specific vendor.
 * Used by search results to include alongside curated codes.
 */
export function getActiveCodesForVendor(vendorName: string): SubmittedReferralCode[] {
  const codes = loadCodes();
  const lowerName = vendorName.toLowerCase();

  // Check and expire any codes past their expiry date
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

/**
 * Get all active agent-submitted codes (for search result integration).
 */
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
