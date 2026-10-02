import type { DealChange } from "./types.js";
import { changesTheVendorMade, isOurOwnBookkeeping } from "./data.js";
import { partitionByDateProvenance } from "./change-dates.js";

type LoggedChange = Pick<DealChange, "date" | "date_source" | "recorded_date" | "change_type"> & {
  resolution?: DealChange["resolution"];
};

export interface MonthGroup<T> {
  month: string;
  changes: T[];
}

export interface ChangeLogSections<T> {
  recentMonths: MonthGroup<T>[];
  undated: T[];
  olderMonths: MonthGroup<T>[];
  ours: T[];
}

export const MONTHS_LISTED_AHEAD_OF_UNDATED_CHANGES = 3;

export const OUR_RECORDS_SECTION_HEADING = "";

export function earliestMonthListedAheadOfUndatedChanges(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return new Date(Date.UTC(year, month - MONTHS_LISTED_AHEAD_OF_UNDATED_CHANGES, 1)).toISOString().slice(0, 7);
}

function newestFirst<T extends { date: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((a, b) => b.date.localeCompare(a.date));
}

function monthGroupsNewestFirst<T extends { date: string }>(changes: readonly T[]): MonthGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const change of newestFirst(changes)) {
    const month = change.date.slice(0, 7);
    const group = groups.get(month);
    if (group) group.push(change);
    else groups.set(month, [change]);
  }
  return [...groups].map(([month, grouped]) => ({ month, changes: grouped }));
}

export function changeLogSections<T extends LoggedChange>(changes: readonly T[], today: string): ChangeLogSections<T> {
  const { dated, discovered } = partitionByDateProvenance(changesTheVendorMade(changes));
  const months = monthGroupsNewestFirst(dated);
  const earliestRecentMonth = earliestMonthListedAheadOfUndatedChanges(today);
  return {
    recentMonths: months.filter(group => group.month >= earliestRecentMonth),
    undated: newestFirst(discovered),
    olderMonths: months.filter(group => group.month < earliestRecentMonth),
    ours: newestFirst(changes.filter(isOurOwnBookkeeping)),
  };
}
