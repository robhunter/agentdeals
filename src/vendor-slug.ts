import { loadOffers } from "./data.js";

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

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

export type VendorSlugResolution =
  | { type: "exact"; slug: string }
  | { type: "redirect"; slug: string }
  | { type: "disambiguate"; slugs: string[] }
  | { type: "none" };

export function isSubSlug(needle: string, haystack: string): boolean {
  if (needle === haystack) return true;
  if (haystack.startsWith(needle + "-")) return true;
  if (haystack.endsWith("-" + needle)) return true;
  return haystack.includes("-" + needle + "-");
}

const NAMES_MORE_THAN_ONE_SUBJECT = /\s(?:\+|&|and|or|vs\.?|versus)\s|\s*\/\s*|,/i;

export function namedVendorSlug(phrase: string): string | null {
  const slug = toSlug(phrase);
  if (!slug) return null;
  const resolution = resolveVendorSlug(slug);
  if (resolution.type === "exact") return resolution.slug;
  if (resolution.type !== "redirect") return null;
  if (NAMES_MORE_THAN_ONE_SUBJECT.test(phrase)) return null;
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

export function resolveVendorSlug(input: string): VendorSlugResolution {
  if (!input) return { type: "none" };
  if (vendorSlugMap.has(input)) return { type: "exact", slug: input };
  if (input.length < 3) return { type: "none" };

  const allSlugs = [...vendorSlugMap.keys()];

  const completions = allSlugs.filter(s => s !== input && isSubSlug(input, s));
  if (completions.length > 0) {
    const roots = completions.filter(
      s => !completions.some(other => other !== s && s.startsWith(other + "-"))
    );
    if (roots.length === 1) return { type: "redirect", slug: roots[0] };
    return { type: "disambiguate", slugs: roots.slice(0, 10).sort() };
  }

  const generalizations = allSlugs.filter(s => s !== input && isSubSlug(s, input));
  if (generalizations.length > 0) {
    const longest = generalizations.reduce((a, b) => (b.length > a.length ? b : a));
    return { type: "redirect", slug: longest };
  }

  return { type: "none" };
}
