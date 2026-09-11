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
}

export function verificationDates(offer: DatedRecord | null | undefined): VerificationDates {
  const verified = offer?.verifiedDate ?? "";
  const read = lastReadDate(offer);
  return { read, verified, readAfterVerified: read > verified };
}

export function verificationDatesCell(offer: DatedRecord | null | undefined): string {
  const { read, verified, readAfterVerified } = verificationDates(offer);
  if (!read) return "—";
  return readAfterVerified ? `${read} / ${verified}` : read;
}

export function verificationDatesClause(read: string, verified: string): string {
  if (!read) return "";
  return read > verified ? `read ${read}, verified ${verified}` : `read and verified ${read}`;
}

export function verificationDatesSentence(offer: DatedRecord | null | undefined): string {
  const { read, verified, readAfterVerified } = verificationDates(offer);
  if (!read) return "";
  return readAfterVerified ? `Read ${read} · verified ${verified}` : `Read and verified ${read}`;
}

export function lastReadNote(offer: DatedRecord | null | undefined): string {
  const { verified, readAfterVerified } = verificationDates(offer);
  return readAfterVerified
    ? `The day we last read the vendor's page. The terms we publish were last confirmed on ${verified}.`
    : "The day we last read the vendor's page, and the day we last confirmed the terms we publish.";
}

export function daysSince(date: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}
