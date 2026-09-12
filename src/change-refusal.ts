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
] as const;

const MEASURED_NO_DIFFERENCE_REASONS = new Set<string>(
  REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
);

export type RefusedRead = Pick<ChangeRefusal, "reason" | "refused_date">;

export function refusalConfirmsTheStoredTerms(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return CONFIRMING_REASONS.has(refusal.reason);
}

export function refusalMeasuredNoDifference(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return MEASURED_NO_DIFFERENCE_REASONS.has(refusal.reason);
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

export function refusedReadThatWithholds(
  refusals: readonly RefusedRead[],
  termsConfirmedOn: string,
): RefusedRead | null {
  return latestRead(
    refusals.filter(
      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn),
    ),
  );
}

export interface StabilityEvidence {
  historyLevel: string | null;
  publishedChanges: number;
  termsConfirmedOn: string;
  refusals: readonly RefusedRead[];
}

export function refusedReadWithholdingStability(state: StabilityEvidence): RefusedRead | null {
  if (state.historyLevel !== "stable") return null;
  if (state.publishedChanges > 0) return null;
  return refusedReadThatWithholds(state.refusals, state.termsConfirmedOn);
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

export function unreconciledReadMetaClause(refusedOn: string): string {
  return `our last read, on ${refusedOn}, found a change we could not reconcile`;
}

export function measuredNoDifferenceMetaClause(refusedOn: string): string {
  return `we refused the change we last considered recording, on ${refusedOn}`;
}

export function refusedReadClause(refusal: RefusedRead): string {
  return refusalMeasuredNoDifference(refusal)
    ? measuredNoDifferenceClause(refusal.refused_date)
    : unreconciledReadClause(refusal.refused_date);
}

export function refusedReadSentence(subject: string, refusal: RefusedRead): string {
  return refusalMeasuredNoDifference(refusal)
    ? measuredNoDifferenceSentence(subject, refusal.refused_date)
    : unreconciledReadSentence(subject, refusal.refused_date);
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
