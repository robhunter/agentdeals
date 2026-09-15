import { loadDealChanges, loadOffers } from "./data.js";
import { offerRetired } from "./retirement.js";
import { isSubSlug, toSlug } from "./slug.js";
import { comparisonSlugTargets, retiredSlugTargets, selfComparisonSlug } from "./vendor-merges.js";
import type { Offer } from "./types.js";
import { resolveVendorName, type VendorNameUniverse, type VendorSlugResolution } from "./vendor-substitution.js";

export { isSubSlug, toSlug };
export type { VendorSlugResolution };

function buildVendorSlugMap(): Map<string, string> {
  const offers = loadOffers();
  const map = new Map<string, string>();
  for (const o of offers) {
    const slug = toSlug(o.vendor);
    if (!slug) continue;
    if (!map.has(slug)) map.set(slug, o.vendor);
  }
  return map;
}

export const vendorSlugMap: Map<string, string> = buildVendorSlugMap();

export function slugsWhoseEveryRecordEnded(records: Array<Pick<Offer, "vendor" | "tier">>): Set<string> {
  const stillOffered = new Set<string>();
  const ended = new Set<string>();
  for (const record of records) {
    const slug = toSlug(record.vendor);
    if (!slug) continue;
    (offerRetired(record) ? ended : stillOffered).add(slug);
  }
  for (const slug of stillOffered) ended.delete(slug);
  return ended;
}

export const endedVendorSlugs: Set<string> = slugsWhoseEveryRecordEnded(loadOffers());

export const retiredVendorSlugMap: Map<string, string> = retiredSlugTargets(
  new Set(vendorSlugMap.keys()),
);

export function canonicalVendorSlug(input: string): string | null {
  if (!input) return null;
  if (vendorSlugMap.has(input)) return input;
  return retiredVendorSlugMap.get(input) ?? null;
}

export const comparisonSlugMap: Map<string, string> = comparisonSlugTargets(
  new Set(vendorSlugMap.keys()),
);

export function recordNamedBySlug(input: string): string | null {
  const canonical = canonicalVendorSlug(input);
  return canonical ? vendorSlugMap.get(canonical) ?? null : null;
}

export function mergedVendorSlug(input: string): string | null {
  if (!input) return null;
  return comparisonSlugMap.get(input) ?? null;
}

export function comparisonOfOneRecord(slug: string): string | null {
  return selfComparisonSlug(slug, mergedVendorSlug);
}

function buildChangeLogVendorMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const change of loadDealChanges()) {
    const slug = toSlug(change.vendor);
    if (!slug || map.has(slug)) continue;
    map.set(slug, change.vendor);
  }
  return map;
}

export const changeLogVendorMap: Map<string, string> = buildChangeLogVendorMap();

export function changeLogVendorNamed(phrase: string): string | null {
  const slug = toSlug(phrase);
  return slug ? changeLogVendorMap.get(slug) ?? null : null;
}

export function changeLogAnchorFor(vendor: string): string | null {
  const slug = toSlug(vendor);
  return slug ? `vendor-${slug}` : null;
}

const NAMES_MORE_THAN_ONE_SUBJECT = /\s(?:\+|&|and|or|vs\.?|versus)\s|\s*\/\s*|,/i;

export function namedVendorSlug(phrase: string): string | null {
  const slug = toSlug(phrase);
  if (!slug) return null;
  const resolution = resolveVendorSlug(slug);
  if (resolution.type === "exact") return resolution.slug;
  if (resolution.type !== "redirect") return null;
  if (NAMES_MORE_THAN_ONE_SUBJECT.test(phrase)) return null;
  if (retiredVendorSlugMap.get(slug) === resolution.slug) return resolution.slug;
  const resolved = resolution.slug;
  if (resolved.startsWith(slug + "-") || slug.startsWith(resolved + "-")) return resolved;
  return null;
}

const SUBJECT_ALIASES: Record<string, string> = {
  gcp: "google-cloud",
  "appwrite-auth": "appwrite-cloud",
};

export function badgeAliasTargets(): string[] {
  return [...new Set(Object.values(SUBJECT_ALIASES))];
}

const NON_VENDOR_SUBJECTS = [
  "Django Built-in Auth",
  "FastAPI Built-in",
  "Go Goroutines",
];

export function nonVendorSubjects(): string[] {
  return [...NON_VENDOR_SUBJECTS];
}

export function isNonVendorSubject(phrase: string): boolean {
  return NON_VENDOR_SUBJECTS.some(s => toSlug(s) === toSlug(phrase));
}

const TRAILING_QUALIFIER = /^(.+?)\s*\([^()]*\)$/;
const SUBJECT_SEPARATOR = /\s(?:\+|&|and)\s/i;

export function assertedVendorSlugs(phrase: string): string[] {
  const direct = namedVendorSlug(phrase);
  if (direct) return [direct];

  const alias = SUBJECT_ALIASES[toSlug(phrase)];
  if (alias && vendorSlugMap.has(alias)) return [alias];

  const parts = phrase.split(SUBJECT_SEPARATOR).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const resolved = parts.map(p => assertedVendorSlugs(p));
    if (resolved.every(r => r.length > 0)) return [...new Set(resolved.flat())];
    return [];
  }

  const qualified = phrase.match(TRAILING_QUALIFIER);
  if (qualified) return assertedVendorSlugs(qualified[1]);

  return [];
}

export function servedVendorSlug(input: string): string | null {
  if (!input) return null;
  const resolution = resolveVendorSlug(input);
  if (resolution.type === "exact" || resolution.type === "redirect") return resolution.slug;
  if (resolution.type === "disambiguate") return input;
  return null;
}

export function servedVendorSlugForName(name: string): string | null {
  return servedVendorSlug(toSlug(name));
}

const allVendorSlugs: readonly string[] = [...vendorSlugMap.keys()];

const servedVendorNames: VendorNameUniverse = {
  known: slug => vendorSlugMap.has(slug),
  all: () => allVendorSlugs,
  renamedTo: slug => retiredVendorSlugMap.get(slug) ?? null,
  hasEnded: slug => endedVendorSlugs.has(slug),
};

export function resolveVendorSlug(input: string): VendorSlugResolution {
  return resolveVendorName(input, servedVendorNames);
}

export function vendorNamesWeWillNotSubstitute(input: string): string[] {
  const resolution = resolveVendorSlug(input);
  if (resolution.type !== "onlyMatchHasEnded") return [];
  return resolution.slugs.map(s => vendorSlugMap.get(s) ?? s);
}
