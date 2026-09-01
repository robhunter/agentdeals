import type { RiskCause } from "./types.js";
import { changeDateClause } from "./change-dates.js";

export type PublishedRiskLevel = "stable" | "caution" | "risky";

export function vendorHistorySentence(
  vendor: string,
  level: PublishedRiskLevel,
  cause: RiskCause | null,
): string {
  if (level === "risky" && cause) {
    return `${vendor} is high risk — ${changeDateClause(cause)}: ${cause.summary} Consider alternatives.`;
  }
  if (level === "caution" && cause) {
    return `${vendor} warrants caution — ${changeDateClause(cause)}: ${cause.summary} Monitor for further changes.`;
  }
  return `${vendor} has a stable pricing history.`;
}
