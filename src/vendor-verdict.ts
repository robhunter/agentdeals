import type { DealChange, RiskCause } from "./types.js";
import { CHANGE_DIRECTION, isACorrectionToOurOwnRecord } from "./data.js";
import { changeDateClause } from "./change-dates.js";
import { withheldLevelClause, type LevelWithheldReason } from "./source-check.js";

export type PublishedRiskLevel = "stable" | "caution" | "risky";

export const DEMOTING_KINDS_PHRASE = "free tier removal, limit reduction or pricing restructure";

export const CHANGE_KIND_NOUN: Record<DealChange["change_type"], string> = {
  free_tier_removed: "free tier removal",
  open_source_killed: "move away from open source",
  limits_reduced: "limit reduction",
  pricing_restructured: "pricing restructure",
  product_deprecated: "product deprecation",
  restriction: "restriction",
  pricing_model_change: "pricing model change",
  limits_increased: "limit increase",
  new_free_tier: "new free tier",
  new_tier: "new tier",
  startup_program_expanded: "startup program expansion",
  pricing_postponed: "postponed price change",
  rebranded: "rebrand",
  record_corrected: "correction to our own entry",
};

export function changeKindNoun(changeType: string): string {
  return CHANGE_KIND_NOUN[changeType as DealChange["change_type"]] ?? changeType.replace(/_/g, " ");
}

export interface VendorVerdictInput {
  level: PublishedRiskLevel | null;
  cause: RiskCause | null;
  changes: Array<Pick<DealChange, "date" | "date_source" | "change_type">>;
  levelWithheld: LevelWithheldReason | null;
  unconfirmableSince: string;
}

export function publishedVendorLevel(
  level: PublishedRiskLevel | null,
  cause: RiskCause | null,
): PublishedRiskLevel {
  return level && (level === "stable" || cause) ? level : "stable";
}

function narrowingChanges(
  changes: VendorVerdictInput["changes"],
): VendorVerdictInput["changes"] {
  return changes
    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative")
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function vendorVerdictWord(input: VendorVerdictInput): PublishedRiskLevel | null {
  if (input.levelWithheld) return null;
  return publishedVendorLevel(input.level, input.cause);
}

export function narrowingSentence(changes: VendorVerdictInput["changes"]): string {
  const corrections = changes.filter(isACorrectionToOurOwnRecord);
  const byTheVendor = changes.filter(c => !isACorrectionToOurOwnRecord(c));
  const total = byTheVendor.length;
  if (total === 0) {
    if (corrections.length === 0) return "";
    return corrections.length === 1
      ? `The one record we hold corrects our own earlier entry rather than reporting a change the vendor made.`
      : `All ${corrections.length} records we hold correct our own earlier entries rather than reporting changes the vendor made.`;
  }
  const narrowing = narrowingChanges(byTheVendor);
  if (narrowing.length === 0) {
    return total === 1
      ? `The one change we have recorded did not narrow the terms.`
      : `None of the ${total} recorded changes narrowed the terms.`;
  }
  if (narrowing.length === 1) {
    return `One recorded ${changeKindNoun(narrowing[0].change_type)} narrowed the terms, ${changeDateClause(narrowing[0])}.`;
  }
  return `${narrowing.length} recorded changes narrowed the terms, the most recent ${changeDateClause(narrowing[0])}.`;
}

export function vendorVerdictSentence(input: VendorVerdictInput): string {
  if (input.levelWithheld) {
    const clause = withheldLevelClause(input.levelWithheld, input.unconfirmableSince);
    return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}, so we cannot confirm these terms today.`;
  }

  const level = publishedVendorLevel(input.level, input.cause);
  if (level !== "stable" && input.cause) {
    return `We rate it ${level} — one recorded ${changeKindNoun(input.cause.change_type)}, ${changeDateClause(input.cause)}.`;
  }

  if (input.changes.length === 0) return `It's stable — zero pricing changes recorded.`;
  return `We rate it stable — we hold no ${DEMOTING_KINDS_PHRASE} for this vendor. ${narrowingSentence(input.changes)}`;
}
