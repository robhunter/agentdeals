import { theEventNeverHappened } from "./change-resolution.js";
import type { ChangeResolution } from "./types.js";

export interface LineupClaim {
  vendor: string;
  date: string;
  change_type?: string;
  summary?: string;
  current_state?: string;
  resolution?: ChangeResolution | null;
}

const PRICE_TOKEN = /\$\d[\d,]*(?:\.\d+)?/g;

export const PRICES_THAT_MAKE_A_LINEUP = 2;
export const NOT_A_VENDOR_CHANGE = "record_corrected";

export function statedPrices(change: LineupClaim): Set<string> {
  const text = [change.summary, change.current_state].filter(Boolean).join(" ");
  return new Set(text.match(PRICE_TOKEN) ?? []);
}

export function statesAPlanLineup(change: LineupClaim): boolean {
  if (change.change_type === NOT_A_VENDOR_CHANGE) return false;
  if (theEventNeverHappened(change)) return false;
  return statedPrices(change).size >= PRICES_THAT_MAKE_A_LINEUP;
}

export function supersededLineups<T extends LineupClaim>(changes: readonly T[]): Map<T, T> {
  const newestByVendor = new Map<string, T>();
  for (const change of changes) {
    if (!statesAPlanLineup(change)) continue;
    const held = newestByVendor.get(change.vendor);
    if (!held || change.date > held.date) newestByVendor.set(change.vendor, change);
  }

  const superseded = new Map<T, T>();
  for (const change of changes) {
    if (!statesAPlanLineup(change)) continue;
    const newest = newestByVendor.get(change.vendor)!;
    if (newest !== change && newest.date > change.date) superseded.set(change, newest);
  }
  return superseded;
}

export function changeTimelineDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function supersessionNote(newest: LineupClaim, formatDate: (iso: string) => string): string {
  return `Superseded by our ${formatDate(newest.date)} record`;
}
