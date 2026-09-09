import { DEFAULT_CHANGE_WINDOW_DAYS } from "./data.js";
import { isNoLongerInForce } from "./change-resolution.js";

export const REMOVAL_CLASS = new Set(["free_tier_removed", "product_deprecated"]);

export function saysAFreeTierEnded(changeType: string): boolean {
  return REMOVAL_CLASS.has(changeType);
}

export function aFreePlanOnThePageWouldRefuteIt(changeType: string): boolean {
  return changeType === "free_tier_removed";
}

type RemovalCandidate = {
  change_type: string;
  date: string;
  resolution?: unknown;
};

export function servedWindowOpens(nowMs: number = Date.now()): string {
  return new Date(nowMs - DEFAULT_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function removalRecordsInTheServedWindow<T extends RemovalCandidate>(
  changes: readonly T[],
  nowMs: number = Date.now(),
): T[] {
  const opens = servedWindowOpens(nowMs);
  return changes.filter((c) => saysAFreeTierEnded(c.change_type) && c.date >= opens);
}

export function removalRecordsStillInForce<T extends RemovalCandidate>(changes: readonly T[]): T[] {
  return changes.filter((c) => saysAFreeTierEnded(c.change_type) && !isNoLongerInForce(c as { resolution?: never }));
}
