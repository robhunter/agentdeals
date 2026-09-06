import type { DealChange, RatingWithheld, RiskCause } from "./types.js";
import { CHANGE_DIRECTION, isACorrectionToOurOwnRecord } from "./data.js";
import { isNoLongerInForce } from "./change-resolution.js";
import { changeIsUncited, ratingWithheldForNoSourceSentence } from "./change-citation.js";
import { changeDateClause } from "./change-dates.js";
import { withheldLevelClause, type LevelWithheldReason } from "./source-check.js";
import type { GateCode } from "./ranking.js";
import { endedVerdictSentence } from "./retirement.js";
import { vendorHistorySentence, type PublishedRiskLevel } from "./vendor-history.js";

export type { PublishedRiskLevel };

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
  vendor: string;
  level: PublishedRiskLevel | null;
  cause: RiskCause | null;
  changes: Array<Pick<DealChange, "date" | "date_source" | "change_type"> & { source_url?: string | null } & { resolution?: DealChange["resolution"] }>;
  levelWithheld: LevelWithheldReason | null;
  unconfirmableSince: string;
  ratingWithheld?: RatingWithheld | null;
  offerEnded?: boolean;
  gate?: GateCode | null;
  linkUnreachable?: boolean;
}

export type BadgeWithholding =
  | { reason: "gated"; gate: GateCode }
  | { reason: "no_source" }
  | { reason: LevelWithheldReason };

export type VendorBadge =
  | { kind: "ended" }
  | { kind: "rating"; word: PublishedRiskLevel }
  | { kind: "none"; because: BadgeWithholding };

export function publishedVendorLevel(
  level: PublishedRiskLevel | null,
  cause: RiskCause | null,
): PublishedRiskLevel {
  return level && (level === "stable" || cause) ? level : "stable";
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function narrowingChanges(
  changes: VendorVerdictInput["changes"],
): VendorVerdictInput["changes"] {
  return changes
    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function ratingWithheldForNoSource(input: VendorVerdictInput): boolean {
  return Boolean(input.ratingWithheld) && publishedVendorLevel(input.level, input.cause) === "stable";
}

export function withholdingDecides(input: VendorVerdictInput): boolean {
  return (input.levelWithheld !== null || ratingWithheldForNoSource(input))
    && publishedVendorLevel(input.level, input.cause) === "stable";
}

export function vendorVerdictWord(input: VendorVerdictInput): PublishedRiskLevel | null {
  if (input.offerEnded) return null;
  if (withholdingDecides(input)) return null;
  return publishedVendorLevel(input.level, input.cause);
}

export function badgeWithholding(input: VendorVerdictInput): BadgeWithholding | null {
  if (withholdingDecides(input)) {
    return { reason: input.levelWithheld ?? "no_source" };
  }
  if (input.gate) return { reason: "gated", gate: input.gate };
  if (input.level === null) return { reason: input.levelWithheld ?? "no_source" };
  if (input.linkUnreachable && publishedVendorLevel(input.level, input.cause) === "stable") {
    return { reason: "link_unreachable" };
  }
  return null;
}

export function vendorBadge(input: VendorVerdictInput): VendorBadge {
  if (input.offerEnded) return { kind: "ended" };
  const withheld = badgeWithholding(input);
  if (withheld) return { kind: "none", because: withheld };
  return { kind: "rating", word: publishedVendorLevel(input.level, input.cause) };
}

export type FreeTierClaim =
  | { states: "offered"; level: PublishedRiskLevel }
  | { states: "ended"; how: "retired" }
  | { states: "ended"; how: "removed"; cause: RiskCause }
  | { states: "unconfirmed"; because: BadgeWithholding };

export function freeTierClaim(input: VendorVerdictInput): FreeTierClaim {
  const badge = vendorBadge(input);
  if (badge.kind === "ended") return { states: "ended", how: "retired" };
  if (badge.kind === "none") return { states: "unconfirmed", because: badge.because };
  if (badge.word === "risky" && input.cause) return { states: "ended", how: "removed", cause: input.cause };
  return { states: "offered", level: badge.word };
}

export function statesRiskCause(input: VendorVerdictInput): boolean {
  const word = vendorVerdictWord(input);
  return word !== null && word !== "stable" && input.cause !== null;
}

export function uncitedOnlySentence(records: number): string {
  if (records === 0) return "";
  return records === 1
    ? `The one record we hold cites no source, so it sets no rating.`
    : `All ${records} records we hold cite no source, so none of them sets a rating.`;
}

export function narrowingSentence(changes: VendorVerdictInput["changes"]): string {
  const cited = changes.filter(c => !changeIsUncited(c));
  const corrections = cited.filter(isACorrectionToOurOwnRecord);
  const byTheVendor = cited.filter(c => !isACorrectionToOurOwnRecord(c));
  const total = byTheVendor.length;
  if (total === 0) {
    if (corrections.length === 0) return uncitedOnlySentence(changes.length);
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
  if (input.offerEnded) return endedVerdictSentence();
  if (withholdingDecides(input)) {
    if (input.levelWithheld === null) return ratingWithheldForNoSourceSentence(input.vendor);
    const clause = withheldLevelClause(input.levelWithheld, input.unconfirmableSince);
    return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}, so we cannot confirm these terms today.`;
  }
  const level = publishedVendorLevel(input.level, input.cause);
  if (input.gate) return vendorHistorySentence(input.vendor, level, input.cause);

  if (level !== "stable" && input.cause) {
    const unconfirmed = input.levelWithheld
      ? ` ${capitalise(withheldLevelClause(input.levelWithheld, input.unconfirmableSince))}, so we cannot confirm the terms above.`
      : "";
    return `We rate it ${level} — one recorded ${changeKindNoun(input.cause.change_type)}, ${changeDateClause(input.cause)}.${unconfirmed}`;
  }

  if (input.changes.length === 0) return `It's stable — zero pricing changes recorded.`;
  return `We rate it stable. ${narrowingSentence(input.changes)}`;
}
