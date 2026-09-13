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
  const candidates = [verified, record?.last_read_at ?? null];
  if (outcomeReadThePage(record?.last_outcome)) candidates.push(record?.last_attempt_at ?? null);
  const dates = candidates.filter((d): d is string => Boolean(d)).sort();
  return dates.length > 0 ? dates[dates.length - 1] : verified;
}

export interface VerificationDates {
  read: string;
  verified: string;
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
  return { read, verified, readAfterVerified: read > verified, attempted: attemptThatDidNotRead(offer) };
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

export function lastReadNote(offer: DatedRecord | null | undefined): string {
  const { verified, readAfterVerified, attempted } = verificationDates(offer);
  const tail = attempted
    ? ` We tried again on ${attempted} and did not read the page, so that attempt confirmed nothing.`
    : "";
  return (readAfterVerified
    ? `The day we last read the vendor's page. The terms we publish were last confirmed on ${verified}.`
    : "The day we last read the vendor's page, and the day we last confirmed the terms we publish.") + tail;
}

export function daysSince(date: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}
