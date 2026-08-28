import type { Offer, SourceCheck, SourceCheckOutcome } from "./types.js";

export const SOURCE_CHECK_OUTCOMES: SourceCheckOutcome[] = [
  "ok",
  "does_not_name_vendor",
  "states_no_terms",
  "unreadable",
];

export type LevelWithheldReason =
  | "link_unreachable"
  | "does_not_name_vendor"
  | "states_no_terms"
  | "unreadable";

export const LEVEL_WITHHOLDING_OUTCOMES: SourceCheckOutcome[] = [
  "does_not_name_vendor",
  "states_no_terms",
  "unreadable",
];

const WITHHELD_LEVEL_CLAUSES: Record<LevelWithheldReason, (since: string) => string> = {
  link_unreachable: (since) => `its pricing page has not resolved for us${since}`,
  does_not_name_vendor: () => `the page we cite for this offer does not name it`,
  states_no_terms: () => `the page we cite for this offer states no terms we can read`,
  unreadable: () => `we could not read the page we cite for this offer`,
};

const WITHHELD_LEVEL_SENTENCES: Record<LevelWithheldReason, (subject: string, since: string) => string> = {
  link_unreachable: (subject, since) => `${subject}'s pricing page has not resolved for us${since}.`,
  does_not_name_vendor: (subject) => `The page we cite for ${subject} does not name it.`,
  states_no_terms: (subject) => `The page we cite for ${subject} states no terms we can read.`,
  unreadable: (subject) => `We could not read the page we cite for ${subject}.`,
};

export function withheldLevelClause(reason: LevelWithheldReason, since = ""): string {
  return WITHHELD_LEVEL_CLAUSES[reason](since);
}

export function withheldLevelSentence(
  reason: LevelWithheldReason,
  subject: string,
  since = "",
): string {
  return WITHHELD_LEVEL_SENTENCES[reason](subject, since);
}

export function sourceDoesNotNameVendor(offer: Pick<Offer, "source_check">): boolean {
  return offer.source_check?.outcome === "does_not_name_vendor";
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
