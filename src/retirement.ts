import type { Offer } from "./types.js";

const RETIRED_TIER = /\b(?:retired|deprecated|discontinued|sunset|withdrawn)\b/i;

export type OfferTierAndUrl = Pick<Offer, "tier" | "url">;

export function offerRetired(offer: Pick<Offer, "tier"> | null | undefined): boolean {
  return RETIRED_TIER.test(offer?.tier ?? "");
}

export function recordedTierSentence(vendorName: string, tier: string): string {
  return `${vendorName}'s offer is recorded as ${tier}.`;
}
