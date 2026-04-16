import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Get the active platform code for a vendor, if one exists.
 */
export function getPlatformCodeForVendor(vendorName: string): PlatformCode | null {
  const codes = loadPlatformCodes();
  const lowerName = vendorName.toLowerCase();
  return codes.find(c => c.vendor.toLowerCase() === lowerName && c.active) ?? null;
}

/**
 * Get all active platform codes.
 */
export function getAllPlatformCodes(): PlatformCode[] {
  return loadPlatformCodes().filter(c => c.active);
}
