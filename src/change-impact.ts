export const CHANGE_IMPACT_LEVELS = ["high", "medium", "low"] as const;

export type ChangeImpactLevel = (typeof CHANGE_IMPACT_LEVELS)[number];

const IMPACT_COLOR: Record<ChangeImpactLevel, string> = {
  high: "#f85149",
  medium: "#d29922",
  low: "#3fb950",
};

export const UNGRADED_IMPACT_COLOR = "#8b949e";

export const UNGRADED_IMPACT_LABEL = "UNGRADED";

export function isChangeImpactLevel(impact: unknown): impact is ChangeImpactLevel {
  return typeof impact === "string" && (CHANGE_IMPACT_LEVELS as readonly string[]).includes(impact);
}

export function changeImpactColor(impact: unknown): string {
  return isChangeImpactLevel(impact) ? IMPACT_COLOR[impact] : UNGRADED_IMPACT_COLOR;
}

export function changeImpactLabel(impact: unknown): string {
  return isChangeImpactLevel(impact) ? impact.toUpperCase() : UNGRADED_IMPACT_LABEL;
}

export function changeImpactWord(impact: unknown): string {
  return isChangeImpactLevel(impact) ? impact : UNGRADED_IMPACT_LABEL.toLowerCase();
}

export function ungradedImpactValues(changes: readonly { impact?: unknown }[]): string[] {
  const seen = new Set<string>();
  for (const change of changes) {
    if (isChangeImpactLevel(change.impact)) continue;
    seen.add(change.impact === undefined || change.impact === null ? "" : String(change.impact));
  }
  return [...seen].sort();
}
