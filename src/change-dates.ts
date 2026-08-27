import type { DealChange, ChangeDateSource } from "./types.js";

type DatedChange = Pick<DealChange, "date" | "date_source">;

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

export function latestEventDate(changes: DatedChange[], notAfter?: string): string | null {
  let latest: string | null = null;
  for (const c of changes) {
    if (!c.date || !isEventDated(c)) continue;
    if (notAfter && c.date > notAfter) continue;
    if (latest === null || c.date > latest) latest = c.date;
  }
  return latest;
}
