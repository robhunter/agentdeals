import type { DealChange, ChangeDateSource } from "./types.js";
import { PRODUCT_DEPRECATED, deprecationEndsTheListedProduct } from "./product-deprecation.js";

type DatedChange = Pick<DealChange, "date" | "date_source">;

type ExpiringChange = Pick<DealChange, "date" | "date_source" | "change_type" | "vendor" | "summary">;

export const DISCOVERED_DATE_PREFIX = "discovered";

export const DATE_SOURCES: ChangeDateSource[] = ["vendor_page", "hand_written", "discovered"];

export const EVENT_DATED_SOURCES: ChangeDateSource[] = ["vendor_page", "hand_written"];

export function isEventDated(change: Pick<DealChange, "date_source">): boolean {
  return EVENT_DATED_SOURCES.includes(change.date_source as ChangeDateSource);
}

export function partitionByDateProvenance<T extends Pick<DealChange, "date_source">>(
  changes: T[]
): { dated: T[]; discovered: T[] } {
  const dated: T[] = [];
  const discovered: T[] = [];
  for (const change of changes) (isEventDated(change) ? dated : discovered).push(change);
  return { dated, discovered };
}

export interface DateWindow {
  start: string;
  end?: string;
}

export function isoWeekWindow(date: Date): DateWindow {
  const dayOfWeek = date.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset)
  );
  const end = new Date(start.getTime() + 6 * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function withinWindow(date: string, window: DateWindow): boolean {
  return date >= window.start && (window.end === undefined || date <= window.end);
}

export function changesInWindow<T extends Pick<DealChange, "date" | "date_source">>(
  changes: T[],
  window: DateWindow
): { dated: T[]; discovered: T[] } {
  return partitionByDateProvenance(changes.filter((c) => withinWindow(c.date, window)));
}

export function firstReadHeading(count: number): string {
  return `Pages read for the first time (${count})`;
}

export function discoveryBatchNote(count: number, when: string): string {
  const pages = `${count} pricing page${count === 1 ? "" : "s"}`;
  const subject = count === 1 ? "it is" : "they are";
  const verb = count === 1 ? "is" : "are";
  const object = count === 1 ? "a change that took" : "changes that took";
  return `${pages} read for the first time ${when}. Each records terms that differ from what we had stored, on a page that does not say when they changed — so ${subject} dated by discovery and ${verb} not counted as ${object} effect ${when}.`;
}

export const UNDATED_GROUP_NOTE =
  "The vendor’s page states these terms but not when they took effect, so we can only tell you when we found them. They are listed by discovery date and are excluded from the monthly groups and the Last 30 Days count above, both of which count changes by the date they took effect.";

export function undatedGroupHeading(count: number): string {
  return `Effective date unknown (${count} ${count === 1 ? "change" : "changes"})`;
}

export function changeDateLabel(c: DatedChange): string {
  return isEventDated(c) ? c.date : `${DISCOVERED_DATE_PREFIX} ${c.date}`;
}

export function changeDateClause(c: DatedChange): string {
  return isEventDated(c) ? `on ${c.date}` : `${DISCOVERED_DATE_PREFIX} ${c.date}`;
}

export function changeDatePublished(c: DatedChange): { datePublished: string } | Record<string, never> {
  return isEventDated(c) ? { datePublished: c.date } : {};
}

export function changeEventStartDate(c: DatedChange): { startDate: string } | Record<string, never> {
  return isEventDated(c) ? { startDate: c.date } : {};
}

export function capListSections<T>(sections: T[][], cap: number): T[] {
  const allotted = sections.map(() => 0);
  let budget = cap;
  for (let i = 0; i < sections.length && budget > 0; i++) {
    if (sections[i].length === 0) continue;
    allotted[i] = 1;
    budget -= 1;
  }
  for (let i = 0; i < sections.length && budget > 0; i++) {
    const take = Math.min(budget, sections[i].length - allotted[i]);
    allotted[i] += take;
    budget -= take;
  }
  return sections.flatMap((section, i) => section.slice(0, allotted[i]));
}

export function feedEntryUpdated(day: string, now: Date = new Date()): string {
  const noon = Date.parse(`${day}T12:00:00Z`);
  if (Number.isNaN(noon)) return now.toISOString();
  return new Date(Math.min(noon, now.getTime())).toISOString();
}

export function endsTheListedOffer(change: ExpiringChange): boolean {
  if (change.change_type !== PRODUCT_DEPRECATED) return true;
  return deprecationEndsTheListedProduct(change);
}

export function offerExpiryAfter(changes: ExpiringChange[], onDate: string): string | null {
  let earliest: string | null = null;
  for (const c of changes) {
    if (!c.date || c.date <= onDate) continue;
    if (!isEventDated(c)) continue;
    if (!endsTheListedOffer(c)) continue;
    if (earliest === null || c.date < earliest) earliest = c.date;
  }
  return earliest;
}

export function latestEventDate(changes: DatedChange[], notAfter?: string): string | null {
  let latest: string | null = null;
  for (const c of changes) {
    if (!c.date || !isEventDated(c)) continue;
    if (notAfter && c.date > notAfter) continue;
    if (latest === null || c.date > latest) latest = c.date;
  }
  return latest;
}
