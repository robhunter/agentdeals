export interface ChangeRefusal {
  vendor: string;
  change_type: string;
  reason: string;
  detail: string | null;
  summary: string | null;
  previous_state: string | null;
  current_state: string | null;
  source_url: string | null;
  category: string | null;
  refused_date: string;
}

export interface ChangeRefusalIndex {
  refusals: ChangeRefusal[];
}

export const REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS = [
  "confirmed_unchanged",
  "free_tier_still_offered",
] as const;

export type ConfirmingRefusalReason =
  (typeof REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS)[number];

const CONFIRMING_REASONS = new Set<string>(REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS);

const CONFIRMING_REASON_CLAUSES: Record<ConfirmingRefusalReason, string> = {
  confirmed_unchanged: "the change we last considered recording restated the terms we already publish",
  free_tier_still_offered:
    "the change we last considered recording proposed removing a free tier the page still offers",
};

export const REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE = [
  "measures_no_change",
  "states_no_difference",
  "null_comparison",
  "restates_stored_quantities",
] as const;

const MEASURED_NO_DIFFERENCE_REASONS = new Set<string>(
  REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
);

export const REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING = [
  "states_no_terms",
  "no_price_signal",
  "removal_read_from_root",
  "no_removal_evidence",
  "no_terms_to_narrow",
  "no_baseline",
  "states_no_narrowing",
] as const;

export type VoidingRefusalReason =
  (typeof REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING)[number];

const VOIDING_REASONS = new Set<string>(REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING);

export const READ_NO_TERMS_FROM_THE_PAGE = "could read no amount, tier or rate on the page";

export const WHAT_A_VOIDED_READ_FOUND: Record<VoidingRefusalReason, string> = {
  states_no_terms: READ_NO_TERMS_FROM_THE_PAGE,
  no_price_signal: READ_NO_TERMS_FROM_THE_PAGE,
  removal_read_from_root: "reached a domain root that states nothing about the terms we hold",
  no_removal_evidence: "found the page did not mention this offer, which is not evidence it ended",
  no_terms_to_narrow: "found no earlier figure of ours for the page to have narrowed",
  no_baseline: "found no earlier figure of ours for the page to have narrowed",
  states_no_narrowing: "found the free tier still standing and no term that had moved",
};

export const REFUSAL_REASONS_THAT_LEAVE_THE_READ_STANDING = [
  "page_does_not_name_vendor",
  "unquantified_limit",
  "removal_read_from_redirect",
  "free_plan_still_described",
  "free_tier_is_the_product",
  "dangling_reference",
  "measures_the_opposite",
  "zero_allowance",
  "removal_does_not_reach_the_licence",
  "same_transition_graded_differently",
] as const;

export type RefusedRead = Pick<ChangeRefusal, "reason" | "refused_date">;

export interface RefusedReadWeHold extends RefusedRead {
  read_again_on: string | null;
}

export function refusalConfirmsTheStoredTerms(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return CONFIRMING_REASONS.has(refusal.reason);
}

export function refusalMeasuredNoDifference(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return MEASURED_NO_DIFFERENCE_REASONS.has(refusal.reason);
}

export function refusalVoidsTheReadsStanding(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return VOIDING_REASONS.has(refusal.reason);
}

function mostRecent(refusals: readonly RefusedRead[]): RefusedRead | null {
  let held: RefusedRead | null = null;
  for (const refusal of refusals) {
    if (held === null || refusal.refused_date > held.refused_date) held = refusal;
  }
  return held === null ? null : { reason: held.reason, refused_date: held.refused_date };
}

export function refusalPredatesConfirmation(
  refusal: RefusedRead,
  termsConfirmedOn: string,
): boolean {
  return refusal.refused_date < termsConfirmedOn;
}

export type ReadSettlement =
  | "restated_the_terms_we_publish"
  | "named_no_figure_that_moved"
  | "had_no_standing_to_contradict";

export interface SettledRead {
  settlement: ReadSettlement;
  refusal: RefusedRead;
}

export function refusalSettledTheRead(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return refusalConfirmsTheStoredTerms(refusal)
    || refusalMeasuredNoDifference(refusal)
    || refusalVoidsTheReadsStanding(refusal);
}

export function howWeSettledTheRead(
  refusals: readonly RefusedRead[],
  read: string,
): SettledRead | null {
  const sameRead = refusals.filter(r => r.refused_date === read);
  if (sameRead.length === 0) return null;
  if (sameRead.some(r => !refusalSettledTheRead(r))) return null;
  const confirming = mostRecent(sameRead.filter(refusalConfirmsTheStoredTerms));
  if (confirming) return { settlement: "restated_the_terms_we_publish", refusal: confirming };
  const measured = mostRecent(sameRead.filter(refusalMeasuredNoDifference));
  if (measured) return { settlement: "named_no_figure_that_moved", refusal: measured };
  return { settlement: "had_no_standing_to_contradict", refusal: mostRecent(sameRead)! };
}

function latestRead(refusals: readonly RefusedRead[]): RefusedRead | null {
  let held: RefusedRead | null = null;
  for (const refusal of refusals) {
    if (held === null || refusal.refused_date > held.refused_date) {
      held = refusal;
      continue;
    }
    if (
      refusal.refused_date === held.refused_date
      && refusalMeasuredNoDifference(held)
      && !refusalMeasuredNoDifference(refusal)
    ) {
      held = refusal;
    }
  }
  return held === null ? null : { reason: held.reason, refused_date: held.refused_date };
}

export function readAgainAfterTheRefusal(refusal: RefusedRead, lastReadOn: string): string | null {
  return lastReadOn > refusal.refused_date ? lastReadOn : null;
}

export function refusedReadThatWithholds(
  refusals: readonly RefusedRead[],
  termsConfirmedOn: string,
  lastReadOn: string,
): RefusedReadWeHold | null {
  const held = latestRead(
    refusals.filter(
      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn),
    ),
  );
  return held === null ? null : { ...held, read_again_on: readAgainAfterTheRefusal(held, lastReadOn) };
}

export interface StabilityEvidence {
  historyLevel: string | null;
  publishedChanges: number;
  termsConfirmedOn: string;
  lastReadOn: string;
  refusals: readonly RefusedRead[];
}

export function refusedReadWithholdingStability(state: StabilityEvidence): RefusedReadWeHold | null {
  if (state.historyLevel !== "stable") return null;
  if (state.publishedChanges > 0) return null;
  return refusedReadThatWithholds(state.refusals, state.termsConfirmedOn, state.lastReadOn);
}

export function refusedReadTheConfirmationSupersedes(
  refusals: readonly RefusedRead[],
  termsConfirmedOn: string,
): RefusedRead | null {
  return latestRead(
    refusals.filter(
      r => !refusalConfirmsTheStoredTerms(r) && refusalPredatesConfirmation(r, termsConfirmedOn),
    ),
  );
}

export function confirmingRead(refusals: readonly RefusedRead[]): RefusedRead | null {
  return mostRecent(refusals.filter(refusalConfirmsTheStoredTerms));
}

const CONFIRMING_REASON_SENTENCES: Record<ConfirmingRefusalReason, (subject: string) => string> = {
  confirmed_unchanged: (subject) =>
    `The last change we considered recording for ${subject} restated the terms we already publish, so we published none.`,
  free_tier_still_offered: (subject) =>
    `The last change we considered recording for ${subject} proposed removing a free tier the page still offers, so we published none.`,
};

export function confirmingReadClause(refusal: RefusedRead): string {
  return CONFIRMING_REASON_CLAUSES[refusal.reason as ConfirmingRefusalReason];
}

export function confirmingReadSentence(subject: string, refusal: RefusedRead): string {
  return CONFIRMING_REASON_SENTENCES[refusal.reason as ConfirmingRefusalReason](subject);
}

export function supersededRefusalClause(refusedOn: string, confirmedOn: string): string {
  return `the change we last considered recording was refused on ${refusedOn},`
    + ` and we read the page again on ${confirmedOn} and confirmed the terms above`;
}

export function supersededRefusalSentence(
  subject: string,
  refusedOn: string,
  confirmedOn: string,
): string {
  return `We refused the change we last considered recording for ${subject} on ${refusedOn},`
    + ` then read the page again on ${confirmedOn} and confirmed the terms we publish for it.`;
}

export const UNRECONCILED_READ_BADGE_LABEL = "unrated — change not reconciled";
export const MEASURED_NO_DIFFERENCE_BADGE_LABEL = "unrated — change refused";
export const READ_HAD_NO_STANDING_BADGE_LABEL = "unrated — change not established";

export function unreconciledReadClause(refusedOn: string): string {
  return `when we last read the page we cite for this offer, on ${refusedOn},`
    + ` we found a change we could not reconcile with the terms we publish`;
}

export function unreconciledReadSentence(subject: string, refusedOn: string): string {
  return `When we last read the page we cite for ${subject}, on ${refusedOn},`
    + ` we found a change we could not reconcile with the terms we publish for it.`;
}

export function measuredNoDifferenceClause(refusedOn: string): string {
  return `when we last read the page we cite for this offer, on ${refusedOn},`
    + ` we refused the change we considered recording because it named no figure that had moved,`
    + ` and refusing a change is not a confirmation of the terms above`;
}

export function measuredNoDifferenceSentence(subject: string, refusedOn: string): string {
  return `When we last read the page we cite for ${subject}, on ${refusedOn},`
    + ` we refused the change we considered recording because it named no figure that had moved,`
    + ` and refusing a change is not a confirmation of the terms we publish for it.`;
}

export function unreconciledReadThenReadAgainClause(refusedOn: string, readOn: string): string {
  return `when we read the page we cite for this offer on ${refusedOn},`
    + ` we found a change we could not reconcile with the terms we publish,`
    + ` and we have read it again since, on ${readOn}, without confirming them`;
}

export function unreconciledReadThenReadAgainSentence(
  subject: string,
  refusedOn: string,
  readOn: string,
): string {
  return `When we read the page we cite for ${subject} on ${refusedOn},`
    + ` we found a change we could not reconcile with the terms we publish for it,`
    + ` and we have read it again since, on ${readOn}, without confirming them.`;
}

export function measuredNoDifferenceThenReadAgainClause(refusedOn: string, readOn: string): string {
  return `when we read the page we cite for this offer on ${refusedOn},`
    + ` we refused the change we considered recording because it named no figure that had moved,`
    + ` and we have read it again since, on ${readOn}, without confirming the terms above`;
}

export function measuredNoDifferenceThenReadAgainSentence(
  subject: string,
  refusedOn: string,
  readOn: string,
): string {
  return `When we read the page we cite for ${subject} on ${refusedOn},`
    + ` we refused the change we considered recording because it named no figure that had moved,`
    + ` and we have read it again since, on ${readOn}, without confirming the terms we publish for it.`;
}

export function unreconciledReadMetaClause(refusedOn: string): string {
  return `our last read, on ${refusedOn}, found a change we could not reconcile`;
}

export function unreconciledReadThenReadAgainMetaClause(refusedOn: string, readOn: string): string {
  return `our read of ${refusedOn} found a change we could not reconcile,`
    + ` and our read of ${readOn} did not confirm the terms`;
}

export function measuredNoDifferenceMetaClause(refusedOn: string): string {
  return `we refused the change we last considered recording, on ${refusedOn}`;
}

export function measuredNoDifferenceThenReadAgainMetaClause(refusedOn: string, readOn: string): string {
  return `we refused the change we considered recording on ${refusedOn},`
    + ` and our read of ${readOn} did not confirm the terms`;
}

export function readHadNoStandingClause(refusedOn: string, found: string): string {
  return `when we last read the page we cite for this offer, on ${refusedOn}, we ${found}`;
}

export function readHadNoStandingSentence(subject: string, refusedOn: string, found: string): string {
  return `When we last read the page we cite for ${subject}, on ${refusedOn}, we ${found}.`;
}

export function readHadNoStandingMetaClause(refusedOn: string, found: string): string {
  return `our last read, on ${refusedOn}, ${found}`;
}

export function readHadNoStandingThenReadAgainClause(
  refusedOn: string,
  readOn: string,
  found: string,
): string {
  return `when we read the page we cite for this offer on ${refusedOn}, we ${found},`
    + ` and we have read it again since, on ${readOn}, without confirming the terms above`;
}

export function readHadNoStandingThenReadAgainSentence(
  subject: string,
  refusedOn: string,
  readOn: string,
  found: string,
): string {
  return `When we read the page we cite for ${subject} on ${refusedOn}, we ${found},`
    + ` and we have read it again since, on ${readOn}, without confirming the terms we publish for it.`;
}

export function readHadNoStandingThenReadAgainMetaClause(
  refusedOn: string,
  readOn: string,
  found: string,
): string {
  return `our read of ${refusedOn} ${found}, and our read of ${readOn} did not confirm the terms`;
}

export const REFUSED_READ_REGISTERS = [
  "could_not_reconcile_the_change",
  "named_no_figure_that_moved",
  "had_no_standing_to_contradict",
] as const;

export type RefusedReadRegister = (typeof REFUSED_READ_REGISTERS)[number];

export interface RefusedReadAs {
  register: RefusedReadRegister;
  refusedOn: string;
  readAgainOn: string | null;
  refusedFor: string;
}

export function refusedReadRegister(refusal: Pick<ChangeRefusal, "reason">): RefusedReadRegister {
  if (refusalMeasuredNoDifference(refusal)) return "named_no_figure_that_moved";
  if (refusalVoidsTheReadsStanding(refusal)) return "had_no_standing_to_contradict";
  return "could_not_reconcile_the_change";
}

export function howARefusedReadReads(refusal: RefusedReadWeHold): RefusedReadAs {
  return {
    register: refusedReadRegister(refusal),
    refusedOn: refusal.refused_date,
    readAgainOn: refusal.read_again_on,
    refusedFor: refusal.reason,
  };
}

function whatAVoidedReadFound(read: RefusedReadAs): string {
  return WHAT_A_VOIDED_READ_FOUND[read.refusedFor as VoidingRefusalReason];
}

interface RefusedReadWording {
  clause: (read: RefusedReadAs) => string;
  sentence: (subject: string, read: RefusedReadAs) => string;
  metaClause: (read: RefusedReadAs) => string;
}

const REFUSED_READ_WORDING: Record<RefusedReadRegister, RefusedReadWording> = {
  could_not_reconcile_the_change: {
    clause: (read) => read.readAgainOn
      ? unreconciledReadThenReadAgainClause(read.refusedOn, read.readAgainOn)
      : unreconciledReadClause(read.refusedOn),
    sentence: (subject, read) => read.readAgainOn
      ? unreconciledReadThenReadAgainSentence(subject, read.refusedOn, read.readAgainOn)
      : unreconciledReadSentence(subject, read.refusedOn),
    metaClause: (read) => read.readAgainOn
      ? unreconciledReadThenReadAgainMetaClause(read.refusedOn, read.readAgainOn)
      : unreconciledReadMetaClause(read.refusedOn),
  },
  named_no_figure_that_moved: {
    clause: (read) => read.readAgainOn
      ? measuredNoDifferenceThenReadAgainClause(read.refusedOn, read.readAgainOn)
      : measuredNoDifferenceClause(read.refusedOn),
    sentence: (subject, read) => read.readAgainOn
      ? measuredNoDifferenceThenReadAgainSentence(subject, read.refusedOn, read.readAgainOn)
      : measuredNoDifferenceSentence(subject, read.refusedOn),
    metaClause: (read) => read.readAgainOn
      ? measuredNoDifferenceThenReadAgainMetaClause(read.refusedOn, read.readAgainOn)
      : measuredNoDifferenceMetaClause(read.refusedOn),
  },
  had_no_standing_to_contradict: {
    clause: (read) => read.readAgainOn
      ? readHadNoStandingThenReadAgainClause(read.refusedOn, read.readAgainOn, whatAVoidedReadFound(read))
      : readHadNoStandingClause(read.refusedOn, whatAVoidedReadFound(read)),
    sentence: (subject, read) => read.readAgainOn
      ? readHadNoStandingThenReadAgainSentence(subject, read.refusedOn, read.readAgainOn, whatAVoidedReadFound(read))
      : readHadNoStandingSentence(subject, read.refusedOn, whatAVoidedReadFound(read)),
    metaClause: (read) => read.readAgainOn
      ? readHadNoStandingThenReadAgainMetaClause(read.refusedOn, read.readAgainOn, whatAVoidedReadFound(read))
      : readHadNoStandingMetaClause(read.refusedOn, whatAVoidedReadFound(read)),
  },
};

export function refusedReadClauseAs(read: RefusedReadAs): string {
  return REFUSED_READ_WORDING[read.register].clause(read);
}

export function refusedReadSentenceAs(subject: string, read: RefusedReadAs): string {
  return REFUSED_READ_WORDING[read.register].sentence(subject, read);
}

export function refusedReadMetaClauseAs(read: RefusedReadAs): string {
  return REFUSED_READ_WORDING[read.register].metaClause(read);
}

export function refusedReadClause(refusal: RefusedReadWeHold): string {
  return refusedReadClauseAs(howARefusedReadReads(refusal));
}

export function refusedReadSentence(subject: string, refusal: RefusedReadWeHold): string {
  return refusedReadSentenceAs(subject, howARefusedReadReads(refusal));
}

export function refusalsByVendor(
  refusals: readonly ChangeRefusal[],
): Map<string, ChangeRefusal[]> {
  const byVendor = new Map<string, ChangeRefusal[]>();
  for (const refusal of refusals) {
    const key = refusal.vendor.toLowerCase();
    const held = byVendor.get(key);
    if (held) held.push(refusal);
    else byVendor.set(key, [refusal]);
  }
  return byVendor;
}
