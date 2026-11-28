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
  return freeTierCutsWithin(cutsWindow(year, today), changes);
}

export function rollingCutsWindow(today: string): Required<DateWindow> {
  const end = new Date(`${today}T00:00:00Z`);
  const year = end.getUTCFullYear() - 1;
  const month = end.getUTCMonth();
  const day = Math.min(end.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const start = new Date(Date.UTC(year, month, day + 1));
  return { start: start.toISOString().slice(0, 10), end: today };
}

export function freeTierCutsWithin(window: Required<DateWindow>, changes: DealChange[]): DealChange[] {
  return trackedChanges(changes.filter((record) => withinWindow(record.date, window)))
    .filter(tookEffectWithin(window))
    .filter(isAHighImpactCut)
    .filter(standsBehindItsSource)
    .filter(changeTouchesTheListing)
    .sort(newestFirst);
}

export function cutsByYearAndQuarterNewestFirst(cuts: readonly DealChange[]): QuarterOfCuts[] {
  const years = [...new Set(cuts.map((record) => Number(record.date.slice(0, 4))))].sort((a, b) => b - a);
  return years.flatMap((year) => cutsByQuarterNewestFirst(year, cuts));
}

export function quarterOf(date: string): number {
  return Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
}

export function cutsByQuarterNewestFirst(year: number, cuts: readonly DealChange[]): QuarterOfCuts[] {
  return [4, 3, 2, 1]
    .map((quarter) => ({ year, quarter, records: cuts.filter((record) => record.date.startsWith(`${year}-`) && quarterOf(record.date) === quarter) }))
    .filter((group) => group.records.length > 0);
}
