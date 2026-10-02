import type { ArchiveCheck, ArchiveCheckOutcome } from "./types.js";

export const UNCONFIRMED_ARCHIVE_OUTCOME = "no_usable_capture";

export const OURS_ARCHIVE_OUTCOME = "ours";

export const ARCHIVE_CHECK_OUTCOMES: ArchiveCheckOutcome[] = [
  "vendor_changed",
  OURS_ARCHIVE_OUTCOME,
  "removal_stated_before",
  UNCONFIRMED_ARCHIVE_OUTCOME,
  "text_day_unknown",
  "page_unreadable_today",
];

export type ConfirmableChange = { archive_check?: ArchiveCheck | null };

export function changeIsUnconfirmed(change: ConfirmableChange): boolean {
  return change.archive_check?.outcome === UNCONFIRMED_ARCHIVE_OUTCOME;
}

export function changeIsConfirmed(change: ConfirmableChange): boolean {
  return !changeIsUnconfirmed(change);
}

export interface DifferenceInOurText {
  vendor: string;
  capture_day: string;
  text_day: string;
  record_date: string;
}

export function differenceInOurTextSummary({ vendor, capture_day, text_day, record_date }: DifferenceInOurText): string {
  return `Data correction - Not a change by ${vendor}. An Internet Archive copy of its page from ${capture_day} already states the terms this record called new, and our listing of ${text_day} did not match them. Our re-read of ${record_date} recorded the difference as a change.`;
}

export const AN_UNCONFIRMED_CHANGE_SETS_NO_LABEL =
  "A change our automatic re-read finds sets a caution or risky label only once an archived copy of the vendor's page, or our own check, shows the terms changing. Until then it is listed as unconfirmed and sets no label.";
