import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug } from "./slug.js";

export interface VendorMerge {
  retired: string;
  survivor: string;
}

export interface SharedPricingPage {
  vendors: string[];
  reason: string;
}

export interface VendorMergeRegistry {
  merges: VendorMerge[];
  sharedPricingPages: SharedPricingPage[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MERGES_PATH = path.join(__dirname, "..", "data", "vendor_merges.json");

let cached: VendorMergeRegistry | null = null;

export function loadVendorMergeRegistry(): VendorMergeRegistry {
  if (cached) return cached;

  let raw: string;
  try {
    raw = fs.readFileSync(MERGES_PATH, "utf-8");
  } catch (err) {
    console.error(`Vendor merge registry not readable at ${MERGES_PATH}: ${err}`);
    cached = { merges: [], sharedPricingPages: [] };
    return cached;
  }

  try {
    const data = JSON.parse(raw);
    cached = {
      merges: Array.isArray(data?.merges) ? data.merges : [],
      sharedPricingPages: Array.isArray(data?.shared_pricing_pages) ? data.shared_pricing_pages : [],
    };
  } catch (err) {
    console.error(`Vendor merge registry contains malformed JSON: ${err}`);
    cached = { merges: [], sharedPricingPages: [] };
  }
  return cached;
}

export function resetVendorMergeCache(): void {
  cached = null;
}

export function vendorMerges(): readonly VendorMerge[] {
  return loadVendorMergeRegistry().merges;
}

export function sharedPricingPages(): readonly SharedPricingPage[] {
  return loadVendorMergeRegistry().sharedPricingPages;
}

export function declaredMergeSlugs(merges: readonly VendorMerge[] = vendorMerges()): Map<string, string> {
  const map = new Map<string, string>();
  for (const merge of merges) {
    const from = toSlug(merge.retired);
    const to = toSlug(merge.survivor);
    if (!from || !to || from === to) continue;
    map.set(from, to);
  }
  return map;
}

export function retiredSlugTargets(
  liveSlugs: ReadonlySet<string>,
  merges: readonly VendorMerge[] = vendorMerges(),
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [from, to] of declaredMergeSlugs(merges)) {
    if (liveSlugs.has(from)) continue;
    if (!liveSlugs.has(to)) continue;
    map.set(from, to);
  }
  return map;
}

export function comparisonSlugTargets(
  liveSlugs: ReadonlySet<string>,
  merges: readonly VendorMerge[] = vendorMerges(),
): Map<string, string> {
  const map = new Map<string, string>();
  for (const slug of liveSlugs) map.set(slug, slug);
  for (const [from, to] of declaredMergeSlugs(merges)) {
    if (!liveSlugs.has(to)) continue;
    map.set(from, to);
  }
  return map;
}

export function survivingVendorName(
  vendor: string,
  liveVendors: ReadonlySet<string>,
  merges: readonly VendorMerge[] = vendorMerges(),
): string | null {
  const key = vendor.trim().toLowerCase();
  for (const merge of merges) {
    if (merge.retired.trim().toLowerCase() !== key) continue;
    if (liveVendors.has(key)) return null;
    if (!liveVendors.has(merge.survivor.trim().toLowerCase())) return null;
    return merge.survivor;
  }
  return null;
}

export function selfComparisonSlug(
  slug: string,
  canonical: (part: string) => string | null,
): string | null {
  let from = 0;
  for (;;) {
    const at = slug.indexOf("-vs-", from);
    if (at === -1) return null;
    const a = canonical(slug.slice(0, at));
    const b = canonical(slug.slice(at + 4));
    if (a && b) return a === b ? a : null;
    from = at + 1;
  }
}
