import { hasNotTakenEffect } from "./change-dates.js";

export const UPCOMING_CHANGES_HEADING = "Upcoming Changes";

export const UPCOMING_CHANGES_INTRO = "These are announced changes that have not taken effect yet, listed soonest first.";

export interface SplitAtTheDayServed<T> {
  inEffect: T[];
  upcoming: T[];
}

export function splitAtTheDayServed<T extends { date: string }>(newestFirst: readonly T[], servedOn: string): SplitAtTheDayServed<T> {
  return {
    inEffect: newestFirst.filter((c) => !hasNotTakenEffect(c, servedOn)),
    upcoming: newestFirst.filter((c) => hasNotTakenEffect(c, servedOn)).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
