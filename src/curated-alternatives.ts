import type { DealChange, Offer } from "./types.js";
import { partitionAlternativesAcross, type MembershipGate, type RoleCarrier } from "./product-role.js";

export interface CuratedAlternatives {
  matched: Offer[];
  unmatched: string[];
}

export interface CuratedAlternativesForVendor {
  kept: Offer[];
  removed: Array<{ offer: Offer; gate: MembershipGate }>;
  unmatched: string[];
}

export interface UnmatchedCuratedName {
  name: string;
  named_by: string[];
}

function namesFromChanges(vendorName: string, changes: DealChange[]): string[] {
  const lowerVendor = vendorName.toLowerCase();
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.vendor.toLowerCase() !== lowerVendor) continue;
    for (const name of change.alternatives ?? []) {
      if (name === vendorName || seen.has(name)) continue;
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

export function curatedAlternativeNames(vendorName: string, changes: DealChange[]): string[] {
  return namesFromChanges(vendorName, changes);
}

export function resolveCuratedAlternatives(
  vendorName: string,
  changes: DealChange[],
  offers: Offer[],
): CuratedAlternatives {
  const byVendor = new Map<string, Offer>();
  for (const offer of offers) {
    if (!byVendor.has(offer.vendor)) byVendor.set(offer.vendor, offer);
  }
  const matched: Offer[] = [];
  const unmatched: string[] = [];
  for (const name of namesFromChanges(vendorName, changes)) {
    const offer = byVendor.get(name);
    if (offer) matched.push(offer);
    else unmatched.push(name);
  }
  return { matched, unmatched };
}

export function curatedAlternativesFor(
  vendorName: string,
  changes: DealChange[],
  offers: Offer[],
  subjects: RoleCarrier[],
): CuratedAlternativesForVendor {
  const { matched, unmatched } = resolveCuratedAlternatives(vendorName, changes, offers);
  const partition = partitionAlternativesAcross(matched, subjects);
  return { kept: partition.kept, removed: partition.removed, unmatched };
}

export function addCuratedToPool(pool: Offer[], curated: Offer[]): Offer[] {
  const present = new Set(pool.map(o => o.vendor));
  const widened = [...pool];
  for (const offer of curated) {
    if (present.has(offer.vendor)) continue;
    present.add(offer.vendor);
    widened.push(offer);
  }
  return widened;
}

export function unmatchedCuratedNames(changes: DealChange[], offers: Offer[]): UnmatchedCuratedName[] {
  const indexed = new Set(offers.map(o => o.vendor));
  const byName = new Map<string, Set<string>>();
  for (const change of changes) {
    for (const name of change.alternatives ?? []) {
      if (indexed.has(name)) continue;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(change.vendor);
    }
  }
  return [...byName.entries()]
    .map(([name, namedBy]) => ({ name, named_by: [...namedBy].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
