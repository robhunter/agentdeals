import type { DealChange, RatingWithheld, RiskCause, SourceCheck, SourceCheckOutcome } from "./types.js";
import { restatedReadingDate, type TermsWeCannotConfirm } from "./read-date.js";
import { CHANGE_DIRECTION, isACorrectionToOurOwnRecord } from "./data.js";
import { changeRatesTheListedTier, type GradedOffer } from "./change-tier.js";
import { isNoLongerInForce, theEventNeverHappened } from "./change-resolution.js";
import { changeIsUncited, ratingWithheldForNoSourceSentence } from "./change-citation.js";
import { changeDateClause } from "./change-dates.js";
import {
  amountUnstatedSentence,
  freePriceConfirmedSentence,
  freePriceOnlySentence,
  levelWithheldReason,
  levelWithheldSince,
  outcomeConfirmsThePrice,
  recordPublishesAQuantity,
  termsOnlyOutcome,
  termsUnconfirmedOutcome,
  unconfirmedTermsClause,
  withheldLevelClause,
  withheldLevelSentence,
  type LevelWithheldReason,
  type TermsOnlyOutcome,
  type TermsUnconfirmedReason,
} from "./source-check.js";
import type { GateCode } from "./ranking.js";
import { endedVerdictSentence } from "./retirement.js";
import { vendorHistorySentence, type PublishedRiskLevel } from "./vendor-history.js";
import {
  confirmingRead,
  confirmingReadClause,
  measuredNoDifferenceClause,
  measuredNoDifferenceMetaClause,
  measuredNoDifferenceSentence,
  refusalMeasuredNoDifference,
  refusedReadClause,
  refusedReadTheConfirmationSupersedes,
  refusedReadWithholdingStability,
  supersededRefusalClause,
  unreconciledReadClause,
  unreconciledReadMetaClause,
  unreconciledReadSentence,
  MEASURED_NO_DIFFERENCE_BADGE_LABEL,
  UNRECONCILED_READ_BADGE_LABEL,
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
  sourceChecked?: string | null;
  linkCheckedOn?: string | null;
  termsConfirmedOn: string;
  refusedReads?: readonly RefusedRead[];
  publishesAQuantity?: boolean;
  termsSuperseded?: boolean;
  termsReadFrom?: string | null;
}

export type BadgeWithholding =
  | { reason: "gated"; gate: GateCode }
  | { reason: "no_source" }
  | { reason: "read_not_reconciled"; refusedOn: string }
  | { reason: "change_measured_no_difference"; refusedOn: string }
  | { reason: LevelWithheldReason };

export type Withholding = BadgeWithholding | { reason: TermsOnlyOutcome };

export type RefusedReadWithholding = Extract<
  BadgeWithholding,
  { reason: "read_not_reconciled" | "change_measured_no_difference" }
>;

export function withheldForARefusedRead(because: Withholding): because is RefusedReadWithholding {
  return because.reason === "read_not_reconciled" || because.reason === "change_measured_no_difference";
}

export type BadgeWithholdingTag = Exclude<BadgeWithholding["reason"], "gated"> | GateCode;

export type WithholdingTag = Exclude<Withholding["reason"], "gated"> | GateCode;

export function withholdingTag(because: BadgeWithholding): BadgeWithholdingTag;
export function withholdingTag(because: Withholding): WithholdingTag;
export function withholdingTag(because: Withholding): WithholdingTag {
  return because.reason === "gated" ? because.gate : because.reason;
}

export type WithholdingScope = "the_terms" | "the_rating";

export const WITHHOLDING_SCOPE = {
  link_unreachable: "the_terms",
  unreadable: "the_terms",
  states_no_terms: "the_terms",
  does_not_name_vendor: "the_terms",
  does_not_name_product: "the_terms",
  states_no_amount: "the_terms",
  states_a_free_price: "the_terms",
  read_not_reconciled: "the_terms",
  change_measured_no_difference: "the_terms",
  no_source: "the_rating",
  eligibility_restricted: "the_rating",
  not_a_free_offer: "the_rating",
  offer_expired: "the_rating",
  offer_retired: "the_rating",
  verification_lapsed: "the_rating",
} as const satisfies Record<WithholdingTag, WithholdingScope>;

export type TermsWithholdingTag = {
  [K in WithholdingTag]: (typeof WITHHOLDING_SCOPE)[K] extends "the_terms" ? K : never;
}[WithholdingTag];

export type TermsWithholding = Extract<Withholding, { reason: TermsWithholdingTag }>;

export function withholdsTheTerms(because: Withholding): because is TermsWithholding {
  return WITHHOLDING_SCOPE[withholdingTag(because)] === "the_terms";
}

export const WITHHOLDING_BADGE_LABELS: Record<BadgeWithholdingTag, string> = {
  no_source: "unrated — no source",
  link_unreachable: "unrated — page unreachable",
  unreadable: "unrated — page unreadable",
  states_no_terms: "unrated — page states no price",
  does_not_name_vendor: "unrated — page omits vendor",
  does_not_name_product: "unrated — page omits product",
  read_not_reconciled: UNRECONCILED_READ_BADGE_LABEL,
  change_measured_no_difference: MEASURED_NO_DIFFERENCE_BADGE_LABEL,
  eligibility_restricted: "unrated — restricted offer",
  not_a_free_offer: "unrated — not a free offer",
  offer_expired: "unrated — offer expired",
  offer_retired: "unrated — offer ended",
  verification_lapsed: "unrated — not re-confirmed",
};

export function withheldBadgeLabel(because: BadgeWithholding): string {
  return WITHHOLDING_BADGE_LABELS[withholdingTag(because)];
}

export function refusedReadWithholdingSentence(
  subject: string,
  because: RefusedReadWithholding,
): string {
  return because.reason === "change_measured_no_difference"
    ? measuredNoDifferenceSentence(subject, because.refusedOn)
    : unreconciledReadSentence(subject, because.refusedOn);
}

export function refusedReadWithholdingClause(because: RefusedReadWithholding): string {
  return because.reason === "change_measured_no_difference"
    ? measuredNoDifferenceClause(because.refusedOn)
    : unreconciledReadClause(because.refusedOn);
}

export function refusedReadWithholdingMetaClause(because: RefusedReadWithholding): string {
  return because.reason === "change_measured_no_difference"
    ? measuredNoDifferenceMetaClause(because.refusedOn)
    : unreconciledReadMetaClause(because.refusedOn);
}

export function refusedReadWithholding(refusal: RefusedRead): RefusedReadWithholding {
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

export function narrowingChanges(
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
  return NOT_VERIFIED(unconfirmedTermsClause(reason));
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

export interface UnconfirmedTerms {
  because: TermsWithholding;
  clause: string;
  sentence: string;
  theReadFoundAFreePlan: boolean;
  on: string | null;
}

export type WhatTheReadLeftStanding = "nothing" | "the_free_plan";

export const WHAT_THE_READ_LEFT_STANDING = {
  link_unreachable: "nothing",
  unreadable: "nothing",
  states_no_terms: "nothing",
  does_not_name_vendor: "nothing",
  does_not_name_product: "nothing",
  states_no_amount: "the_free_plan",
  states_a_free_price: "the_free_plan",
  read_not_reconciled: "nothing",
  change_measured_no_difference: "nothing",
} as const satisfies Record<TermsWithholdingTag, WhatTheReadLeftStanding>;

type ReadNothingTag = {
  [K in TermsWithholdingTag]: (typeof WHAT_THE_READ_LEFT_STANDING)[K] extends "nothing" ? K : never;
}[TermsWithholdingTag];

export interface TermsNoReadDescribes extends UnconfirmedTerms {
  because: Extract<TermsWithholding, { reason: ReadNothingTag }>;
}

export function nothingWeReadDescribesTheTerms(
  unconfirmed: UnconfirmedTerms,
): unconfirmed is TermsNoReadDescribes {
  return !unconfirmed.theReadFoundAFreePlan;
}

type TermsOnlySentence = (subject: string, publishesAQuantity: boolean, readFrom: string | null) => string;

const TERMS_ONLY_SENTENCES: Record<TermsOnlyOutcome, TermsOnlySentence> = {
  states_no_amount: (subject, _publishesAQuantity, readFrom) => amountUnstatedSentence(subject, readFrom),
  states_a_free_price: (subject, publishesAQuantity, readFrom) =>
    publishesAQuantity ? freePriceConfirmedSentence(subject, readFrom) : freePriceOnlySentence(subject),
};

type TermsOnlyWithholding = Extract<TermsWithholding, { reason: TermsOnlyOutcome }>;

function withheldOnAReadWeCouldNotQuantify(because: TermsWithholding): because is TermsOnlyWithholding {
  return Object.prototype.hasOwnProperty.call(TERMS_ONLY_SENTENCES, because.reason);
}

export interface TermsEvidence {
  vendor: string;
  levelWithheld: LevelWithheldReason | null;
  unconfirmableSince: string;
  refusedRead: RefusedRead | null;
  sourceCheck: SourceCheckOutcome | null;
  sourceChecked?: string | null;
  linkCheckedOn?: string | null;
  publishesAQuantity?: boolean;
  termsReadFrom?: string | null;
}

export const TERMS_WITHHELD_LABELS: Record<TermsWithholdingTag, string> = {
  link_unreachable: "page did not resolve",
  unreadable: "page unreadable",
  states_no_terms: "page states no amount",
  does_not_name_vendor: "page omits the vendor",
  does_not_name_product: "page omits the product",
  states_no_amount: "page names a plan, no amount",
  states_a_free_price: "page states a free price",
  read_not_reconciled: "read not reconciled",
  change_measured_no_difference: "no difference measured",
};

export function termsWithheldLabel(unconfirmed: UnconfirmedTerms): string {
  return TERMS_WITHHELD_LABELS[unconfirmed.because.reason];
}

function termsWithholding(evidence: TermsEvidence): TermsWithholding | null {
  if (evidence.levelWithheld) return { reason: evidence.levelWithheld };
  if (evidence.refusedRead) return refusedReadWithholding(evidence.refusedRead);
  const termsOnly = termsOnlyOutcome(evidence.sourceCheck);
  if (!termsOnly) return null;
  if (outcomeConfirmsThePrice(termsOnly) && !publishesAQuantity(evidence)) return null;
  return { reason: termsOnly };
}

function publishesAQuantity(evidence: TermsEvidence): boolean {
  return evidence.publishesAQuantity ?? true;
}

export interface PublishedTermsRow {
  vendor: string;
  description?: string | null;
  source_check?: Pick<SourceCheck, "outcome" | "checked"> | null;
  link_unreachable?: { last_reachable?: string | null; checked?: string | null } | null;
  refused_read?: RefusedRead | null;
  rating_withheld?: RatingWithheld | null;
  gate?: unknown;
  risk_level?: PublishedRiskLevel | null;
  risk_cause?: RiskCause | null;
  offer_ended?: boolean;
  restated_from?: { reading_date: string } | null;
}

export function publishedTermsEvidence(row: PublishedTermsRow): TermsEvidence {
  const source = { source_check: (row.source_check ?? undefined) as SourceCheck | undefined };
  const link = row.link_unreachable ?? null;
  const levelWithheld = levelWithheldReason(source, link);
  const level = publishedVendorLevel(row.risk_level ?? null, row.risk_cause ?? null);
  const noAdverseLevel = level === null || level === "stable";
  const withholdingDecided =
    (levelWithheld !== null || (Boolean(row.rating_withheld) && noAdverseLevel)) && noAdverseLevel;
  const refusedRead =
    row.offer_ended || row.gate || withholdingDecided || link ? null : row.refused_read ?? null;
  return {
    vendor: row.vendor,
    levelWithheld,
    unconfirmableSince: levelWithheldSince(source, link),
    refusedRead,
    sourceCheck: row.source_check?.outcome ?? null,
    sourceChecked: row.source_check?.checked ?? null,
    linkCheckedOn: link?.checked ?? null,
    publishesAQuantity: recordPublishesAQuantity(row.description),
    termsReadFrom: restatedReadingDate(row),
  };
}

export function termsEvidenceOf(input: VendorVerdictInput): TermsEvidence {
  return {
    vendor: input.vendor,
    levelWithheld: input.levelWithheld,
    unconfirmableSince: input.unconfirmableSince,
    refusedRead: refusalWithholdsStability(input),
    sourceCheck: input.sourceCheck ?? null,
    sourceChecked: input.sourceChecked ?? null,
    linkCheckedOn: input.linkCheckedOn ?? null,
    publishesAQuantity: input.publishesAQuantity,
    termsReadFrom: input.termsReadFrom ?? null,
  };
}

function whenWeCouldNotConfirm(evidence: TermsEvidence, because: TermsWithholding): string | null {
  if (withheldForARefusedRead(because)) return because.refusedOn;
  if (because.reason === "link_unreachable") return evidence.linkCheckedOn ?? null;
  return evidence.sourceChecked ?? null;
}

export function whyWeCannotConfirmTheseTerms(input: VendorVerdictInput): UnconfirmedTerms | null {
  return unconfirmedTermsFrom(termsEvidenceOf(input));
}

export function unconfirmedTermsFrom(input: TermsEvidence): UnconfirmedTerms | null {
  const because = termsWithholding(input);
  if (!because) return null;
  const theReadFoundAFreePlan = WHAT_THE_READ_LEFT_STANDING[because.reason] === "the_free_plan";
  const on = whenWeCouldNotConfirm(input, because);
  if (withheldForARefusedRead(because)) {
    return {
      because,
      theReadFoundAFreePlan,
      on,
      clause: refusedReadWithholdingClause(because),
      sentence: refusedReadWithholdingSentence(input.vendor, because),
    };
  }
  if (withheldOnAReadWeCouldNotQuantify(because)) {
    return {
      because,
      theReadFoundAFreePlan,
      on,
      clause: unconfirmedTermsClause(because.reason),
      sentence: TERMS_ONLY_SENTENCES[because.reason](
        input.vendor,
        publishesAQuantity(input),
        input.termsReadFrom ?? null,
      ),
    };
  }
  return {
    because,
    theReadFoundAFreePlan,
    on,
    clause: withheldLevelClause(because.reason, input.unconfirmableSince),
    sentence: withheldLevelSentence(because.reason, input.vendor, input.unconfirmableSince),
  };
}

export const CANNOT_CONFIRM_THESE_TERMS = "so we cannot confirm these terms";

export function unconfirmedTermsSentence(unconfirmed: UnconfirmedTerms): string {
  return unconfirmed.theReadFoundAFreePlan
    ? unconfirmed.sentence
    : `${capitalise(unconfirmed.clause)}, ${CANNOT_CONFIRM_THESE_TERMS} today.`;
}

export function refusedReadVerdictSentence(because: RefusedReadWithholding): string {
  return `${capitalise(refusedReadWithholdingClause(because))},`
    + ` ${CANNOT_CONFIRM_THESE_TERMS} and are not rating this offer today.`;
}

export const UNVERIFIED_TERMS_CAVEAT =
  "We have not confirmed these terms against the source we cite, so treat them as unverified.";

export function unconfirmedTermsOpening(unconfirmed: UnconfirmedTerms): string {
  return unconfirmed.theReadFoundAFreePlan ? "" : `We cannot confirm that today. ${unconfirmed.sentence} `;
}

export function closingTerms(terms: string): string {
  return /[.!?…]$/.test(terms.trim()) ? terms : `${terms}.`;
}

export function withUnconfirmedTerms(terms: string, unconfirmed: UnconfirmedTerms): string {
  return `${closingTerms(terms)} ${unconfirmed.theReadFoundAFreePlan ? unconfirmed.sentence : UNVERIFIED_TERMS_CAVEAT}`;
}

export function termsWithTheReasonWeCannotConfirmThem(terms: string, unconfirmed: UnconfirmedTerms): string {
  return `${closingTerms(terms)} ${unconfirmedTermsSentence(unconfirmed)}`;
}

const EMPTY_HISTORY_TAIL: Record<ReadNothingTag, string> = {
  link_unreachable: "so nothing we have read describes these terms",
  unreadable: "so nothing we have read describes these terms",
  states_no_terms: "so nothing we have read describes these terms",
  does_not_name_vendor: "so nothing we have read describes these terms",
  does_not_name_product: "so nothing we have read describes these terms",
  read_not_reconciled: "so we cannot tell you that nothing changed",
  change_measured_no_difference: "so we cannot tell you that nothing changed",
};

export function emptyHistoryCaveatSentence(subject: string, unconfirmed: TermsNoReadDescribes): string {
  return `No recorded pricing changes for ${subject} — but ${unconfirmed.clause},`
    + ` ${EMPTY_HISTORY_TAIL[unconfirmed.because.reason]}.`
    + ` Treat the empty history as a statement about our records, not about this vendor's pricing.`;
}

export const NOT_VERIFIED = (clause: string): string => `Not verified — ${clause}.`;

export function theReadConfirmedThePrice(unconfirmed: UnconfirmedTerms | null | undefined): boolean {
  return outcomeConfirmsThePrice(unconfirmed?.because.reason);
}

export function termsTheVerdictWithholds(
  unconfirmed: UnconfirmedTerms | null | undefined,
): TermsWeCannotConfirm | null {
  if (!unconfirmed || theReadConfirmedThePrice(unconfirmed)) return null;
  return { clause: unconfirmed.clause, on: unconfirmed.on };
}

export function termsNotVerifiedMetaSentence(input: VendorVerdictInput): string | null {
  const bySource = termsUnconfirmedBySource(input);
  if (bySource && !outcomeConfirmsThePrice(bySource)) return NOT_VERIFIED(unconfirmedTermsClause(bySource));
  const unconfirmed = whyWeCannotConfirmTheseTerms(input);
  if (!unconfirmed) return null;
  const because = unconfirmed.because;
  if (withheldForARefusedRead(because)) return NOT_VERIFIED(refusedReadWithholdingMetaClause(because));
  if (theReadConfirmedThePrice(unconfirmed)) return null;
  return because.reason === "link_unreachable" ? null : NOT_VERIFIED(unconfirmed.clause);
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
  | { states: "ended"; how: "retired"; tier: string | null }
  | { states: "ended"; how: "removed"; cause: RiskCause }
  | { states: "unconfirmed"; because: BadgeWithholding };

export function freeTierClaim(input: VendorVerdictInput): FreeTierClaim {
  const badge = vendorBadge(input);
  if (badge.kind === "ended") return { states: "ended", how: "retired", tier: input.tier ?? null };
  if (badge.kind === "none") return { states: "unconfirmed", because: badge.because };
  if (badge.word === "risky" && input.cause) return { states: "ended", how: "removed", cause: input.cause };
  return { states: "offered", level: badge.word };
}

export function statesRiskCause(input: VendorVerdictInput): boolean {
  const word = vendorVerdictWord(input);
  return word !== null && word !== "stable" && input.cause !== null;
}

export function demotionTheVerdictNames(input: VendorVerdictInput): RiskCause | null {
  if (input.offerEnded || withholdingDecides(input) || refusalWithholdsStability(input)) return null;
  const word = vendorVerdictWord(input);
  const stated = input.gate || word === null ? input.historyLevel : word;
  return stated !== "stable" && input.cause ? input.cause : null;
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

export const STORED_TERMS_NAMED_AS_PREVIOUS = "names our stored terms as the previous ones";

export function supersededTermsHoldTheDirection(recorded: number): string {
  return recorded === 1
    ? `The one change we have recorded ${STORED_TERMS_NAMED_AS_PREVIOUS}.`
    : `Of the ${recorded} changes we have recorded, at least one ${STORED_TERMS_NAMED_AS_PREVIOUS}.`;
}

export function narrowingSentence(
  changes: VendorVerdictInput["changes"],
  offer: GradedOffer | null = null,
  termsSuperseded: boolean = false,
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
    if (termsSuperseded) return supersededTermsHoldTheDirection(total);
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
    const unconfirmed = whyWeCannotConfirmTheseTerms(input);
    if (unconfirmed) return unconfirmedTermsSentence(unconfirmed);
    const clause = withheldLevelClause(input.levelWithheld, input.unconfirmableSince);
    return `${capitalise(clause)}, ${CANNOT_CONFIRM_THESE_TERMS} today.`;
  }
  const refused = refusalWithholdsStability(input);
  if (refused) {
    return refusedReadVerdictSentence(refusedReadWithholding(refused));
  }

  const level = publishedVendorLevel(input.level, input.cause);
  if (input.gate || level === null) return vendorHistorySentence(input.vendor, input.historyLevel, input.cause);

  if (level !== "stable" && input.cause) {
    const unconfirmed = input.levelWithheld
      ? ` ${capitalise(withheldLevelClause(input.levelWithheld, input.unconfirmableSince))}, ${CANNOT_CONFIRM_THESE_TERMS} today.`
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
  return `We rate it stable. ${narrowingSentence(input.changes, { vendor: input.vendor, tier: input.tier }, input.termsSuperseded)}`;
}
