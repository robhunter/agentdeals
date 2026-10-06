import type { DealChange } from "./types.js";
import { trackedChanges } from "./change-census.js";
import { changeCitesASource } from "./change-citation.js";
import { changeIsUnconfirmed } from "./change-confirmation.js";
import { archiveBracketOf, isEventDated, withinWindow, type DateWindow } from "./change-dates.js";
import { PRODUCT_DEPRECATED, changeTouchesTheListing } from "./product-deprecation.js";

export const FREE_TIER_CUT_TYPES: ReadonlySet<string> = new Set(["free_tier_removed", "limits_reduced", PRODUCT_DEPRECATED]);

export interface QuarterOfCuts {
  year: number;
  quarter: number;
  records: DealChange[];
}

function isAHighImpactCut(record: DealChange): boolean {
  return FREE_TIER_CUT_TYPES.has(record.change_type) && record.impact === "high";
}

function standsBehindItsSource(record: DealChange): boolean {
  return changeCitesASource(record) && !changeIsUnconfirmed(record);
}

function newestFirst(a: DealChange, b: DealChange): number {
  return b.date.localeCompare(a.date) || a.vendor.localeCompare(b.vendor);
}

function tookEffectWithin(window: DateWindow): (record: DealChange) => boolean {
  return (record) => {
    if (isEventDated(record)) return true;
    const bracket = archiveBracketOf(record);
    return bracket !== null && bracket.from >= window.start;
  };
}

export function cutsWindow(year: number, today: string): Required<DateWindow> {
  const lastDayOfYear = `${year}-12-31`;
  return { start: `${year}-01-01`, end: today < lastDayOfYear ? today : lastDayOfYear };
}

export function freeTierCutsIn(year: number, changes: DealChange[], today: string): DealChange[] {
  const window = cutsWindow(year, today);
  return trackedChanges(changes.filter((record) => withinWindow(record.date, window)))
    .filter(tookEffectWithin(window))
    .filter(isAHighImpactCut)
    .filter(standsBehindItsSource)
    .filter(changeTouchesTheListing)
    .sort(newestFirst);
}

export function quarterOf(date: string): number {
  return Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
}

export function cutsByQuarterNewestFirst(year: number, cuts: readonly DealChange[]): QuarterOfCuts[] {
  return [4, 3, 2, 1]
    .map((quarter) => ({ year, quarter, records: cuts.filter((record) => record.date.startsWith(`${year}-`) && quarterOf(record.date) === quarter) }))
    .filter((group) => group.records.length > 0);
}
