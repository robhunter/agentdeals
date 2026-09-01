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

export function listEndedTiers(): string {
  const all = [...ENDED_TIERS];
  const last = all.pop()!;
  return all.length ? `${all.join(", ")} or ${last}` : last;
}

export function recordedTierSentence(vendorName: string, tier: string): string {
  return `${vendorName}'s offer is recorded as ${tier}.`;
}

export const ENDED_OFFER_CLAUSE = "the offer has ended";

export const ENDED_BADGE_LABEL = "retired";

export function endedHeadline(vendorName: string): string {
  return `${vendorName} — free tier retired`;
}

export function endedVerdictSentence(): string {
  return "This offer has ended — we keep the page for the record and no longer rate it.";
}

export function endedHistorySentence(vendorName: string): string {
  return `No recorded pricing changes for ${vendorName} — but ${ENDED_OFFER_CLAUSE}, so this history describes a tier that is no longer available. An empty history is not evidence of stability here.`;
}

export function endedReliabilitySentence(vendorName: string): string {
  return `${vendorName} has ended this offer, so there is nothing to rate. We keep the page so the question has an answer, but a stability judgement only applies to an offer you can still get.`;
}

export function endedEmptyChangeHistorySentence(vendorName: string): string {
  return `${vendorName} has no recorded pricing changes, but ${ENDED_OFFER_CLAUSE} — so the empty history describes a tier that is no longer available, not a stable one.`;
}

export const ENDED_SINCE_CHANGES_SENTENCE = "The offer has since ended.";
