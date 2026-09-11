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

export type RefusedRead = Pick<ChangeRefusal, "reason" | "refused_date">;

export function refusalConfirmsTheStoredTerms(refusal: Pick<ChangeRefusal, "reason">): boolean {
  return CONFIRMING_REASONS.has(refusal.reason);
}

function mostRecent(refusals: readonly RefusedRead[]): RefusedRead | null {
  let held: RefusedRead | null = null;
  for (const refusal of refusals) {
    if (held === null || refusal.refused_date > held.refused_date) held = refusal;
  }
  return held === null ? null : { reason: held.reason, refused_date: held.refused_date };
}

export function unreconciledRead(refusals: readonly RefusedRead[]): RefusedRead | null {
  return mostRecent(refusals.filter(r => !refusalConfirmsTheStoredTerms(r)));
}

export interface StabilityEvidence {
  historyLevel: string | null;
  publishedChanges: number;
  refusals: readonly RefusedRead[];
}

export function readNotReconciled(state: StabilityEvidence): RefusedRead | null {
  if (state.historyLevel !== "stable") return null;
  if (state.publishedChanges > 0) return null;
  return unreconciledRead(state.refusals);
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

export const UNRECONCILED_READ_BADGE_LABEL = "unrated — change not reconciled";

export function unreconciledReadClause(refusedOn: string): string {
  return `when we last read the page we cite for this offer, on ${refusedOn},`
    + ` we found a change we could not reconcile with the terms we publish`;
}

export function unreconciledReadSentence(subject: string, refusedOn: string): string {
  return `When we last read the page we cite for ${subject}, on ${refusedOn},`
    + ` we found a change we could not reconcile with the terms we publish for it.`;
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
