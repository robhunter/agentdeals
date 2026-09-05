import type { DealChange } from "./types.js";

export type ChangeDirection = "negative" | "positive" | "neutral";

export const CHANGE_DIRECTION: Record<DealChange["change_type"], ChangeDirection> = {
  free_tier_removed: "negative",
  open_source_killed: "negative",
  product_deprecated: "negative",
  limits_reduced: "negative",
  restriction: "negative",
  pricing_restructured: "negative",
  pricing_model_change: "negative",
  limits_increased: "positive",
  new_free_tier: "positive",
  new_tier: "positive",
  startup_program_expanded: "positive",
  pricing_postponed: "positive",
  rebranded: "neutral",
  record_corrected: "neutral",
};

export function directionOfChange(changeType: string): ChangeDirection | null {
  return CHANGE_DIRECTION[changeType as DealChange["change_type"]] ?? null;
}

export function narrowsTheStoredTerms(changeType: string): boolean {
  const direction = directionOfChange(changeType);
  return direction === null || direction === "negative";
}
