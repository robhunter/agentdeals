import type { DateWindow } from "./change-dates.js";
import { joinedWithAnd } from "./model-beliefs.js";
import { PRODUCT_DEPRECATED } from "./product-deprecation.js";

export const FREE_TIER_TRACKER_YEAR = 2026;

export const FREE_TIER_TRACKER_TITLE = "Free Tier Tracker 2026 — Developer Tool Changes";

export const FREE_TIER_TRACKER_HEADING = "Free Tier Tracker 2026";

export const FREE_TIER_TRACKER_META_DESCRIPTION =
  "A list of developer tool free tiers that were removed or cut in 2026, grouped by quarter, with dates and what changed.";

export const CUTS_THIS_YEAR_ANCHOR = `cuts-${FREE_TIER_TRACKER_YEAR}`;

export const CUTS_THIS_YEAR_HEADING = `Free Tiers Removed and Cut in ${FREE_TIER_TRACKER_YEAR}`;

export const CUTS_THIS_YEAR_SUMMARY_CLASS = "cuts-summary";

export const CUT_KIND_NOUNS: ReadonlyMap<string, { one: string; many: string }> = new Map([
  ["free_tier_removed", { one: "free tier removal", many: "free tier removals" }],
  ["limits_reduced", { one: "cut", many: "cuts" }],
  [PRODUCT_DEPRECATED, { one: "deprecation or shutdown", many: "deprecations or shutdowns" }],
]);

function monthAndDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function cutsThisYearSummary(window: Required<DateWindow>, records: readonly { change_type: string }[]): string | null {
  const counts = [...CUT_KIND_NOUNS]
    .map(([type, noun]) => ({ noun, count: records.filter((record) => record.change_type === type).length }))
    .filter(({ count }) => count > 0)
    .map(({ noun, count }) => `${count} ${count === 1 ? noun.one : noun.many}`);
  if (counts.length === 0) return null;
  const span = `from ${monthAndDay(window.start)} to ${monthAndDay(window.end)}, ${window.end.slice(0, 4)}`;
  return `This list holds high-impact changes ${span}. It includes ${joinedWithAnd(counts)}.`;
}

export function changeTypesAmong(records: readonly { change_type: string }[]): string[] {
  return [...new Set(records.map((record) => record.change_type))].sort();
}

export function quarterHeading(year: number, quarter: number): string {
  return `Q${quarter} ${year}`;
}

export function quarterAnchor(year: number, quarter: number): string {
  return `q${quarter}-${year}`;
}

export const CHANGE_TIMELINE_PATH = "/pricing-changes";

export const CHANGE_TIMELINE_LINK_TEXT = "the full change timeline";

export const NO_KNOWN_EFFECTIVE_DATE_LEFT_OUT = "Changes with no known effective date are not in this list. They are in";

export const UNTIL_ITS_DATE_ARRIVES = "Until then it is in";

export const FIGURES_AS_OF_CLASS = "figures-as-of";

type Escape = (text: string) => string;

export function figuresAsOfTheChangeHtml(date: string, vendor: string, vendorSlug: string | null, esc: Escape): string {
  const asOf = `Figures as of ${esc(date)}.`;
  if (vendorSlug === null) return asOf;
  return `${asOf} ${esc("Today's terms:")} <a href="/vendor/${vendorSlug}">${esc(`our ${vendor} listing`)}</a>.`;
}

export function neonFiguresWereJanuarysHtml(esc: Escape): string {
  return `${esc("These were January's figures; Neon's free plan now gives 1 GB of storage per project, 20 GB in total")} (<a href="/vendor/neon">${esc("our Neon listing")}</a>).`;
}

export function isAFirstQuarterCard(date: string): boolean {
  return date >= `${FREE_TIER_TRACKER_YEAR}-01-01` && date <= `${FREE_TIER_TRACKER_YEAR}-03-31`;
}
