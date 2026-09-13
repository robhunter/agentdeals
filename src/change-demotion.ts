import type { DealChange } from "./types.js";

export const RISK_DEMOTION: Record<DealChange["change_type"], "risky" | "caution" | null> = {
  free_tier_removed: "risky",
  open_source_killed: "risky",
  limits_reduced: "caution",
  pricing_restructured: "caution",
  restriction: "caution",
  pricing_model_change: "caution",
  limits_increased: null,
  new_free_tier: null,
  new_tier: null,
  startup_program_expanded: null,
  pricing_postponed: null,
  rebranded: null,
  record_corrected: null,
  product_deprecated: null,
};

export const SEVERE_TYPES_WITHOUT_FLAT_DEMOTION: Record<string, string> = {
  product_deprecated:
    "Whether a deprecation is severe is a property of the record, not of the type: it demotes when " +
    "the record says the product we list is the thing going away, and does not when a vendor retires " +
    "one of its other services. demotionForChange decides per record.",
};

export function changeTypeCanDemote(changeType: string): boolean {
  if (RISK_DEMOTION[changeType as DealChange["change_type"]] != null) return true;
  return Object.prototype.hasOwnProperty.call(SEVERE_TYPES_WITHOUT_FLAT_DEMOTION, changeType);
}

export function changeTypesThatCanDemote(): string[] {
  return Object.keys(RISK_DEMOTION).filter(changeTypeCanDemote).sort();
}
