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
  restated_from?: { reading_date: string } | null;
}

export interface DatedRecord extends RestatableRecord {
  vendor: string;
  url: string;
  verifiedDate: string;
}

export function outcomeReadThePage(outcome: string | null | undefined): boolean {
  return typeof outcome === "string" && READ_THE_PAGE.has(outcome);
}

export function lastReadDate(offer: DatedRecord | null | undefined): string {
  const verified = offer?.verifiedDate ?? "";
  if (!offer?.vendor || !offer?.url) return verified;
  const record = loadVerificationState().get(`${offer.vendor}|${offer.url}`);
  if (outcomeReadThePage(record?.last_outcome) && record?.last_attempt_at) return record.last_attempt_at;
  const candidates = [verified, record?.last_read_at ?? null];
  const dates = candidates.filter((d): d is string => Boolean(d)).sort();
  return dates.length > 0 ? dates[dates.length - 1] : verified;
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
  states_no_price: "could read no amount, tier or rate on the page",
  link_ok: "reached the page without reading terms from it",
};

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

export function lastReadingFor(offer: ReadRecord): LastReading | null {
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

export function theReadOurTermsCameFrom(read: string, restatedFrom: string | null): string {
  if (!restatedFrom) return "";
  if (restatedFrom === read) return ` Our last read of it, on ${read}, is where the terms above come from.`;
  if (restatedFrom > read) return ` The terms above come from our read of ${restatedFrom}.`;
  return ` The terms above come from our read of ${restatedFrom}, and we have read the page since,`
    + ` on ${read}, without confirming them.`;
}

export function noConfirmationNote(
  read: string,
  verified: string,
  outcome: string | null,
  restatedFrom: string | null = null,
): string {
  const found = outcome ? WHAT_THE_LAST_READ_FOUND[outcome] : undefined;
  const reading = restatedFrom
    ? theReadOurTermsCameFrom(read, restatedFrom)
    : read && found ? ` Our last read of it, on ${read}, ${found}.` : "";
  const beside = verified && verified !== read
    ? ` — the ${verified} beside this date is not one we can source to a read that confirmed them`
    : "";
  return `The day we last read the vendor's page.${reading} ${NO_CONFIRMATION_HELD}${beside}.`;
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

export function lastReadNote(
  offer: DatedRecord | null | undefined,
  withheld: TermsWeCannotConfirm | null = null,
): string {
  const { read, verified, confirmed, attempted } = verificationDates(offer);
  const tail = attempted
    ? ` We tried again on ${attempted} and did not read the page, so that attempt confirmed nothing.`
    : "";
  if (!confirmed) {
    return noConfirmationNote(read, verified, lastReadOutcome(offer), restatedReadingDate(offer)) + tail;
  }
  if (withheld) {
    return `The day we last read the vendor's page. ${unreconciledConfirmationNote(confirmed, withheld)}` + tail;
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
  if (!withheld) return `Our stored terms were last confirmed on ${confirmed}.`;
  return theSameReadDisagreedWithItself(confirmed, withheld)
    ? `We matched our stored terms against that same read on ${confirmed} and cannot reconcile the two.`
    : `Our records hold a confirmation of these terms from ${confirmed}, and we have read the page since without confirming them.`;
}

export function daysSince(date: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}
