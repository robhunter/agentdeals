import { loadVerificationState } from "./verification-state.js";

export const OUTCOMES_THAT_READ_THE_PAGE = [
  "confirmed",
  "changed",
  "link_ok",
  "states_no_price",
] as const;

const READ_THE_PAGE = new Set<string>(OUTCOMES_THAT_READ_THE_PAGE);

export const VERIFICATION_DATES_HEADING = "Read / verified";
export const LAST_READ_LABEL = "Last read";

export interface DatedRecord {
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

export function confirmationDate(offer: DatedRecord | null | undefined): string | null {
  if (!offer?.vendor || !offer?.url) return null;
  return loadVerificationState().get(`${offer.vendor}|${offer.url}`)?.last_success ?? null;
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
  return read > verified ? `read ${read}, verified ${verified}` : `read and verified ${read}`;
}

export function verificationDatesSentence(offer: DatedRecord | null | undefined): string {
  const { read, verified, readAfterVerified, attempted } = verificationDates(offer);
  if (!read) return "";
  const dates = readAfterVerified ? `Read ${read} · verified ${verified}` : `Read and verified ${read}`;
  return attempted ? `${dates} · tried again ${attempted} and did not read the page` : dates;
}

const WHAT_THE_LAST_READ_FOUND: Record<string, string> = {
  changed: "found the page different from the terms we hold",
  states_no_price: "could read no amount, tier or rate on the page",
  link_ok: "reached the page without reading terms from it",
};

export const NO_CONFIRMATION_HELD = "We hold no confirmation of the terms we publish";

export function noConfirmationNote(read: string, verified: string, outcome: string | null): string {
  const found = outcome ? WHAT_THE_LAST_READ_FOUND[outcome] : undefined;
  const reading = read && found ? ` Our last read of it, on ${read}, ${found}.` : "";
  const beside = verified && verified !== read
    ? ` — the ${verified} beside this date is not one we can source to a read that confirmed them`
    : "";
  return `The day we last read the vendor's page.${reading} ${NO_CONFIRMATION_HELD}${beside}.`;
}

export function lastReadNote(offer: DatedRecord | null | undefined): string {
  const { read, verified, confirmed, attempted } = verificationDates(offer);
  const tail = attempted
    ? ` We tried again on ${attempted} and did not read the page, so that attempt confirmed nothing.`
    : "";
  if (!confirmed) return noConfirmationNote(read, verified, lastReadOutcome(offer)) + tail;
  return (confirmed < read
    ? `The day we last read the vendor's page. The terms we publish were last confirmed on ${confirmed}.`
    : "The day we last read the vendor's page, and the day we last confirmed the terms we publish.") + tail;
}

export function daysSince(date: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}
