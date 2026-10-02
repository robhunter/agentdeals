import type { DealChange } from "./types.js";
import { changesTheVendorMade, isOurOwnBookkeeping } from "./data.js";
import { groupByMonth, partitionByDateProvenance } from "./change-dates.js";

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

export function ourRecordsSectionHeading(count: number): string {
  return `Our errors and corrections (${count} ${count === 1 ? "record" : "records"})`;
}

export const OUR_RECORDS_SECTION_NOTE =
  "This section lists our retracted records and data corrections. No entry here is a vendor pricing change.";

export function earliestMonthListedAheadOfUndatedChanges(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return new Date(Date.UTC(year, month - MONTHS_LISTED_AHEAD_OF_UNDATED_CHANGES, 1)).toISOString().slice(0, 7);
}

function newestFirst<T extends { date: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((a, b) => b.date.localeCompare(a.date));
}

function monthGroupsNewestFirst<T extends { date: string }>(changes: readonly T[]): MonthGroup<T>[] {
  return [...groupByMonth(newestFirst(changes))].reverse().map(([month, grouped]) => ({ month, changes: grouped }));
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
