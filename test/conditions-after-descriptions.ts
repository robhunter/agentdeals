import { conditionsInPlainText, LISTING_CONDITIONS_CLASS } from "../dist/listing-conditions.js";

type ListingCondition = import("../src/types.ts").ListingCondition;

type Listing = { vendor: string; conditions?: ListingCondition[] };

export function plainConditionsByVendor(listings: readonly Listing[]): Map<string, string[]> {
  const byVendor = new Map<string, string[]>();
  for (const listing of listings) {
    if (!listing.conditions?.length) continue;
    byVendor.set(listing.vendor, [...(byVendor.get(listing.vendor) ?? []), ` ${conditionsInPlainText(listing.conditions)}`]);
  }
  return byVendor;
}

const A_FINISHED_SENTENCE = /[.!?…]$/;

export function withoutItsOwnConditions(described: string, own: readonly string[] = []): string {
  const printed = own.find(conditions => described.endsWith(conditions) && A_FINISHED_SENTENCE.test(described.slice(0, -conditions.length)));
  return printed === undefined ? described : described.slice(0, -printed.length);
}

const CONDITIONS_LIST = new RegExp(`\\n\\s*<ul class="${LISTING_CONDITIONS_CLASS}"[^>]*>[\\s\\S]*?<\\/ul>`, "g");

export function withoutConditionsLists(html: string): string {
  return html.replace(CONDITIONS_LIST, "");
}
