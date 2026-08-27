import { isEventDated } from "./data.js";
import type { DealChange } from "./types.js";

type DatedChange = Pick<DealChange, "date" | "date_source">;

export const DISCOVERED_DATE_PREFIX = "discovered";

export const UNDATED_GROUP_NOTE =
  "The vendor’s page states these terms but not when they took effect, so we can only tell you when we found them. They are listed by discovery date and are excluded from the monthly groups and the Last 30 Days count above, both of which count changes by the date they took effect.";

export function undatedGroupHeading(count: number): string {
  return `Effective date unknown (${count} ${count === 1 ? "change" : "changes"})`;
}

export function changeDateLabel(c: DatedChange): string {
  return isEventDated(c) ? c.date : `${DISCOVERED_DATE_PREFIX} ${c.date}`;
}

export function changeDatePublished(c: DatedChange): { datePublished: string } | Record<string, never> {
  return isEventDated(c) ? { datePublished: c.date } : {};
}
