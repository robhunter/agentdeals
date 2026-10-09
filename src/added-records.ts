import { classifyTier } from "./ranking.js";
import type { Offer } from "./types.js";

export type RecordIdentity = Pick<Offer, "vendor" | "category" | "url">;

export function recordIdentity(record: RecordIdentity): string {
  return `${record.vendor}|${record.category}|${record.url}`;
}

export function recordsAddedFreeOnAPageThatDoesNotNameThem<T extends RecordIdentity & Pick<Offer, "tier" | "source_check">>(
  before: readonly RecordIdentity[],
  after: readonly T[],
): T[] {
  const held = new Set(before.map(recordIdentity));
  return after.filter(record =>
    !held.has(recordIdentity(record)) &&
    record.source_check?.outcome === "does_not_name_vendor" &&
    classifyTier(record.tier).class === "free",
  );
}
