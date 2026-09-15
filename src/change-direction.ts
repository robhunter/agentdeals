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

export const CHANGE_TYPE_MEANING: Record<DealChange["change_type"], string> = {
  free_tier_removed: "The free tier ended.",
  open_source_killed: "An open-source licence was withdrawn or replaced.",
  product_deprecated: "The product or programme was discontinued.",
  limits_reduced: "The free tier survives with smaller allowances.",
  restriction: "A new condition on who may use the free tier, or for what.",
  pricing_restructured: "Published prices moved, or what a plan includes was rearranged.",
  pricing_model_change: "What the vendor bills for changed — seats to usage, or similar.",
  limits_increased: "The free tier's allowances grew.",
  new_free_tier: "A free tier exists where we held none.",
  new_tier: "A plan was added alongside the ones already published.",
  startup_program_expanded: "A startup programme's credits or eligibility widened.",
  pricing_postponed: "An announced increase was deferred.",
  rebranded: "The product or plan was renamed and the terms stood.",
  record_corrected: "We corrected a record of our own. It says nothing about the vendor.",
};

export interface DirectedChangeType {
  code: DealChange["change_type"];
  meaning: string;
  direction: ChangeDirection;
}

export function changeDirectionTable(): DirectedChangeType[] {
  return (Object.keys(CHANGE_DIRECTION) as Array<DealChange["change_type"]>).map((code) => ({
    code,
    meaning: CHANGE_TYPE_MEANING[code],
    direction: CHANGE_DIRECTION[code],
  }));
}

const typesDirected = (d: ChangeDirection): Set<string> =>
  new Set(Object.entries(CHANGE_DIRECTION).filter(([, v]) => v === d).map(([k]) => k));

export const NEGATIVE_CHANGE_TYPES = typesDirected("negative");
export const POSITIVE_CHANGE_TYPES = typesDirected("positive");
export const NEUTRAL_CHANGE_TYPES = typesDirected("neutral");

export function directionOfChange(changeType: string): ChangeDirection | null {
  return CHANGE_DIRECTION[changeType as DealChange["change_type"]] ?? null;
}

export function narrowsTheStoredTerms(changeType: string): boolean {
  const direction = directionOfChange(changeType);
  return direction === null || direction === "negative";
}

export interface DirectedChange extends Pick<DealChange, "change_type"> {
  tier_direction?: DealChange["tier_direction"];
}

export function readingDescribesNoNarrowing(change: DirectedChange): boolean {
  const direction = change.tier_direction;
  if (direction !== "unchanged" && direction !== "widened") return false;
  return narrowsTheStoredTerms(change.change_type);
}

export const RATIO_ROUNDING_TOLERANCE = 0.25;

export function directionRatioLabel(negative: number, positive: number): string {
  if (positive <= 0) return `${negative}:0`;
  const exact = negative / positive;
  const whole = Math.round(exact);
  if (Math.abs(exact - whole) <= RATIO_ROUNDING_TOLERANCE) return `${whole}:1`;
  return `${exact.toFixed(1)}:1`;
}
