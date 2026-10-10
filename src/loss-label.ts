import { changeGradesTheListedTier, namesADifferentTier, type GradedOffer, type TieredChange } from "./change-tier.js";
import { tierRecordsAFreeTier } from "./free-tier-record.js";
import {
  countsAsANegativeChange,
  deprecationCall,
  PRODUCT_DEPRECATED,
  type DeprecationCall,
  type DeprecationSubject,
} from "./product-deprecation.js";
import { classifyTier } from "./ranking.js";
import type { DealChange } from "./types.js";

export const LOSS_LABELS = [
  "free tier removed",
  "free tier limits reduced",
  "new free-tier restriction",
  "product ends; its free plan ends with it",
  "part of the product ends; the free tier narrows",
  "a product ends; the listed free tier stays",
  "open-source licence withdrawn",
  "free tier reduced",
  "paid pricing changed",
  "pricing changed",
] as const;

export type LossLabel = (typeof LOSS_LABELS)[number];

export const LOSSES_SECTION_DESCRIPTION = "Vendors whose changes cost users more";

export const PRICE_CHANGE_TYPES: readonly DealChange["change_type"][] = ["pricing_restructured", "pricing_model_change"];

const LABEL_OF_A_TERMS_CHANGE: Partial<Record<DealChange["change_type"], LossLabel>> = {
  free_tier_removed: "free tier removed",
  limits_reduced: "free tier limits reduced",
  restriction: "new free-tier restriction",
  open_source_killed: "open-source licence withdrawn",
};

const LABEL_OF_A_DEPRECATION: Record<DeprecationCall, LossLabel> = {
  ends: "product ends; its free plan ends with it",
  narrows: "part of the product ends; the free tier narrows",
  none: "a product ends; the listed free tier stays",
};

export type LabelledChange = TieredChange & DeprecationSubject;

export function isAPriceChange(change: Pick<DealChange, "change_type">): boolean {
  return PRICE_CHANGE_TYPES.includes(change.change_type);
}

export function countsAsALoss(change: LabelledChange): boolean {
  if (!countsAsANegativeChange(change)) return false;
  if (change.tier_direction === "widened") return false;
  return !(change.tier_direction === "unchanged" && !isAPriceChange(change));
}

export function lossLabel(change: LabelledChange, listing: GradedOffer | null): LossLabel {
  if (change.change_type === PRODUCT_DEPRECATED) return LABEL_OF_A_DEPRECATION[deprecationCall(change)];
  return LABEL_OF_A_TERMS_CHANGE[change.change_type] ?? priceChangeLabel(change, listing);
}

function priceChangeLabel(change: LabelledChange, listing: GradedOffer | null): LossLabel {
  const listedTierIsFree = listing !== null && tierRecordsAFreeTier(listing.tier ?? "");
  if (change.tier_direction === "narrowed" && listedTierIsFree && changeGradesTheListedTier(change, listing)) {
    return "free tier reduced";
  }
  const listedTierIsPaid = listing !== null && classifyTier(listing.tier ?? "").class === "not_free";
  if (change.tier_direction === "unchanged" || listedTierIsPaid || namesADifferentTier(change, listing?.tier)) {
    return "paid pricing changed";
  }
  return "pricing changed";
}

export function lossLabelsOf(changes: readonly LabelledChange[], listing: GradedOffer | null): string {
  const labels = new Set(changes.map((change) => lossLabel(change, listing)));
  return LOSS_LABELS.filter((label) => labels.has(label)).join("; ");
}
