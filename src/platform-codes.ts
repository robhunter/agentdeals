import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRankedCodesForVendor, getAllActiveCodes } from "./referral-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

export interface PlatformCode {
  vendor: string;
  code: string;
  referral_url: string;
  referrer_benefit: string;
  referee_benefit: string;
  source: "platform";
  active: boolean;
  added_at: string;
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

/**
 * Get the active platform code for a vendor, if one exists.
 * Accepts both canonical vendor names ("Proton Mail") and URL slugs ("proton-mail").
 */
export function getPlatformCodeForVendor(vendorName: string): PlatformCode | null {
  const codes = loadPlatformCodes();
  const querySlug = slugifyVendor(vendorName);
  return codes.find(c => slugifyVendor(c.vendor) === querySlug && c.active) ?? null;
}

/**
 * Get all active platform codes.
 */
export function getAllPlatformCodes(): PlatformCode[] {
  return loadPlatformCodes().filter(c => c.active);
}

/**
 * Unified referral code shape returned inline on MCP tool responses and REST enrichment.
 * Matches the GET /api/referral-codes/:vendor response shape so clients can consume both the same way.
 */
export interface BestReferralCode {
  vendor: string;
  code: string;
  referral_url: string;
  referee_benefit: string;
  source: "platform" | "agent-submitted";
}

/**
 * Get the best available referral code for a vendor.
 * Platform codes take priority over agent-submitted codes.
 * Returns null (explicit) when no code is available, so callers can distinguish "no code" from "field missing".
 */
export function getBestReferralCode(vendorName: string): BestReferralCode | null {
  const platformCode = getPlatformCodeForVendor(vendorName);
  if (platformCode) {
    return {
      vendor: platformCode.vendor,
      code: platformCode.code,
      referral_url: platformCode.referral_url,
      referee_benefit: platformCode.referee_benefit,
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
      source: "agent-submitted",
    };
  }

  return null;
}

/**
 * List all active referral codes across all vendors, for the GET /api/referral-codes listing endpoint.
 * Includes both platform codes (ours) and active agent-submitted codes.
 * Callers can pass a `vendorToCategory` resolver to enrich each entry with its primary category.
 */
export interface ListedReferralCode {
  vendor: string;
  category: string | null;
  code: string;
  referral_url: string;
  referee_benefit: string;
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
        source: "agent-submitted",
      });
    }
  }

  return out;
}
