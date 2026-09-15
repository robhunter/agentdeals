import { isSubSlug } from "./slug.js";

export type VendorSlugResolution =
  | { type: "exact"; slug: string }
  | { type: "redirect"; slug: string }
  | { type: "onlyMatchHasEnded"; slugs: string[] }
  | { type: "disambiguate"; slugs: string[] }
  | { type: "none" };

export interface VendorNameUniverse {
  known(slug: string): boolean;
  all(): readonly string[];
  renamedTo(slug: string): string | null;
  hasEnded(slug: string): boolean;
}

const SHORTEST_INPUT_WE_COMPLETE = 3;
const MOST_ALTERNATIVES_WE_LIST = 10;

export function resolveVendorName(input: string, universe: VendorNameUniverse): VendorSlugResolution {
  if (!input) return { type: "none" };
  if (universe.known(input)) return { type: "exact", slug: input };

  const renamed = universe.renamedTo(input);
  if (renamed) return substituteOneOf([renamed], universe);
  if (input.length < SHORTEST_INPUT_WE_COMPLETE) return { type: "none" };

  const all = universe.all();

  const completions = all.filter(s => s !== input && isSubSlug(input, s));
  if (completions.length > 0) {
    const roots = completions.filter(
      s => !completions.some(other => other !== s && s.startsWith(other + "-"))
    );
    return substituteOneOf(roots, universe);
  }

  const generalizations = all.filter(s => s !== input && isSubSlug(s, input));
  if (generalizations.length > 0) {
    const longest = generalizations.reduce((a, b) => (b.length > a.length ? b : a));
    return substituteOneOf([longest], universe);
  }

  return { type: "none" };
}

export function substitutedSlugsThatEnded(resolution: VendorSlugResolution): string[] {
  return resolution.type === "onlyMatchHasEnded" ? resolution.slugs : [];
}

function substituteOneOf(candidates: string[], universe: VendorNameUniverse): VendorSlugResolution {
  const stillOffered = candidates.filter(s => !universe.hasEnded(s));
  if (stillOffered.length === 1) return { type: "redirect", slug: stillOffered[0]! };
  if (stillOffered.length > 1) {
    return { type: "disambiguate", slugs: stillOffered.slice(0, MOST_ALTERNATIVES_WE_LIST).sort() };
  }
  if (candidates.length > 0) return { type: "onlyMatchHasEnded", slugs: [...candidates].sort() };
  return { type: "none" };
}
