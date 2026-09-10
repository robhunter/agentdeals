import { classifyTier } from "./ranking.js";

export const RECORDED_FREE_TIER_LABELS = new Set([
  "hobby",
  "starter",
  "personal",
  "developer",
  "community",
  "open source",
]);

export function tierRecordsAFreeTier(tier: string): boolean {
  if (classifyTier(tier).class !== "free") return false;
  const label = tier.toLowerCase();
  return label.includes("free") || RECORDED_FREE_TIER_LABELS.has(label);
}

export const A_SELF_HOSTED_EDITION = /\boss\b|\bopen[\s-]?source\b|\bself[\s-]?hosted\b/i;

export function tierRecordsASelfHostedEdition(tier: string): boolean {
  return A_SELF_HOSTED_EDITION.test(tier);
}
