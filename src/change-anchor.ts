import { toSlug } from "./vendor-slug.js";

export const PRICING_CHANGES_PATH = "/pricing-changes";

export interface AnchoredChange {
  vendor: string;
  date: string;
}

export function changeAnchor(change: AnchoredChange): string {
  return `${toSlug(change.vendor)}-${change.date}`;
}

export function changeRecordHref(change: AnchoredChange): string {
  return `${PRICING_CHANGES_PATH}#${changeAnchor(change)}`;
}
