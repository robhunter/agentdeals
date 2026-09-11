import type { DealChange, RatingWithheld, RiskCause, SourceCheckOutcome } from "./types.js";
import { CHANGE_DIRECTION, isACorrectionToOurOwnRecord } from "./data.js";
import { changeRatesTheListedTier, type GradedOffer } from "./change-tier.js";
import { isNoLongerInForce, theEventNeverHappened } from "./change-resolution.js";
import { changeIsUncited, ratingWithheldForNoSourceSentence } from "./change-citation.js";
import { changeDateClause } from "./change-dates.js";
import {
  termsUnconfirmedOutcome,
  unconfirmedTermsClause,
  withheldLevelClause,
  type LevelWithheldReason,
  type TermsUnconfirmedReason,
} from "./source-check.js";
import type { GateCode } from "./ranking.js";
import { endedVerdictSentence } from "./retirement.js";
import { vendorHistorySentence, type PublishedRiskLevel } from "./vendor-history.js";
import {
  confirmingRead,
  confirmingReadClause,
  measuredNoDifferenceSentence,
  refusalMeasuredNoDifference,
  refusedReadClause,
  refusedReadTheConfirmationSupersedes,
  refusedReadWithholdingStability,
  supersededRefusalClause,
  unreconciledReadSentence,
  type RefusedRead,
} from "./change-refusal.js";

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
  tier?: string;
  level: PublishedRiskLevel | null;
  historyLevel: PublishedRiskLevel;
  cause: RiskCause | null;
  changes: Array<Pick<DealChange, "date" | "date_source" | "change_type"> & { source_url?: string | null } & { tier?: string | null; current_state?: string | null } & { resolution?: DealChange["resolution"] }>;
  levelWithheld: LevelWithheldReason | null;
  unconfirmableSince: string;
  ratingWithheld?: RatingWithheld | null;
  offerEnded?: boolean;
  gate?: GateCode | null;
  linkUnreachable?: boolean;
  sourceCheck?: SourceCheckOutcome | null;
  termsConfirmedOn: string;
  refusedReads?: readonly RefusedRead[];
}

export type BadgeWithholding =
  | { reason: "gated"; gate: GateCode }
  | { reason: "no_source" }
  | { reason: "read_not_reconciled"; refusedOn: string }
  | { reason: "change_measured_no_difference"; refusedOn: string }
  | { reason: LevelWithheldReason };

export type RefusedReadWithholding = Extract<
  BadgeWithholding,
  { reason: "read_not_reconciled" | "change_measured_no_difference" }
>;

export function withheldForARefusedRead(because: BadgeWithholding): because is RefusedReadWithholding {
  return because.reason === "read_not_reconciled" || because.reason === "change_measured_no_difference";
}

export function refusedReadWithholdingSentence(
  subject: string,
  because: RefusedReadWithholding,
): string {
  return because.reason === "change_measured_no_difference"
    ? measuredNoDifferenceSentence(subject, because.refusedOn)
    : unreconciledReadSentence(subject, because.refusedOn);
}

export function refusedReadWithholding(refusal: RefusedRead): BadgeWithholding {
  return refusalMeasuredNoDifference(refusal)
    ? { reason: "change_measured_no_difference", refusedOn: refusal.refused_date }
    : { reason: "read_not_reconciled", refusedOn: refusal.refused_date };
}

export type VendorBadge =
  | { kind: "ended" }
  | { kind: "rating"; word: PublishedRiskLevel }
  | { kind: "none"; because: BadgeWithholding };

export function publishedVendorLevel(
  level: PublishedRiskLevel | null,
  cause: RiskCause | null,
): PublishedRiskLevel | null {
  if (level === null) return null;
  return level === "stable" || cause ? level : "stable";
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function narrowingChanges(
  changes: VendorVerdictInput["changes"],
  offer: GradedOffer | null,
): VendorVerdictInput["changes"] {
  return changes
    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c))
    .filter(c => offer === null || changeRatesTheListedTier(c, offer))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
}

function noAdverseLevelToPublish(input: VendorVerdictInput): boolean {
  const level = publishedVendorLevel(input.level, input.cause);
  return level === null || level === "stable";
}

export function ratingWithheldForNoSource(input: VendorVerdictInput): boolean {
  return Boolean(input.ratingWithheld) && noAdverseLevelToPublish(input);
}

export function termsUnconfirmedBySource(input: VendorVerdictInput): TermsUnconfirmedReason | null {
  return termsUnconfirmedOutcome(input.sourceCheck);
}

export function unconfirmedTermsMetaSentence(reason: TermsUnconfirmedReason): string {
  return `Not verified — ${unconfirmedTermsClause(reason)}.`;
}

export function withholdingDecides(input: VendorVerdictInput): boolean {
  return (input.levelWithheld !== null || ratingWithheldForNoSource(input))
    && noAdverseLevelToPublish(input);
}

export function vendorVerdictWord(input: VendorVerdictInput): PublishedRiskLevel | null {
  if (input.offerEnded) return null;
  if (withholdingDecides(input)) return null;
  if (refusalWithholdsStability(input)) return null;
  return publishedVendorLevel(input.level, input.cause);
}

export function refusedReadWeHold(input: VendorVerdictInput): RefusedRead | null {
  return refusedReadWithholdingStability({
    historyLevel: input.historyLevel,
    publishedChanges: input.changes.length,
    termsConfirmedOn: input.termsConfirmedOn,
    refusals: input.refusedReads ?? [],
  });
}

export function refusedReadOurConfirmationSupersedes(input: VendorVerdictInput): RefusedRead | null {
  return refusedReadTheConfirmationSupersedes(input.refusedReads ?? [], input.termsConfirmedOn);
}

export function refusalWithholdsStability(input: VendorVerdictInput): RefusedRead | null {
  if (input.offerEnded) return null;
  if (input.gate) return null;
  if (withholdingDecides(input)) return null;
  if (input.linkUnreachable) return null;
  return refusedReadWeHold(input);
}

export type UnconfirmedTerms =
  | { because: "level_withheld"; clause: string }
  | { because: "refused_read"; clause: string };

export function whyWeCannotConfirmTheseTerms(input: VendorVerdictInput): UnconfirmedTerms | null {
  if (input.levelWithheld) {
    return {
      because: "level_withheld",
      clause: withheldLevelClause(input.levelWithheld, input.unconfirmableSince),
    };
  }
  const refused = refusalWithholdsStability(input);
  return refused ? { because: "refused_read", clause: refusedReadClause(refused) } : null;
}

const EMPTY_HISTORY_TAIL: Record<UnconfirmedTerms["because"], string> = {
  level_withheld: "so nothing we have read describes these terms",
  refused_read: "so we cannot tell you that nothing changed",
};

export function emptyHistoryCaveatSentence(subject: string, unconfirmed: UnconfirmedTerms): string {
  return `No recorded pricing changes for ${subject} — but ${unconfirmed.clause},`
    + ` ${EMPTY_HISTORY_TAIL[unconfirmed.because]}.`
    + ` Treat the empty history as a statement about our records, not about this vendor's pricing.`;
}

export function unconfirmedThresholdSentence(phrase: string, unconfirmed: UnconfirmedTerms): string {
  return `We record ${phrase} as the limit, but ${unconfirmed.clause},`
    + ` so we cannot confirm that threshold today.`;
}

export function badgeWithholding(input: VendorVerdictInput): BadgeWithholding | null {
  if (withholdingDecides(input)) {
    return { reason: input.levelWithheld ?? "no_source" };
  }
  if (input.gate) return { reason: "gated", gate: input.gate };
  const refused = refusalWithholdsStability(input);
  if (refused) return refusedReadWithholding(refused);
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
  const word = publishedVendorLevel(input.level, input.cause);
  if (word === null) return { kind: "none", because: { reason: input.levelWithheld ?? "no_source" } };
  return { kind: "rating", word };
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

export function withdrawnOnlySentence(records: number): string {
  if (records === 0) return "";
  return records === 1
    ? `The one record we hold was our own error and has been withdrawn.`
    : `All ${records} records we hold were our own errors and have been withdrawn.`;
}

export function isOurOwnBookkeeping(
  change: Pick<DealChange, "change_type"> & { resolution?: DealChange["resolution"] },
): boolean {
  return isACorrectionToOurOwnRecord(change) || theEventNeverHappened(change);
}

export function narrowingSentence(
  changes: VendorVerdictInput["changes"],
  offer: GradedOffer | null = null,
): string {
  const cited = changes.filter(c => !changeIsUncited(c));
  const withdrawn = cited.filter(theEventNeverHappened);
  const corrections = cited.filter(c => isACorrectionToOurOwnRecord(c) && !theEventNeverHappened(c));
  const byTheVendor = cited.filter(c => !isOurOwnBookkeeping(c));
  const total = byTheVendor.length;
  if (total === 0) {
    if (corrections.length === 0 && withdrawn.length === 0) return uncitedOnlySentence(changes.length);
    if (corrections.length === 0) return withdrawnOnlySentence(withdrawn.length);
    return corrections.length === 1
      ? `The one record we hold corrects our own earlier entry rather than reporting a change the vendor made.`
      : `All ${corrections.length} records we hold correct our own earlier entries rather than reporting changes the vendor made.`;
  }
  const narrowing = narrowingChanges(byTheVendor, offer);
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
  const refused = refusalWithholdsStability(input);
  if (refused) {
    return `${capitalise(refusedReadClause(refused))}, so we are not rating this offer today.`;
  }

  const level = publishedVendorLevel(input.level, input.cause);
  if (input.gate || level === null) return vendorHistorySentence(input.vendor, input.historyLevel, input.cause);

  if (level !== "stable" && input.cause) {
    const unconfirmed = input.levelWithheld
      ? ` ${capitalise(withheldLevelClause(input.levelWithheld, input.unconfirmableSince))}, so we cannot confirm the terms above.`
      : "";
    return `We rate it ${level} — one recorded ${changeKindNoun(input.cause.change_type)}, ${changeDateClause(input.cause)}.${unconfirmed}`;
  }

  if (input.changes.length === 0) {
    const superseded = refusedReadOurConfirmationSupersedes(input);
    if (superseded) {
      return `It's stable — ${supersededRefusalClause(superseded.refused_date, input.termsConfirmedOn)}.`;
    }
    const confirmed = confirmingRead(input.refusedReads ?? []);
    return confirmed
      ? `It's stable — ${confirmingReadClause(confirmed)}.`
      : `It's stable — zero pricing changes recorded.`;
  }
  return `We rate it stable. ${narrowingSentence(input.changes, { vendor: input.vendor, tier: input.tier })}`;
}
