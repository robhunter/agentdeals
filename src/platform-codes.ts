import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

export type ReferrerCompensation = "commission" | "credit" | "none";

const REFERRER_COMPENSATIONS: readonly ReferrerCompensation[] = ["commission", "credit", "none"];

export interface PayoutQualification {
  active_days: number;
  min_payments_usd: number;
}

export interface PlatformCode {
  vendor: string;
  code: string;
  referral_url: string;
  referrer_benefit: string;
  referrer_compensation: ReferrerCompensation;
  referee_benefit: string;
  restrictions: string[];
  limited_time?: boolean;
  terms_verified?: string;
  payout_qualification?: PayoutQualification;
  source: "platform";
  active: boolean;
  added_at: string;
}

export function referrerCompensationOf(record: unknown): ReferrerCompensation | null {
  const stated = (record as { referrer_compensation?: unknown } | null | undefined)?.referrer_compensation;
  return REFERRER_COMPENSATIONS.includes(stated as ReferrerCompensation) ? (stated as ReferrerCompensation) : null;
}

export function restrictionsOf(record: unknown): string[] {
  const stated = (record as { restrictions?: unknown } | null | undefined)?.restrictions;
  if (!Array.isArray(stated)) return [];
  return stated.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
}

let cachedPlatformCodes: PlatformCode[] | null = null;

function loadPlatformCodes(): PlatformCode[] {
  if (cachedPlatformCodes) return cachedPlatformCodes;

  if (!fs.existsSync(PLATFORM_CODES_PATH)) {
    cachedPlatformCodes = [];
    return cachedPlatformCodes;
  }

  try {
    const raw = fs.readFileSync(PLATFORM_CODES_PATH, "utf-8");
    const data = JSON.parse(raw) as { platform_codes?: PlatformCode[] };
    cachedPlatformCodes = Array.isArray(data.platform_codes) ? data.platform_codes : [];
  } catch {
    cachedPlatformCodes = [];
  }
  return cachedPlatformCodes;
}

export function resetPlatformCodesCache(): void {
  cachedPlatformCodes = null;
}

function slugifyVendor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function getPlatformCodeForVendor(vendorName: string): PlatformCode | null {
  const codes = loadPlatformCodes();
  const querySlug = slugifyVendor(vendorName);
  return codes.find(c => slugifyVendor(c.vendor) === querySlug && c.active) ?? null;
}

export function getAllPlatformCodes(): PlatformCode[] {
  return loadPlatformCodes().filter(c => c.active);
}

export type ServedReferralSource = "platform";

export const AGENT_SUBMISSION_RETIRED_REASON =
  "Agent-submitted referral codes are retired. AgentDeals never paid a commission on one and no longer accepts or serves them. Every code we serve is one we hold ourselves and earn on \u2014 see /disclosure.";


export interface BestReferralCode {
  vendor: string;
  code: string;
  referral_url: string;
  referee_benefit: string;
  restrictions: string[];
  source: ServedReferralSource;
}

export function getBestReferralCode(vendorName: string): BestReferralCode | null {
  const platformCode = getPlatformCodeForVendor(vendorName);
  if (!platformCode) return null;

  return {
    vendor: platformCode.vendor,
    code: platformCode.code,
    referral_url: platformCode.referral_url,
    referee_benefit: platformCode.referee_benefit,
    restrictions: restrictionsOf(platformCode),
    source: "platform",
  };
}

export interface ListedReferralCode {
  vendor: string;
  category: string | null;
  code: string;
  referral_url: string;
  referee_benefit: string;
  restrictions: string[];
  source: ServedReferralSource;
}

export function listAllReferralCodes(opts: {
  vendorToCategory?: (vendorName: string) => string | null;
} = {}): ListedReferralCode[] {
  const resolveCategory = opts.vendorToCategory ?? (() => null);

  return getAllPlatformCodes().map((c) => ({
    vendor: c.vendor,
    category: resolveCategory(c.vendor),
    code: c.code,
    referral_url: c.referral_url,
    referee_benefit: c.referee_benefit,
    restrictions: restrictionsOf(c),
    source: "platform" as const,
  }));
}
