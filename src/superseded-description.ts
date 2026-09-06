import { changeCitesASource, citationLabel } from "./change-citation.js";
import { changeDateClause } from "./change-dates.js";
import { narrowsTheStoredTerms } from "./change-direction.js";
import { isNoLongerInForce } from "./change-resolution.js";
import { carriesAnUnrenderedExpression } from "./unrendered-text.js";
import type { ChangeResolution, DealChange } from "./types.js";

export interface QuotingChange extends Pick<DealChange, "date" | "date_source" | "change_type"> {
  summary: string;
  previous_state?: string | null;
  current_state?: string | null;
  source_url?: string | null;
  recorded_date?: string | null;
  resolution?: ChangeResolution | null;
}

export interface StoredTerms {
  vendor: string;
  description: string;
}

export interface SourcedReading {
  date: string;
  url: string;
  label: string;
  terms: string;
}

function comparableTerms(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function quotesTheStoredTermsAsPrevious(change: QuotingChange, description: string): boolean {
  const quoted = comparableTerms(change.previous_state);
  return quoted !== "" && quoted === comparableTerms(description);
}

export function supersedesTheStoredTerms(change: QuotingChange, description: string): boolean {
  if (isNoLongerInForce(change)) return false;
  if (!narrowsTheStoredTerms(change.change_type)) return false;
  return quotesTheStoredTermsAsPrevious(change, description);
}

export function supersedingChange<T extends QuotingChange>(
  offer: Pick<StoredTerms, "description">,
  vendorChanges: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const change of vendorChanges) {
    if (!supersedesTheStoredTerms(change, offer.description)) continue;
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

export function readingBehindTheChange(change: QuotingChange): SourcedReading | null {
  const terms = (change.current_state ?? "").trim();
  if (terms === "" || carriesAnUnrenderedExpression(terms)) return null;
  if (!changeCitesASource(change)) return null;
  const url = change.source_url!.trim();
  return {
    date: (change.recorded_date ?? "").trim() || change.date,
    url,
    label: citationLabel(url),
    terms,
  };
}

export function openingOfTerms(terms: string, cap: number): string {
  const text = terms.trim();
  if (text.length <= cap) return text;
  let wholeSentences = "";
  for (const match of text.matchAll(/[.!?](\s|$)/g)) {
    const candidate = text.slice(0, match.index + 1);
    if (candidate.length > cap) break;
    wholeSentences = candidate;
  }
  if (wholeSentences !== "") return wholeSentences;
  const clipped = text.slice(0, cap);
  const lastSpace = clipped.lastIndexOf(" ");
  const kept = lastSpace > cap / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${kept.replace(/[,;:]$/, "")}…`;
}

function punctuated(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function readingSentence(date: string, source: string, terms: string): string {
  return `As of ${date}, ${source} reads: ${terms}`;
}

export const SUPERSEDED_TERMS_LABEL = "Superseded";

export const STORED_TERMS_WITHHELD_PHRASE = "names them as the previous ones";

export const STORED_TERMS_WITHHELD_META_PHRASE = "terms are superseded and withheld";

function withheldTail(vendor: string, change: QuotingChange, besideAReading: boolean): string {
  return (
    `We are not publishing our stored ${vendor} terms${besideAReading ? " beside it" : ""} — ` +
    `our own pricing change record, ${changeDateClause(change)}, ${STORED_TERMS_WITHHELD_PHRASE}.`
  );
}

function readingWithTail(vendor: string, change: QuotingChange, cap?: number): string | null {
  const reading = readingBehindTheChange(change);
  if (!reading) return null;
  const terms = cap === undefined ? reading.terms : openingOfTerms(reading.terms, cap);
  return `${readingSentence(reading.date, reading.label, punctuated(terms))} ${withheldTail(vendor, change, true)}`;
}

export function supersededTermsNotice(vendor: string, change: QuotingChange): string {
  return (
    readingWithTail(vendor, change) ??
    `${withheldTail(vendor, change, false)} We have not re-read ${vendor}'s pricing page since that record.`
  );
}

export function supersededTermsNoticeHtml(
  vendor: string,
  change: QuotingChange,
  esc: (text: string) => string,
): string {
  const reading = readingBehindTheChange(change);
  if (!reading) return esc(supersededTermsNotice(vendor, change));
  const link =
    `<a href="${esc(reading.url)}" target="_blank" rel="noopener" class="change-source">` +
    `${esc(reading.label)}</a>`;
  return (
    `${readingSentence(esc(reading.date), link, esc(punctuated(reading.terms)))} ` +
    esc(withheldTail(vendor, change, true))
  );
}

export function supersededTermsAnswer(vendor: string, change: QuotingChange): string {
  const opening =
    readingWithTail(vendor, change) ??
    `We are not answering that from our stored terms today. ${withheldTail(vendor, change, false)}`;
  return `${opening} What our record says changed: ${change.summary}`;
}

export function supersededTermsMetaSentence(vendor: string, change: QuotingChange): string {
  const withheld = `Our stored ${vendor} ${STORED_TERMS_WITHHELD_META_PHRASE}`;
  const reading = readingBehindTheChange(change);
  if (!reading) {
    return `${withheld}: our own pricing change record, ${changeDateClause(change)}, ${STORED_TERMS_WITHHELD_PHRASE}.`;
  }
  const opening = punctuated(openingOfTerms(reading.terms, 90));
  return `${readingSentence(reading.date, reading.label, opening)} ${withheld}.`;
}

export function supersededTermsVerdictSentence(vendor: string, change: QuotingChange): string {
  return readingWithTail(vendor, change, 170) ?? withheldTail(vendor, change, false);
}

export interface SupersededTermsRecord {
  change_date: string;
  change_type: string;
  summary: string;
  reading: SourcedReading | null;
  notice: string;
}

export function supersededTermsRecord(vendor: string, change: QuotingChange): SupersededTermsRecord {
  return {
    change_date: change.date,
    change_type: change.change_type,
    summary: change.summary,
    reading: readingBehindTheChange(change),
    notice: supersededTermsNotice(vendor, change),
  };
}

export function supersededTermsRecordFor(
  offer: StoredTerms,
  vendorChanges: readonly QuotingChange[],
): SupersededTermsRecord | null {
  const change = supersedingChange(offer, vendorChanges);
  return change ? supersededTermsRecord(offer.vendor, change) : null;
}
