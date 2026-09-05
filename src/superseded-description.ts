import { changeDateClause } from "./change-dates.js";
import { isNoLongerInForce } from "./change-resolution.js";
import type { ChangeResolution, DealChange } from "./types.js";

export interface QuotingChange extends Pick<DealChange, "date" | "date_source"> {
  summary: string;
  previous_state?: string | null;
  resolution?: ChangeResolution | null;
}

export interface StoredTerms {
  vendor: string;
  description: string;
}

function comparableTerms(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function quotesTheStoredTermsAsPrevious(change: QuotingChange, description: string): boolean {
  const quoted = comparableTerms(change.previous_state);
  return quoted !== "" && quoted === comparableTerms(description);
}

export function supersedingChange<T extends QuotingChange>(
  offer: Pick<StoredTerms, "description">,
  vendorChanges: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const change of vendorChanges) {
    if (isNoLongerInForce(change)) continue;
    if (!quotesTheStoredTermsAsPrevious(change, offer.description)) continue;
    if (!newest || change.date > newest.date) newest = change;
  }
  return newest;
}

export function storedTermsAreSuperseded(
  offer: Pick<StoredTerms, "description">,
  vendorChanges: readonly QuotingChange[],
): boolean {
  return supersedingChange(offer, vendorChanges) !== null;
}

export const SUPERSEDED_TERMS_LABEL = "Superseded";

export function supersededTermsNotice(vendor: string, change: QuotingChange): string {
  return (
    `The terms we store for ${vendor} are the ones our own pricing change record, ` +
    `${changeDateClause(change)}, names as the previous ones. We have not re-read ${vendor}'s ` +
    `pricing page since that record, so we are not publishing them as current.`
  );
}

export function supersededTermsAnswer(vendor: string, change: QuotingChange): string {
  return (
    `We are not answering that from our stored terms today. Our pricing change record, ` +
    `${changeDateClause(change)}, names them as the previous terms: ${change.summary} ` +
    `We have not re-read ${vendor}'s pricing page since, so the recorded change is what we stand behind, ` +
    `not the figures it replaces.`
  );
}

export function supersededTermsMetaSentence(vendor: string, change: QuotingChange): string {
  return (
    `Our stored ${vendor} free-tier terms are superseded by a pricing change we recorded on ` +
    `${change.date} and have not re-read since.`
  );
}

export function supersededTermsVerdictSentence(vendor: string, change: QuotingChange): string {
  return (
    `We are not publishing ${vendor}'s stored free-tier figures — our pricing change record, ` +
    `${changeDateClause(change)}, names them as the previous ones.`
  );
}
