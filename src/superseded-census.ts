import { gateFor } from "./ranking.js";
import { supersedingChange } from "./superseded-description.js";
import { vendorSlugMap } from "./vendor-slug.js";
import type { DealChange, Offer } from "./types.js";

export interface SupersededPair {
  offer: Offer;
  change: DealChange;
}

export interface SupersededCensus {
  records_with_superseded_terms: number;
  vendor_pages_withholding_superseded_terms: number;
  ungated_pages_withholding_superseded_terms: number;
}

export function changesByVendor(changes: readonly DealChange[]): Map<string, DealChange[]> {
  const byVendor = new Map<string, DealChange[]>();
  for (const change of changes) {
    const key = change.vendor.toLowerCase();
    const held = byVendor.get(key);
    if (held) held.push(change);
    else byVendor.set(key, [change]);
  }
  return byVendor;
}

export function supersededRecords(
  offers: readonly Offer[],
  changes: readonly DealChange[],
): SupersededPair[] {
  const byVendor = changesByVendor(changes);
  const found: SupersededPair[] = [];
  for (const offer of offers) {
    const change = supersedingChange(offer, byVendor.get(offer.vendor.toLowerCase()) ?? []);
    if (change) found.push({ offer, change });
  }
  return found;
}

export function primaryOfferFor(offers: readonly Offer[], vendor: string): Offer | null {
  return offers.find((offer) => offer.vendor === vendor) ?? null;
}

export function supersededCensus(
  offers: readonly Offer[],
  changes: readonly DealChange[],
  date: string,
): SupersededCensus {
  const superseded = supersededRecords(offers, changes);
  const supersededOffers = new Set(superseded.map(({ offer }) => offer));

  let vendorPages = 0;
  for (const { offer } of superseded) {
    if (primaryOfferFor(offers, offer.vendor) === offer) vendorPages++;
  }

  let ungatedPages = 0;
  for (const vendor of vendorSlugMap.values()) {
    const primary = primaryOfferFor(offers, vendor);
    if (!primary) continue;
    if (gateFor(primary, date)) continue;
    if (supersededOffers.has(primary)) ungatedPages++;
  }

  return {
    records_with_superseded_terms: superseded.length,
    vendor_pages_withholding_superseded_terms: vendorPages,
    ungated_pages_withholding_superseded_terms: ungatedPages,
  };
}
