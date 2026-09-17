import { tierRecordsAFreeTier, DENIES_A_FREE_TIER } from "./free-tier-record.js";
import { mentionsSomethingFree } from "./superseding-reading.js";
import { VERDICTS_ABOUT_THE_EDITION_ITSELF, comparableTerms } from "./change-tier.js";
import { restatedDescription } from "./restated-description.js";
import {
  readingBehindTheChange,
  supersedingChange,
  type QuotingChange,
  type SourcedReading,
} from "./superseded-description.js";

export interface RestatableOffer {
  vendor: string;
  description: string;
  tier?: string;
  url?: string;
  source_check?: { checked?: string } | null;
  restated_from?: Restatement | null;
}

export interface Restatement {
  reading_date: string;
  source_url: string;
  record_date: string;
  change_type: string;
  restated_on: string;
}

export const TIER_IS_NOT_ONE_WE_RECORD_AS_FREE = "tier_is_not_one_we_record_as_free";

export const READING_ANSWERS_FOR_SOMETHING_ELSE = "reading_answers_for_something_else";

export const READING_SAYS_WHAT_WE_ALREADY_STORE = "reading_says_what_we_already_store";

export const A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS = "a_record_no_newer_already_restated_this";

export const RESTATEMENT_REFUSALS: readonly string[] = [
  TIER_IS_NOT_ONE_WE_RECORD_AS_FREE,
  READING_ANSWERS_FOR_SOMETHING_ELSE,
  READING_SAYS_WHAT_WE_ALREADY_STORE,
  A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS,
];

export function readingSaysTheListedTierIsGone(change: QuotingChange, reading: string): boolean {
  if (VERDICTS_ABOUT_THE_EDITION_ITSELF.includes(change.change_type)) return true;
  return DENIES_A_FREE_TIER.test(reading);
}

export function readingAnswersForTheListedTier(
  change: QuotingChange,
  offer: Pick<RestatableOffer, "tier">,
  reading: string,
): boolean {
  if (!tierRecordsAFreeTier(offer.tier ?? "")) return false;
  return mentionsSomethingFree(reading) || readingSaysTheListedTierIsGone(change, reading);
}

export function aLaterRecordThanTheOneWeRestatedFrom(
  change: QuotingChange,
  restated: Restatement | null | undefined,
): boolean {
  if (!restated) return true;
  return change.date > restated.record_date;
}

export function restatementRefusal(
  offer: RestatableOffer,
  change: QuotingChange,
  reading: SourcedReading,
): string | null {
  if (!tierRecordsAFreeTier(offer.tier ?? "")) return TIER_IS_NOT_ONE_WE_RECORD_AS_FREE;
  if (!readingAnswersForTheListedTier(change, offer, reading.terms)) {
    return READING_ANSWERS_FOR_SOMETHING_ELSE;
  }
  if (
    comparableTerms(restatedDescription(offer.description, reading.terms)) ===
    comparableTerms(offer.description)
  ) {
    return READING_SAYS_WHAT_WE_ALREADY_STORE;
  }
  if (!aLaterRecordThanTheOneWeRestatedFrom(change, offer.restated_from)) {
    return A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS;
  }
  return null;
}

export interface RestatementRuling {
  offer: RestatableOffer;
  change: QuotingChange;
  reading: SourcedReading;
  refusal: string | null;
  restatement: Restatement | null;
  description: string;
}

export function ruleOnRestating(
  offer: RestatableOffer,
  change: QuotingChange,
  today: string,
): RestatementRuling | null {
  const reading = readingBehindTheChange(change);
  if (!reading) return null;
  const refusal = restatementRefusal(offer, change, reading);
  return {
    offer,
    change,
    reading,
    refusal,
    description: restatedDescription(offer.description, reading.terms),
    restatement: refusal
      ? null
      : {
          reading_date: reading.date,
          source_url: reading.url,
          record_date: change.date,
          change_type: change.change_type,
          restated_on: today,
        },
  };
}

export function restatementRulings<T extends RestatableOffer>(
  offers: readonly T[],
  changesFor: (offer: T) => readonly QuotingChange[],
  today: string,
): RestatementRuling[] {
  const rulings: RestatementRuling[] = [];
  for (const offer of offers) {
    const change = supersedingChange(offer, changesFor(offer));
    if (!change) continue;
    const ruling = ruleOnRestating(offer, change, today);
    if (ruling) rulings.push(ruling);
  }
  return rulings;
}

export function weHaveReadThePageSinceTheRecord(
  offer: Pick<RestatableOffer, "source_check">,
  reading: SourcedReading,
): boolean {
  const checked = offer.source_check?.checked ?? "";
  return checked !== "" && checked > reading.date;
}

export function restatementKeepsWhatTheProductIs(ruling: RestatementRuling): boolean {
  return !ruling.refusal && ruling.description !== ruling.reading.terms;
}

export interface WithheldTermsMeasure {
  offers_we_may_restate_from_their_reading: number;
  offers_we_refuse_to_restate: Record<string, number>;
  offers_re_read_since_the_record_and_still_withheld: number;
  restatements_keeping_the_stored_sentence_saying_what_the_product_is: number;
}

export function withheldTermsMeasure(rulings: readonly RestatementRuling[]): WithheldTermsMeasure {
  const refused: Record<string, number> = {};
  for (const reason of RESTATEMENT_REFUSALS) refused[reason] = 0;
  let mayRestate = 0;
  let reRead = 0;
  let keepingTheOpening = 0;
  for (const ruling of rulings) {
    if (ruling.refusal) refused[ruling.refusal] = (refused[ruling.refusal] ?? 0) + 1;
    else mayRestate++;
    if (restatementKeepsWhatTheProductIs(ruling)) keepingTheOpening++;
    if (weHaveReadThePageSinceTheRecord(ruling.offer, ruling.reading)) reRead++;
  }
  return {
    offers_we_may_restate_from_their_reading: mayRestate,
    offers_we_refuse_to_restate: refused,
    offers_re_read_since_the_record_and_still_withheld: reRead,
    restatements_keeping_the_stored_sentence_saying_what_the_product_is: keepingTheOpening,
  };
}
