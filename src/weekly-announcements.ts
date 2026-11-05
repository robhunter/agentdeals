import type { DealChange } from "./types.js";
import type { DateWindow } from "./change-dates.js";

export const WEEKLY_ANNOUNCEMENTS_INTRO = "These changes were announced this week but take effect after this week. A change announced and taking effect in the same week is listed with the changes that took effect.";

export function isAnnouncementDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function announcementsInWeek(changes: readonly DealChange[], week: DateWindow): DealChange[] {
  return changes.filter(change => isAnnouncementDate(change.announced_on)
    && change.announced_on >= week.start && change.announced_on <= week.end!
    && change.date > week.end!).sort((a, b) => a.date.localeCompare(b.date));
}

export function weeklyAnnouncementNote(count: number): string {
  return count === 1 ? "1 change announced this week takes effect later." : `${count} changes announced this week take effect later.`;
}

export function weeklyAnnouncementHeading(count: number): string {
  return `Announced this week (${count})`;
}

export function announcementDateLabel(change: DealChange): string {
  return `announced ${change.announced_on} · effective ${change.date}`;
}
