import { recordsWeStandBehind } from "./change-resolution.js";
import { quantitiesNotIn, quantitiesStatedThroughDescribingWords } from "./quoted-figures.js";
import type { ChangeResolution } from "./types.js";

export const NO_RECORD_BEHIND_THIS_FIGURE = "Hand-typed — we hold no record";
export const FIGURE_NOT_IN_OUR_RECORD = "Hand-typed — not in our record";

type HeldChange = { current_state?: string; resolution?: ChangeResolution | null };

export function statementsWeHold(listingDescriptions: readonly string[], changes: readonly HeldChange[]): string[] {
  const recorded = recordsWeStandBehind(changes)
    .map(change => change.current_state)
    .filter((state): state is string => typeof state === "string");
  return [...listingDescriptions, ...recorded];
}

export function figureProvenanceAgainst(claim: string, held: readonly string[]): string | null {
  if (held.length === 0) return NO_RECORD_BEHIND_THIS_FIGURE;
  if (quantitiesStatedThroughDescribingWords(claim).length === 0) return FIGURE_NOT_IN_OUR_RECORD;
  return quantitiesNotIn(claim, held).length === 0 ? null : FIGURE_NOT_IN_OUR_RECORD;
}
