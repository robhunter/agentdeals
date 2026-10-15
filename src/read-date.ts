import { howWeSettledTheRead, READ_NO_TERMS_FROM_THE_PAGE, theRefusedReadAlone, WHAT_A_VOIDED_READ_FOUND, type ReadSettlement, type RefusedRead, type SettledRead, type VoidingRefusalReason } from "./change-refusal.js";

export { WHAT_A_VOIDED_READ_FOUND };
import { figuresWeAlsoPublish } from "./quantity-reading.js";
import { storedRefusalsFor } from "./refusal-store.js";
import { loadVerificationState } from "./verification-state.js";

export const OUTCOMES_THAT_READ_THE_PAGE = [
  "confirmed",
  "changed",
  "link_ok",
  "states_no_price",
] as const;

const READ_THE_PAGE = new Set<string>(OUTCOMES_THAT_READ_THE_PAGE);

export const LAST_READ_LABEL = "Last read";
export const CONFIRMED_DATE_LABEL = "Verified";
export const RESTATED_DATE_LABEL = "Read from the vendor's page";
export const UNCONFIRMED_DATE_LABEL = "Catalogue date";
const UNCONFIRMED_DATE_WORDS = UNCONFIRMED_DATE_LABEL.toLowerCase();
export const VERIFICATION_DATES_HEADING = `Read / ${UNCONFIRMED_DATE_WORDS}`;

export interface RestatableRecord {
  restated_from?: { reading_date: string; source_url?: string | null } | null;
}

export interface CheckedRecord {
  description?: string | null;
  source_check?: { checked?: string; outcome?: string; detail?: string } | null;
}

export interface DatedRecord extends RestatableRecord, CheckedRecord {
  vendor: string;
  url: string;
  verifiedDate: string;
}

export function outcomeReadThePage(outcome: string | null | undefined): boolean {
  return typeof outcome === "string" && READ_THE_PAGE.has(outcome);
}

export const SOURCE_CHECK_THAT_DID_NOT_READ = "unreadable";

export const KINDS_OF_READ = ["rotation", "source_check", "refusal", "restatement"] as const;

export type KindOfRead = (typeof KINDS_OF_READ)[number];

export interface ReadWeHold {
  kind: KindOfRead;
  on: string;
}

function theRotationsRead(offer: DatedRecord): string {
  const verified = offer.verifiedDate ?? "";
  const record = loadVerificationState().get(`${offer.vendor}|${offer.url}`);
  if (outcomeReadThePage(record?.last_outcome) && record?.last_attempt_at) return record.last_attempt_at;
  const candidates = [verified, record?.last_read_at ?? null, record?.last_success ?? null];
  const dates = candidates.filter((d): d is string => Boolean(d)).sort();
  return dates.length > 0 ? dates[dates.length - 1] : verified;
}

function citesThePage(source: string | null | undefined, cited: string): boolean {
  return typeof source === "string" && source.trim() === cited.trim();
}

export function readsWeHold(offer: DatedRecord): ReadWeHold[] {
  const reads: ReadWeHold[] = [{ kind: "rotation", on: theRotationsRead(offer) }];
  const check = offer.source_check;
  if (check?.checked && check.outcome && check.outcome !== SOURCE_CHECK_THAT_DID_NOT_READ) {
    reads.push({ kind: "source_check", on: check.checked });
  }
  for (const refusal of storedRefusalsFor(offer.vendor)) {
    if (citesThePage(refusal.source_url, offer.url)) reads.push({ kind: "refusal", on: refusal.refused_date });
  }
  const restated = offer.restated_from;
  if (restated?.reading_date && citesThePage(restated.source_url, offer.url)) {
    reads.push({ kind: "restatement", on: restated.reading_date });
  }
  return reads.filter(read => Boolean(read.on));
}

export function latestReadWeHold(offer: DatedRecord | null | undefined): ReadWeHold | null {
  if (!offer?.vendor || !offer?.url) return null;
  let latest: ReadWeHold | null = null;
  for (const read of readsWeHold(offer)) {
    if (latest === null || read.on > latest.on) latest = read;
  }
  return latest;
}

export function lastReadDate(offer: DatedRecord | null | undefined): string {
  return latestReadWeHold(offer)?.on ?? offer?.verifiedDate ?? "";
}

export function termsCameFromAReading(
  offer: RestatableRecord | null | undefined,
): { reading_date: string } | null {
  return offer?.restated_from ?? null;
}

export function storedConfirmationDate(
  offer: { vendor?: string; url?: string } | null | undefined,
): string | null {
  if (!offer?.vendor || !offer?.url) return null;
  return loadVerificationState().get(`${offer.vendor}|${offer.url}`)?.last_success ?? null;
}

export const OUTCOME_CONTRADICTING_WHAT_WE_STORE = "changed";

export function confirmationALaterReadContradicted(
  offer: { vendor?: string; url?: string } | null | undefined,
): string | null {
  if (!offer?.vendor || !offer?.url) return null;
  const record = loadVerificationState().get(`${offer.vendor}|${offer.url}`);
  if (!record?.last_success) return null;
  if (record.last_outcome !== OUTCOME_CONTRADICTING_WHAT_WE_STORE) return null;
  const read = record.last_attempt_at ?? record.last_read_at ?? null;
  return read && read > record.last_success ? read : null;
}

export function confirmationDate(offer: DatedRecord | null | undefined): string | null {
  if (termsCameFromAReading(offer)) return null;
  return storedConfirmationDate(offer);
}

export function lastAttemptDate(offer: DatedRecord | null | undefined): string | null {
  if (!offer?.vendor || !offer?.url) return null;
  return loadVerificationState().get(`${offer.vendor}|${offer.url}`)?.last_attempt_at ?? null;
}

export function publishedDateLabel(offer: DatedRecord | null | undefined): string {
  return confirmationDate(offer) ? CONFIRMED_DATE_LABEL : UNCONFIRMED_DATE_LABEL;
}

export function publishedDateValue(offer: DatedRecord | null | undefined): string {
  return confirmationDate(offer) ?? offer?.verifiedDate ?? "";
}

export function publishedDateLine(offer: DatedRecord | null | undefined): string {
  return `**${publishedDateLabel(offer)}:** ${publishedDateValue(offer)}`;
}

export function restatedReadingDate(offer: RestatableRecord | null | undefined): string | null {
  return termsCameFromAReading(offer)?.reading_date ?? null;
}

export function restatedReadingLine(offer: DatedRecord | null | undefined): string | null {
  const read = restatedReadingDate(offer);
  return read ? `**${RESTATED_DATE_LABEL}:** ${read}` : null;
}

export interface VerificationDates {
  read: string;
  verified: string;
  confirmed: string | null;
  readAfterVerified: boolean;
  attempted: string | null;
}

export function attemptThatDidNotRead(offer: DatedRecord | null | undefined): string | null {
  if (!offer?.vendor || !offer?.url) return null;
  const record = loadVerificationState().get(`${offer.vendor}|${offer.url}`);
  const attempt = record?.last_attempt_at;
  if (!attempt || outcomeReadThePage(record?.last_outcome)) return null;
  return attempt > lastReadDate(offer) ? attempt : null;
}

export function verificationDates(offer: DatedRecord | null | undefined): VerificationDates {
  const verified = offer?.verifiedDate ?? "";
  const read = lastReadDate(offer);
  return {
    read,
    verified,
    confirmed: confirmationDate(offer),
    readAfterVerified: read > verified,
    attempted: attemptThatDidNotRead(offer),
  };
}

export function lastReadOutcome(offer: DatedRecord | null | undefined): string | null {
  if (!offer?.vendor || !offer?.url) return null;
  return loadVerificationState().get(`${offer.vendor}|${offer.url}`)?.last_outcome ?? null;
}

export const ATTEMPT_THAT_DID_NOT_READ = (attempted: string): string => `tried ${attempted}, no read`;

export function verificationDatesCell(offer: DatedRecord | null | undefined): string {
  const { read, verified, readAfterVerified, attempted } = verificationDates(offer);
  if (!read) return "—";
  const dates = readAfterVerified ? `${read} / ${verified}` : read;
  return attempted ? `${dates} · ${ATTEMPT_THAT_DID_NOT_READ(attempted)}` : dates;
}

export function verificationDatesClause(read: string, verified: string): string {
  if (!read) return "";
  return read > verified ? `read ${read}, ${UNCONFIRMED_DATE_WORDS} ${verified}` : `read ${read}`;
}

export function verificationDatesSentence(offer: DatedRecord | null | undefined): string {
  const { read, verified, confirmed, readAfterVerified, attempted } = verificationDates(offer);
  if (!read) return "";
  const dates = confirmed === read
    ? `Read and confirmed ${read}`
    : confirmed
      ? `Read ${read} · confirmed ${confirmed}`
      : readAfterVerified
        ? `Read ${read} · ${UNCONFIRMED_DATE_WORDS} ${verified}`
        : `Read ${read}`;
  return attempted ? `${dates} · tried again ${attempted} and did not read the page` : dates;
}

export const WHAT_THE_LAST_READ_FOUND: Record<string, string> = {
  changed: "found the page different from the terms we hold",
  states_no_price: READ_NO_TERMS_FROM_THE_PAGE,
  link_ok: "reached the page without reading terms from it",
};

export const READ_VOIDED_BY_ITS_OWN_REFUSAL = "had_no_standing_to_contradict";

export type SettlementStatedTheSameWayForEveryReason =
  Exclude<ReadSettlement, typeof READ_VOIDED_BY_ITS_OWN_REFUSAL>;

export const WHAT_A_SETTLED_READ_FOUND: Record<SettlementStatedTheSameWayForEveryReason, string> = {
  restated_the_terms_we_publish:
    "found a change we then refused to record, because it restated the terms we already publish",
  named_no_figure_that_moved:
    "found a change we then refused to record, because it named no figure that had moved",
};

export function whatASettledReadFound(settled: SettledRead): string {
  return settled.settlement === READ_VOIDED_BY_ITS_OWN_REFUSAL
    ? WHAT_A_VOIDED_READ_FOUND[settled.refusal.reason as VoidingRefusalReason]
    : WHAT_A_SETTLED_READ_FOUND[settled.settlement];
}

export function whatTheLastReadFound(
  outcome: string | null | undefined,
  settled: SettledRead | null,
): string | null {
  if (settled && outcome === OUTCOME_CONTRADICTING_WHAT_WE_STORE) {
    return whatASettledReadFound(settled);
  }
  return outcome ? WHAT_THE_LAST_READ_FOUND[outcome] ?? null : null;
}

export const NO_CONFIRMATION_HELD = "We hold no confirmation of the terms we publish";

export const OUTCOME_THAT_CONFIRMED = "confirmed";

export const OUTCOMES_A_READING_CAN_SETTLE = [
  OUTCOME_THAT_CONFIRMED,
  OUTCOME_CONTRADICTING_WHAT_WE_STORE,
] as const;

const CAN_SETTLE = new Set<string>(OUTCOMES_A_READING_CAN_SETTLE);

export interface LastReading {
  date: string;
  outcome: string;
  confirmed: boolean;
  settles: boolean;
  read_the_page: boolean;
  found: string | null;
  consecutive_failures: number;
  last_success: string | null;
  last_error: string | null;
}

export interface ReadRecord {
  vendor: string;
  url: string;
  source_check?: { checked?: string; outcome?: string } | null;
}

export type ReadingLookup = (offer: ReadRecord) => LastReading | null;

export const WHAT_A_SOURCE_CHECK_FOUND: Record<string, string> = {
  states_no_terms: WHAT_THE_LAST_READ_FOUND.states_no_price,
};

function readingFromSourceCheck(offer: ReadRecord): LastReading | null {
  const checked = offer.source_check?.checked;
  const outcome = offer.source_check?.outcome;
  if (!checked || !outcome) return null;
  const found = WHAT_A_SOURCE_CHECK_FOUND[outcome] ?? null;
  return {
    date: checked,
    outcome,
    confirmed: false,
    settles: found === null,
    read_the_page: true,
    found,
    consecutive_failures: 0,
    last_success: null,
    last_error: null,
  };
}

export function readingOfTheSourceCheck(offer: ReadRecord): LastReading | null {
  if (offer.source_check?.outcome === SOURCE_CHECK_THAT_DID_NOT_READ) return null;
  return readingFromSourceCheck(offer);
}

export function readingOnTheLastReadDate(offer: DatedRecord & ReadRecord): LastReading | null {
  const latest = latestReadWeHold(offer);
  if (!latest) return null;
  const reading = latest.kind === "source_check" ? readingOfTheSourceCheck(offer) : lastReadingFor(offer);
  return reading?.date === latest.on ? reading : null;
}

export function lastReadingFor(offer: ReadRecord): LastReading | null {
  return readingSettledByRefusals(readingFromVerificationState(offer), storedRefusalsFor(offer.vendor));
}

function readingFromVerificationState(offer: ReadRecord): LastReading | null {
  const record = loadVerificationState().get(`${offer.vendor}|${offer.url}`);
  const date = record?.last_attempt_at;
  const outcome = record?.last_outcome;
  if (!record || !date || !outcome) return readingFromSourceCheck(offer);
  return {
    date,
    outcome,
    confirmed: outcome === OUTCOME_THAT_CONFIRMED,
    settles: CAN_SETTLE.has(outcome),
    read_the_page: outcomeReadThePage(outcome),
    found: WHAT_THE_LAST_READ_FOUND[outcome] ?? null,
    consecutive_failures: record.consecutive_failures ?? 0,
    last_success: record.last_success,
    last_error: record.last_error ?? record.failure_category ?? null,
  };
}

export function readingSettledByRefusals(
  reading: LastReading | null,
  refusals: readonly RefusedRead[],
): LastReading | null {
  if (!reading || reading.outcome !== OUTCOME_CONTRADICTING_WHAT_WE_STORE) return reading;
  const settled = howWeSettledTheRead(refusals, reading.date);
  if (!settled) return reading;
  return { ...reading, found: whatASettledReadFound(settled) };
}

export interface WhatCameAfterTheRead {
  refusals: readonly RefusedRead[];
  restatedFrom: string | null;
  confirmedOn: string | null;
}

export function restatementSettles(reading: LastReading, restatedFrom: string | null): boolean {
  return restatedFrom !== null && restatedFrom >= reading.date;
}

export function confirmationSettles(reading: LastReading, confirmedOn: string | null): boolean {
  return confirmedOn !== null && confirmedOn > reading.date;
}

export function somethingLaterSettledTheRead(
  reading: LastReading,
  after: WhatCameAfterTheRead,
): boolean {
  return howWeSettledTheRead(after.refusals, reading.date) !== null
    || restatementSettles(reading, after.restatedFrom)
    || confirmationSettles(reading, after.confirmedOn);
}

export function contradictingRead(
  reading: LastReading | null,
  after: WhatCameAfterTheRead,
): LastReading | null {
  if (!reading || reading.outcome !== OUTCOME_CONTRADICTING_WHAT_WE_STORE) return null;
  return somethingLaterSettledTheRead(reading, after) ? null : reading;
}

export function whatCameAfterTheRead(
  offer: (DatedRecord & ReadRecord) | null | undefined,
): WhatCameAfterTheRead {
  return {
    refusals: offer?.vendor ? storedRefusalsFor(offer.vendor) : [],
    restatedFrom: restatedReadingDate(offer),
    confirmedOn: storedConfirmationDate(offer),
  };
}

export function readThatContradictsOurTerms(
  offer: (DatedRecord & ReadRecord) | null | undefined,
): LastReading | null {
  if (!offer?.vendor || !offer?.url) return null;
  return contradictingRead(readingFromVerificationState(offer), whatCameAfterTheRead(offer));
}

export const READ_CONTRADICTS_LABEL = "read found the page different";

export function contradictedTermsSentence(reading: LastReading): string {
  return `Our read on ${reading.date} ${WHAT_THE_LAST_READ_FOUND[OUTCOME_CONTRADICTING_WHAT_WE_STORE]},`
    + ` and ${NO_CONFIRMATION_HELD.toLowerCase()}.`;
}

export function theReadOurTermsCameFrom(read: string, restatedFrom: string | null): string {
  if (!restatedFrom) return "";
  if (restatedFrom === read) return ` Our last read of it, on ${read}, is where the terms above come from.`;
  if (restatedFrom > read) return ` The terms above come from our read of ${restatedFrom}.`;
  return ` The terms above come from our read of ${restatedFrom}, and we have read the page since,`
    + ` on ${read}, without confirming them.`;
}

export function termsLastConfirmedOn(confirmed: string): string {
  return `Our stored terms were last confirmed on ${confirmed}.`;
}

export const READS_OUR_TERMS_CAN_COME_FROM = [
  "a_read_that_confirmed_them",
  "a_read_we_restated_them_from",
] as const;

export type ReadOurTermsCameFrom = (typeof READS_OUR_TERMS_CAN_COME_FROM)[number];

export interface TermsProvenance {
  read: ReadOurTermsCameFrom;
  on: string;
}

export function whereOurTermsCameFrom(
  offer: DatedRecord | null | undefined,
): TermsProvenance | null {
  const restated = restatedReadingDate(offer);
  if (restated) return { read: "a_read_we_restated_them_from", on: restated };
  const confirmed = confirmationDate(offer);
  return confirmed ? { read: "a_read_that_confirmed_them", on: confirmed } : null;
}

const HOW_A_PROVENANCE_IS_STATED: Record<
  ReadOurTermsCameFrom,
  (provenance: TermsProvenance, readOn: string) => string
> = {
  a_read_that_confirmed_them: provenance => termsLastConfirmedOn(provenance.on),
  a_read_we_restated_them_from: (provenance, readOn) =>
    theReadOurTermsCameFrom(readOn, provenance.on).trim(),
};

export function whereOurTermsCameFromClause(provenance: TermsProvenance, readOn: string): string {
  return HOW_A_PROVENANCE_IS_STATED[provenance.read](provenance, readOn);
}

export function readRestatedTheTermsWePublish(outcome: string | null, settled: SettledRead | null): boolean {
  return outcome === OUTCOME_CONTRADICTING_WHAT_WE_STORE && settled?.settlement === "restated_the_terms_we_publish";
}

export function readFoundTheTermsWePublishedNote(read: string): string {
  return `The day we last read the vendor's page. Our last read of it, on ${read}, found the terms we published that day.`;
}

function noConfirmationNoteStating(
  read: string,
  verified: string,
  found: string | null,
  restatedFrom: string | null,
  standing: LastReading | null = null,
): string {
  const reading = restatedFrom
    ? theReadOurTermsCameFrom(read, restatedFrom)
    : read && found ? ` Our last read of it, on ${read}, ${found}.` : "";
  if (standing) return `The day we last read the vendor's page.${reading} ${contradictedTermsSentence(standing)}`;
  const beside = verified && verified !== read
    ? ` — the ${verified} beside this date is not one we can source to a read that confirmed them`
    : "";
  return `The day we last read the vendor's page.${reading} ${NO_CONFIRMATION_HELD}${beside}.`;
}

export function noConfirmationNote(
  read: string,
  verified: string,
  outcome: string | null,
  settled: SettledRead | null,
  restatedFrom: string | null = null,
): string {
  if (!restatedFrom && readRestatedTheTermsWePublish(outcome, settled)) return readFoundTheTermsWePublishedNote(read);
  return noConfirmationNoteStating(read, verified, whatTheLastReadFound(outcome, settled), restatedFrom);
}

const A_CHECK_THAT_STATED_FIGURES = /^.*? and states ("[^"]*"(?: and "[^"]*")*)$/;

const A_QUOTED_FIGURE = /"([^"]*)"/g;

const AN_AMOUNT_OF_ZERO = /^(?:[$€£¥₹]\s?0(?:[.,]0+)?|0(?:\.0+)?\s?(?:USD|EUR|GBP))$/i;

export const SOURCE_CHECK_THAT_PASSED = "ok";

export function statesAnAmountOfZero(figure: string): boolean {
  return AN_AMOUNT_OF_ZERO.test(figure.trim());
}

export function figuresTheCheckStated(check: CheckedRecord["source_check"]): string[] {
  if (check?.outcome !== SOURCE_CHECK_THAT_PASSED) return [];
  const stated = A_CHECK_THAT_STATED_FIGURES.exec((check.detail ?? "").trim());
  return stated ? [...stated[1].matchAll(A_QUOTED_FIGURE)].map(quoted => quoted[1]) : [];
}

const A_TRAILING_STOP = /[,.;:]+$/;

export function withoutATrailingStop(figure: string): string {
  return figure.replace(A_TRAILING_STOP, "");
}

export function figuresTheCheckStatedOnce(check: CheckedRecord["source_check"]): string[] {
  return [...new Set(figuresTheCheckStated(check).map(withoutATrailingStop))];
}

export function figuresTheCheckFoundThatTheListingGives(offer: CheckedRecord | null | undefined): string[] {
  const figures = figuresWeAlsoPublish(figuresTheCheckStatedOnce(offer?.source_check), offer?.description ?? "");
  return figures.every(statesAnAmountOfZero) ? [] : figures;
}

export function noteQuotesTheCheck(offer: CheckedRecord | null | undefined): boolean {
  return figuresTheCheckFoundThatTheListingGives(offer).length > 0;
}

export function figuresInASentence(figures: readonly string[]): string {
  if (figures.length < 2) return figures.join("");
  return `${figures.slice(0, -1).join(", ")} and ${figures[figures.length - 1]}`;
}

export function checkStatedFiguresTheListingGivesSentence(
  checked: string,
  vendor: string,
  figures: readonly string[],
): string {
  const noun = figures.length === 1 ? "a figure" : "figures";
  return `On ${checked}, the page we cite for ${vendor} stated ${figuresInASentence(figures)}, ${noun} this listing gives.`;
}

export function whatASourceCheckReadFor(vendor: string): string {
  return `checked the page for ${vendor}'s name and a price`;
}

export function whatTheSourceCheckFound(vendor: string, outcome: string | undefined): string {
  return (outcome ? WHAT_A_SOURCE_CHECK_FOUND[outcome] : undefined) ?? whatASourceCheckReadFor(vendor);
}

export function sourceCheckNote(
  offer: DatedRecord,
  read: string,
  verified: string,
  restatedFrom: string | null,
  standing: LastReading | null = null,
): string {
  const check = offer.source_check;
  const figures = figuresTheCheckFoundThatTheListingGives(offer);
  if (figures.length > 0) {
    const contradiction = standing ? ` ${contradictedTermsSentence(standing)}` : "";
    return `The day we last read the vendor's page. ${checkStatedFiguresTheListingGivesSentence(read, offer.vendor, figures)}${contradiction}`;
  }
  return noConfirmationNoteStating(read, verified, whatTheSourceCheckFound(offer.vendor, check?.outcome), restatedFrom, standing);
}

export interface TermsWeCannotConfirm {
  clause: string;
  on: string | null;
}

function theSameReadDisagreedWithItself(confirmed: string, withheld: TermsWeCannotConfirm): boolean {
  return withheld.on === null || withheld.on <= confirmed;
}

export function unreconciledConfirmationNote(confirmed: string, withheld: TermsWeCannotConfirm): string {
  return theSameReadDisagreedWithItself(confirmed, withheld)
    ? `That read matched the terms we publish, and the same read found that ${withheld.clause}`
      + ` — we cannot reconcile the two, so treat these terms as unconfirmed.`
    : `Our records hold a confirmation of these terms from ${confirmed}, and we have read the page`
      + ` since without confirming them: ${withheld.clause}.`;
}

function asSentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

function theNoteDescribesTheReadOn(
  day: string | null,
  read: string,
  outcome: string | null,
  settled: SettledRead | null,
  restatedFrom: string | null,
): boolean {
  if (restatedFrom || readRestatedTheTermsWePublish(outcome, settled)) return false;
  return day === read && whatTheLastReadFound(outcome, settled) !== null;
}

export function lastReadNote(
  offer: DatedRecord | null | undefined,
  withheld: TermsWeCannotConfirm | null,
  refusals: readonly RefusedRead[],
  refusalTheRatingWaitsOn: TermsWeCannotConfirm | null = null,
): string {
  const { read, verified, confirmed, attempted } = verificationDates(offer);
  const tail = attempted
    ? ` We tried again on ${attempted} and did not read the page, so that attempt confirmed nothing.`
    : "";
  if (!confirmed) {
    const latest = latestReadWeHold(offer);
    const outcome = latest?.kind === "refusal" ? OUTCOME_CONTRADICTING_WHAT_WE_STORE : lastReadOutcome(offer);
    const settled = howWeSettledTheRead(refusals, read);
    const restatedFrom = restatedReadingDate(offer);
    const byTheCheck = latest?.kind === "source_check";
    const quotesTheCheck = byTheCheck && noteQuotesTheCheck(offer);
    const refusal = refusalTheRatingWaitsOn
      && (byTheCheck || !theNoteDescribesTheReadOn(refusalTheRatingWaitsOn.on, read, outcome, settled, restatedFrom))
      ? ` ${asSentence(quotesTheCheck ? theRefusedReadAlone(refusalTheRatingWaitsOn.clause) : refusalTheRatingWaitsOn.clause)}`
      : "";
    const standing = byTheCheck ? readThatContradictsOurTerms(offer) : null;
    const statedByTheRefusal = refusal !== "" && standing?.date === refusalTheRatingWaitsOn?.on;
    const note = byTheCheck && offer
      ? sourceCheckNote(offer, read, verified, restatedFrom, statedByTheRefusal ? null : standing)
      : noConfirmationNote(read, verified, outcome, settled, restatedFrom);
    return note + refusal + tail;
  }
  const unreconciled = withheld ?? refusalTheRatingWaitsOn;
  if (unreconciled) {
    return `The day we last read the vendor's page. ${unreconciledConfirmationNote(confirmed, unreconciled)}` + tail;
  }
  return (confirmed < read
    ? `The day we last read the vendor's page. The terms we publish were last confirmed on ${confirmed}.`
    : "The day we last read the vendor's page, and the day we last confirmed the terms we publish.") + tail;
}

export function storedConfirmationClause(
  offer: DatedRecord | null | undefined,
  withheld: TermsWeCannotConfirm | null = null,
): string {
  const confirmed = confirmationDate(offer);
  if (!confirmed) return `${NO_CONFIRMATION_HELD}.`;
  if (!withheld) return termsLastConfirmedOn(confirmed);
  return theSameReadDisagreedWithItself(confirmed, withheld)
    ? `We matched our stored terms against that same read on ${confirmed} and cannot reconcile the two.`
    : `Our records hold a confirmation of these terms from ${confirmed}, and we have read the page since without confirming them.`;
}

export function daysSince(date: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}
