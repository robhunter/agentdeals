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

export const LATEST_PRICING_CHANGES_HEADING = "Latest Pricing Changes";

export const LATEST_PRICING_CHANGES_SHOWN = 10;

export const LATEST_PRICING_CHANGES_DESCRIPTION = `The ${LATEST_PRICING_CHANGES_SHOWN} most recent pricing changes in effect, then any announced changes that have not taken effect yet, soonest first`;

export function latestPricingChangesText<T extends { date: string }>(newestFirst: readonly T[], entry: (change: T) => string, servedOn: string = new Date().toISOString().slice(0, 10)): string {
  const { inEffect, upcoming } = splitAtTheDayServed(newestFirst, servedOn);
  const latest = `# ${LATEST_PRICING_CHANGES_HEADING}\n\n${inEffect.slice(0, LATEST_PRICING_CHANGES_SHOWN).map(entry).join("\n\n")}`;
  if (upcoming.length === 0) return latest;
  return `${latest}\n\n# ${UPCOMING_CHANGES_HEADING}\n\n${UPCOMING_CHANGES_INTRO}\n\n${upcoming.map(entry).join("\n\n")}`;
}
