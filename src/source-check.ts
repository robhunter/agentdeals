import type { Offer, SourceCheck, SourceCheckOutcome } from "./types.js";

export const SOURCE_CHECK_OUTCOMES: SourceCheckOutcome[] = [
  "ok",
  "does_not_name_vendor",
  "states_no_terms",
  "unreadable",
];

export type LevelWithheldReason = "link_unreachable" | "does_not_name_vendor" | "unreadable";

export const LEVEL_WITHHOLDING_OUTCOMES: SourceCheckOutcome[] = [
  "does_not_name_vendor",
  "unreadable",
];

export function sourceDoesNotNameVendor(offer: Pick<Offer, "source_check">): boolean {
  return offer.source_check?.outcome === "does_not_name_vendor";
}

export function sourceUnreadable(offer: Pick<Offer, "source_check">): boolean {
  return offer.source_check?.outcome === "unreadable";
}

export function sourceCheckNotice(offer: Pick<Offer, "source_check">): SourceCheck | null {
  const check = offer.source_check;
  if (!check || check.outcome === "ok") return null;
  return check;
}

export function levelWithheldReason(
  offer: Pick<Offer, "source_check">,
  linkUnreachable: unknown,
): LevelWithheldReason | null {
  if (linkUnreachable) return "link_unreachable";
  const outcome = offer.source_check?.outcome;
  if (outcome && LEVEL_WITHHOLDING_OUTCOMES.includes(outcome)) return outcome as LevelWithheldReason;
  return null;
}

export function cannotVouchForLevel(
  offer: Pick<Offer, "source_check">,
  linkUnreachable: unknown,
): boolean {
  return levelWithheldReason(offer, linkUnreachable) !== null;
}
