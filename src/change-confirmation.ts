import type { ArchiveCheck } from "./types.js";

export const UNCONFIRMED_ARCHIVE_OUTCOME = "no_usable_capture";

export type ConfirmableChange = { archive_check?: ArchiveCheck | null };

export function changeIsUnconfirmed(change: ConfirmableChange): boolean {
  return change.archive_check?.outcome === UNCONFIRMED_ARCHIVE_OUTCOME;
}

export function changeIsConfirmed(change: ConfirmableChange): boolean {
  return !changeIsUnconfirmed(change);
}

export const AN_UNCONFIRMED_CHANGE_SETS_NO_LABEL =
  "A change our automatic re-read finds sets a caution or risky label only once an archived copy of the vendor's page, or our own check, shows the terms changing. Until then it is listed as unconfirmed and sets no label.";
