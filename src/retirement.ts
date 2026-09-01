import type { Offer } from "./types.js";

const RETIRED_TIER = /\b(?:retired|deprecated|discontinued|sunset|withdrawn)\b/i;

export const ENDED_TIERS = ["Retired", "Discontinued", "Sunset", "Withdrawn"] as const;

const ENDED_TIER_SET = new Set<string>(ENDED_TIERS.map(t => t.toLowerCase()));

export type OfferTierAndUrl = Pick<Offer, "tier" | "url">;

export function offerRetired(offer: Pick<Offer, "tier"> | null | undefined): boolean {
  return RETIRED_TIER.test(offer?.tier ?? "");
}

export function offerEnded(offer: Pick<Offer, "tier"> | null | undefined): boolean {
  return ENDED_TIER_SET.has((offer?.tier ?? "").trim().toLowerCase());
}

export function recordedTierSentence(vendorName: string, tier: string): string {
  return `${vendorName}'s offer is recorded as ${tier}.`;
}
