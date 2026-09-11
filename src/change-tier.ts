import { readingDescribesNoNarrowing } from "./change-direction.js";
import { tierRecordsASelfHostedEdition } from "./free-tier-record.js";
import { namesTheVendorsHostedEdition } from "./superseding-reading.js";
import type { DealChange } from "./types.js";

export interface TieredChange extends Pick<DealChange, "change_type"> {
  tier?: string | null;
  tier_direction?: DealChange["tier_direction"];
  current_state?: string | null;
}

export interface GradedOffer {
  vendor: string;
  tier?: string;
}

export const VERDICTS_ABOUT_THE_EDITION_ITSELF: readonly string[] = [
  "open_source_killed",
  "product_deprecated",
];

export function comparableTerms(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function namesADifferentTier(change: TieredChange, tier: string | undefined): boolean {
  const named = comparableTerms(change.tier);
  return named !== "" && named !== comparableTerms(tier);
}

export function readingGradesTheHostedEdition(change: TieredChange, offer: GradedOffer): boolean {
  if (VERDICTS_ABOUT_THE_EDITION_ITSELF.includes(change.change_type)) return false;
  if (!tierRecordsASelfHostedEdition(offer.tier ?? "")) return false;
  return namesTheVendorsHostedEdition(change.current_state ?? "", offer.vendor);
}

export function changeGradesTheListedTier(change: TieredChange, offer: GradedOffer): boolean {
  if (namesADifferentTier(change, offer.tier)) return false;
  return !readingGradesTheHostedEdition(change, offer);
}

export function changeRatesTheListedTier(change: TieredChange, offer: GradedOffer): boolean {
  if (readingDescribesNoNarrowing(change)) return false;
  return changeGradesTheListedTier(change, offer);
}
