import { changeIsUncited, type CitableChange } from "./change-citation.js";

export type ChangeReportSubject = "vendor_offer" | "our_index";

export const CHANGE_REPORT_SUBJECTS: readonly ChangeReportSubject[] = ["vendor_offer", "our_index"];

export const DEFAULT_CHANGE_REPORT_SUBJECT: ChangeReportSubject = "vendor_offer";

export const CHANGE_REPORT_RULE: Record<ChangeReportSubject, string> = {
  vendor_offer: "the vendor changed its own offer, and a vendor page is where that can be read",
  our_index: "we changed what we list while the vendor's offer stood still, so no vendor page evidences it",
};

export interface ReportingChange {
  reports?: string | null;
}

export function changeReports(change: ReportingChange): ChangeReportSubject {
  return change.reports === "our_index" ? "our_index" : DEFAULT_CHANGE_REPORT_SUBJECT;
}

export function reportsOurIndex(change: ReportingChange): boolean {
  return changeReports(change) === "our_index";
}

export function reportsAVendorOffer(change: ReportingChange): boolean {
  return changeReports(change) === "vendor_offer";
}

export function ourIndexChanges<T extends ReportingChange>(changes: readonly T[]): T[] {
  return changes.filter(reportsOurIndex);
}

export function vendorOfferChanges<T extends ReportingChange>(changes: readonly T[]): T[] {
  return changes.filter(reportsAVendorOffer);
}

export const UNCITED_CHANGE_BUDGET_RULE =
  "The budget counts the records that report a vendor's offer and cite no source. A record reporting our own "
  + "index has no vendor page to cite and is required to carry no source_url, so it sits outside the count "
  + "rather than spending a slot in it.";

export function countsAgainstUncitedBudget(change: ReportingChange & CitableChange): boolean {
  return reportsAVendorOffer(change) && changeIsUncited(change);
}

export function uncitedChangesAgainstBudget<T extends ReportingChange & CitableChange>(
  changes: readonly T[],
): T[] {
  return changes.filter(countsAgainstUncitedBudget);
}

export function ourIndexChangeMayNotCiteASource(change: ReportingChange & CitableChange): boolean {
  return reportsOurIndex(change) && !changeIsUncited(change);
}
