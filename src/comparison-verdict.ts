import { withheldLevelSentence, type LevelWithheldReason } from "./source-check.js";

export type StabilityRating = "stable" | "caution" | "risky";

export interface ComparisonSide {
  vendor: string;
  recordedChanges: number;
  rating: StabilityRating | null;
  ratingWithheldBecause: LevelWithheldReason | null;
  unconfirmableSince: string;
}

export function ratingIsWithheld(side: ComparisonSide): boolean {
  return side.rating === null;
}

export function recordedChangesPhrase(count: number): string {
  return `${count} recorded change${count === 1 ? "" : "s"}`;
}

export function moreStableSide(a: ComparisonSide, b: ComparisonSide): ComparisonSide | null {
  if (ratingIsWithheld(a) || ratingIsWithheld(b)) return null;
  if (a.rating === b.rating) return null;
  const stabler = a.rating === "stable" ? a : b.rating === "stable" ? b : null;
  if (!stabler) return null;
  const other = stabler === a ? b : a;
  return stabler.recordedChanges < other.recordedChanges ? stabler : null;
}

function whyWithheld(side: ComparisonSide): string {
  return side.ratingWithheldBecause
    ? withheldLevelSentence(side.ratingWithheldBecause, side.vendor, side.unconfirmableSince)
    : `We are not publishing a stability rating for ${side.vendor}.`;
}

export function stabilityVerdictClause(a: ComparisonSide, b: ComparisonSide): string {
  const withheld = [a, b].filter(ratingIsWithheld);
  if (withheld.length > 0) {
    return `${withheld.map(whyWithheld).join(" ")} We are not comparing the two pricing histories.`;
  }
  const stabler = moreStableSide(a, b);
  if (!stabler) return "";
  const other = stabler === a ? b : a;
  return `${stabler.vendor} has a more stable pricing history (${recordedChangesPhrase(stabler.recordedChanges)} vs ${other.recordedChanges}).`;
}

export function stabilityFaqAnswer(a: ComparisonSide, b: ComparisonSide): string {
  const stated = (side: ComparisonSide) =>
    `${side.vendor} has ${recordedChangesPhrase(side.recordedChanges)}${side.rating ? ` and is rated ${side.rating}` : ""}.`;
  const clause = stabilityVerdictClause(a, b);
  return `${stated(a)} ${stated(b)}${clause ? ` ${clause}` : ""}`;
}
