import type { DealChange, Offer } from "./types.js";
import { partitionSubstitutes, type SubstitutesPartition } from "./product-role.js";
import { resolveCuratedAlternatives, addCuratedToPool } from "./curated-alternatives.js";

export interface VendorSubstitutes {
  categories: string[];
  curatedNames: Set<string>;
  membership: SubstitutesPartition<Offer>;
}

export function vendorSubstitutes(vendorName: string, vendorOffers: Offer[], allChanges: DealChange[], catalogue: Offer[]): VendorSubstitutes {
  const categories = [...new Set(vendorOffers.map(o => o.category))];
  const seen = new Set<string>();
  const pool: Offer[] = [];
  for (const o of catalogue) {
    if (o.vendor === vendorName || !categories.includes(o.category) || seen.has(o.vendor)) continue;
    seen.add(o.vendor);
    pool.push(o);
  }
  const curated = resolveCuratedAlternatives(vendorName, allChanges, catalogue);
  const curatedNames = new Set(curated.matched.map(o => o.vendor));
  const membership = partitionSubstitutes(addCuratedToPool(pool, curated.matched), vendorOffers, {
    subtypeExempt: candidate => curatedNames.has(candidate.vendor),
  });
  return { categories, curatedNames, membership };
}

export function substitutesListedFor(vendorName: string, allChanges: DealChange[], catalogue: Offer[]): Offer[] {
  const vendorOffers = catalogue.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return [];
  return vendorSubstitutes(vendorName, vendorOffers, allChanges, catalogue).membership.kept;
}
