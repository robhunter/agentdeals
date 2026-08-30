import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRankedCodesForVendor, getAllActiveCodes } from "./referral-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

export type ReferrerCompensation = "commission" | "credit" | "none";

const REFERRER_COMPENSATIONS: readonly ReferrerCompensation[] = ["commission", "credit", "none"];

export interface PlatformCode {
  vendor: string;
  code: string;
  referral_url: string;
  referrer_benefit: string;
  referrer_compensation: ReferrerCompensation;
  referee_benefit: string;
  restrictions: string[];
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

export interface BestReferralCode {
  vendor: string;
  code: string;
  referral_url: string;
  referee_benefit: string;
  restrictions: string[];
  source: "platform" | "agent-submitted";
}

export function getBestReferralCode(vendorName: string): BestReferralCode | null {
  const platformCode = getPlatformCodeForVendor(vendorName);
  if (platformCode) {
    return {
      vendor: platformCode.vendor,
      code: platformCode.code,
      referral_url: platformCode.referral_url,
      referee_benefit: platformCode.referee_benefit,
      restrictions: restrictionsOf(platformCode),
      source: "platform",
    };
  }

  const ranked = getRankedCodesForVendor(vendorName);
  if (ranked.length > 0) {
    const best = ranked[0];
    return {
      vendor: best.vendor,
      code: best.code,
      referral_url: best.referral_url,
      referee_benefit: best.description,
      restrictions: restrictionsOf(best),
      source: "agent-submitted",
    };
  }

  return null;
}

export interface ListedReferralCode {
  vendor: string;
  category: string | null;
  code: string;
  referral_url: string;
  referee_benefit: string;
  restrictions: string[];
  source: "platform" | "agent-submitted";
}

export function listAllReferralCodes(opts: {
  source?: "platform" | "agent" | "agent-submitted";
  vendorToCategory?: (vendorName: string) => string | null;
} = {}): ListedReferralCode[] {
  const resolveCategory = opts.vendorToCategory ?? (() => null);
  const wantPlatform = opts.source === undefined || opts.source === "platform";
  const wantAgent = opts.source === undefined || opts.source === "agent" || opts.source === "agent-submitted";

  const out: ListedReferralCode[] = [];

  if (wantPlatform) {
    for (const c of getAllPlatformCodes()) {
      out.push({
        vendor: c.vendor,
        category: resolveCategory(c.vendor),
        code: c.code,
        referral_url: c.referral_url,
        referee_benefit: c.referee_benefit,
        restrictions: restrictionsOf(c),
        source: "platform",
      });
    }
  }

  if (wantAgent) {
    for (const c of getAllActiveCodes()) {
      out.push({
        vendor: c.vendor,
        category: resolveCategory(c.vendor),
        code: c.code,
        referral_url: c.referral_url,
        referee_benefit: c.description,
        restrictions: restrictionsOf(c),
        source: "agent-submitted",
      });
    }
  }

  return out;
}
