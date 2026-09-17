import { tierRecordsAFreeTier, DENIES_A_FREE_TIER } from "./free-tier-record.js";
import { describesThePageRatherThanTheTerms, mentionsSomethingFree } from "./superseding-reading.js";
import { VERDICTS_ABOUT_THE_EDITION_ITSELF, comparableTerms } from "./change-tier.js";
import { restatedDescription, statesAFigure } from "./restated-description.js";
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

export const READING_DESCRIBES_THE_PAGE_NOT_THE_TERMS = "reading_describes_the_page_not_the_terms";

export const READING_STATES_NO_FIGURE_WHERE_OUR_TERMS_DO =
  "reading_states_no_figure_where_our_terms_do";

export const READING_DROPS_THE_CAP_ON_WHO_MAY_USE_IT = "reading_drops_the_cap_on_who_may_use_it";

export const READING_SAYS_WHAT_WE_ALREADY_STORE = "reading_says_what_we_already_store";

export const A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS = "a_record_no_newer_already_restated_this";

export const THIS_READING_IS_HELD_BACK_BY_NAME = "this_reading_is_held_back_by_name";

export const RESTATEMENT_REFUSALS: readonly string[] = [
  TIER_IS_NOT_ONE_WE_RECORD_AS_FREE,
  READING_ANSWERS_FOR_SOMETHING_ELSE,
  READING_DESCRIBES_THE_PAGE_NOT_THE_TERMS,
  READING_STATES_NO_FIGURE_WHERE_OUR_TERMS_DO,
  READING_DROPS_THE_CAP_ON_WHO_MAY_USE_IT,
  READING_SAYS_WHAT_WE_ALREADY_STORE,
  A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS,
  THIS_READING_IS_HELD_BACK_BY_NAME,
];

export interface AReadingHeldBackByName {
  vendor: string;
  reading_opens: string;
  we_go_on_storing: string;
  the_rule_that_should_reach_it: string;
}

export const READINGS_HELD_BACK_BY_NAME: readonly AReadingHeldBackByName[] = [
  {
    vendor: "ImgBB",
    reading_opens: "ImgBB is a free image hosting service. Upgrade to unlock all the features.",
    we_go_on_storing: "32 MB / image limit",
    the_rule_that_should_reach_it: "https://github.com/robhunter/agentdeals/issues/1424",
  },
  {
    vendor: "Prisma Accelerate",
    reading_opens: "Free tier includes 1M requests / month",
    we_go_on_storing: "100,000 operations/month",
    the_rule_that_should_reach_it: "https://github.com/robhunter/agentdeals/issues/1756",
  },
];

export function theHoldOnThisReading(
  offer: Pick<RestatableOffer, "vendor">,
  reading: string,
): AReadingHeldBackByName | null {
  const held = READINGS_HELD_BACK_BY_NAME.find(
    (hold) => hold.vendor.toLowerCase() === offer.vendor.toLowerCase(),
  );
  if (!held) return null;
  return reading.trimStart().startsWith(held.reading_opens) ? held : null;
}

const A_CAP_ON_WHO_MAY_USE_IT =
  /\b(?:single|one|1)\s+(?:[A-Za-z-]+\s+){0,2}?(?:users?|seats?|members?|collaborators?|editors?|developers?)\b|\bsingle[\s-](?:user|seat|player|tenant)\b/i;

const SOMEONE_WHO_USES_IT =
  /\b(?:users?|seats?|members?|collaborators?|editors?|developers?|people|individuals?|team)\b/i;

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

export function readingStatesNoFigureWhereOurTermsDo(description: string, reading: string): boolean {
  return statesAFigure(description) && !statesAFigure(reading);
}

export function readingDropsTheCapOnWhoMayUseIt(description: string, reading: string): boolean {
  return A_CAP_ON_WHO_MAY_USE_IT.test(description) && !SOMEONE_WHO_USES_IT.test(reading);
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
  if (describesThePageRatherThanTheTerms(reading.terms)) {
    return READING_DESCRIBES_THE_PAGE_NOT_THE_TERMS;
  }
  if (readingStatesNoFigureWhereOurTermsDo(offer.description, reading.terms)) {
    return READING_STATES_NO_FIGURE_WHERE_OUR_TERMS_DO;
  }
  if (readingDropsTheCapOnWhoMayUseIt(offer.description, reading.terms)) {
    return READING_DROPS_THE_CAP_ON_WHO_MAY_USE_IT;
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
  if (theHoldOnThisReading(offer, reading.terms)) {
    return THIS_READING_IS_HELD_BACK_BY_NAME;
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
