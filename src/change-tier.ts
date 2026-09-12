import { readingDescribesNoNarrowing } from "./change-direction.js";
import { tierRecordsAFreeTier, tierRecordsASelfHostedEdition } from "./free-tier-record.js";
import { A_FREE_PLAN, namesTheVendorsHostedEdition } from "./superseding-reading.js";
import type { DealChange } from "./types.js";

export interface TieredChange extends Pick<DealChange, "change_type"> {
  tier?: string | null;
  tier_direction?: DealChange["tier_direction"];
  current_state?: string | null;
  summary?: string | null;
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

export function readingSaysTheListedTierNarrowed(change: TieredChange): boolean {
  return change.tier_direction === "narrowed";
}

export function readingNamesTheFreePlanWeList(
  change: TieredChange,
  tier: string | undefined,
): boolean {
  const listed = tier ?? "";
  if (!tierRecordsAFreeTier(listed)) return false;
  if (tierRecordsASelfHostedEdition(listed)) return false;
  return A_FREE_PLAN.test(`${change.summary ?? ""} ${change.current_state ?? ""}`);
}

export function namesADifferentTier(change: TieredChange, tier: string | undefined): boolean {
  const named = comparableTerms(change.tier);
  if (named === "" || named === comparableTerms(tier)) return false;
  if (readingSaysTheListedTierNarrowed(change)) return false;
  return !readingNamesTheFreePlanWeList(change, tier);
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
