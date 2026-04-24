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

// Slug → canonical vendor name. Built once at module load from loadOffers()
// (cached in data.ts). `serve.ts` and `server.ts` both import this to share
// the same authoritative lookup without circular deps.
export const vendorSlugMap: Map<string, string> = buildVendorSlugMap();

// Resolve a user-typed vendor slug to its canonical form via substring matching
// against the known vendor slug map. Returns:
//   - exact: the slug matches a known vendor — caller should render normally
//   - redirect: one root match — caller should 301 to the canonical slug
//   - disambiguate: multiple distinct root matches — caller should render a "did you mean?" page
//   - none: no match — caller should render 404
// The "root" filter collapses parent/child slug pairs (e.g. amazon-kiro vs
// amazon-kiro-aws-startups): a child slug that extends a sibling root is dropped.
export type VendorSlugResolution =
  | { type: "exact"; slug: string }
  | { type: "redirect"; slug: string }
  | { type: "disambiguate"; slugs: string[] }
  | { type: "none" };

// `needle` is a sub-slug of `haystack` when it appears at slug-segment boundaries
// (i.e., bounded by "-" or start/end of string). Avoids false matches where the
// input is embedded mid-segment (e.g., "tally" inside "totally" should NOT match).
export function isSubSlug(needle: string, haystack: string): boolean {
  if (needle === haystack) return true;
  if (haystack.startsWith(needle + "-")) return true;
  if (haystack.endsWith("-" + needle)) return true;
  return haystack.includes("-" + needle + "-");
}

export function resolveVendorSlug(input: string): VendorSlugResolution {
  if (!input) return { type: "none" };
  if (vendorSlugMap.has(input)) return { type: "exact", slug: input };
  if (input.length < 3) return { type: "none" };

  const allSlugs = [...vendorSlugMap.keys()];

  // Completions: known slugs that contain the input as a sub-slug (short-form lookups like "kiro")
  const completions = allSlugs.filter(s => s !== input && isSubSlug(input, s));
  if (completions.length > 0) {
    // Drop any completion that is a "-"-delimited extension of another completion
    // (e.g., prefer amazon-kiro over amazon-kiro-aws-startups).
    const roots = completions.filter(
      s => !completions.some(other => other !== s && s.startsWith(other + "-"))
    );
    if (roots.length === 1) return { type: "redirect", slug: roots[0] };
    return { type: "disambiguate", slugs: roots.slice(0, 10).sort() };
  }

  // Generalizations: known slugs that are sub-slugs of the input (extra-specific lookups)
  const generalizations = allSlugs.filter(s => s !== input && isSubSlug(s, input));
  if (generalizations.length > 0) {
    const longest = generalizations.reduce((a, b) => (b.length > a.length ? b : a));
    return { type: "redirect", slug: longest };
  }

  return { type: "none" };
}
