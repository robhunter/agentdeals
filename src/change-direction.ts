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

export const RATIO_ROUNDING_TOLERANCE = 0.25;

export function directionRatioLabel(negative: number, positive: number): string {
  if (positive <= 0) return `${negative}:0`;
  const exact = negative / positive;
  const whole = Math.round(exact);
  if (Math.abs(exact - whole) <= RATIO_ROUNDING_TOLERANCE) return `${whole}:1`;
  return `${exact.toFixed(1)}:1`;
}
