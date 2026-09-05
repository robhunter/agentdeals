import type { Offer, SourceCheck, SourceCheckOutcome } from "./types.js";

export const SOURCE_CHECK_OUTCOMES: SourceCheckOutcome[] = [
  "ok",
  "states_no_amount",
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

export const NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE = ["text", "url", "host"];

export const NAMING_TOKENS_TAKEN_FROM_THE_URL_WE_ASKED_FOR = ["url", "host"];

function passedOnDetail(offer: Pick<Offer, "source_check">, tokens: string[]): boolean {
  const check = offer.source_check;
  return check?.outcome === "ok" && tokens.includes(check.detail ?? "");
}

export function passedWithoutQuotingThePage(offer: Pick<Offer, "source_check">): boolean {
  return passedOnDetail(offer, NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE);
}

export function passedOnTheUrlWeAskedFor(offer: Pick<Offer, "source_check">): boolean {
  return passedOnDetail(offer, NAMING_TOKENS_TAKEN_FROM_THE_URL_WE_ASKED_FOR);
}

export function sourceDoesNotNameVendor(offer: Pick<Offer, "source_check">): boolean {
  return offer.source_check?.outcome === "does_not_name_vendor";
}

export function sourceStatesNoAmount(offer: Pick<Offer, "source_check">): boolean {
  return offer.source_check?.outcome === "states_no_amount";
}

export function amountUnstatedSentence(subject: string): string {
  return `The page we cite for ${subject} names a plan but states no amount, so these limits come from our own record rather than from that page.`;
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
