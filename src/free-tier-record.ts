import { classifyTier } from "./ranking.js";
import {
  A_PRICE_OF_NOTHING,
  namesAFreePlan,
  offeredOutrightAndNotDenied,
  sentencesOf,
} from "./superseding-reading.js";

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

const A_WORD_THAT_MODIFIES =
  "(?!(?:on|for|in|with|to|at|from|of|the|a|an|only|after|during|per|and|or|but)\\b)[A-Za-z][A-Za-z-]*";

const A_PLAN_WE_WOULD_PRICE = "(?:tiers?|plans?|editions?|versions?|accounts?|offerings?)";

export const DENIES_A_FREE_TIER = new RegExp(
  `\\bno\\s+(?:${A_WORD_THAT_MODIFIES}\\s+){0,3}free\\s+(?:${A_WORD_THAT_MODIFIES}\\s+){0,2}${A_PLAN_WE_WOULD_PRICE}\\b`
    + `|\\bfree\\s+${A_PLAN_WE_WOULD_PRICE}\\s+(?:is\\s+|are\\s+|was\\s+|has\\s+been\\s+)?`
    + `(?:unavailable|removed|gone|discontinued|retired|withdrawn)\\b`,
  "i",
);

export function sentenceOffersSomethingFree(sentence: string): boolean {
  return namesAFreePlan(sentence) || offeredOutrightAndNotDenied(sentence, A_PRICE_OF_NOTHING);
}

export function descriptionDeniesAFreeTier(description: string): boolean {
  const sentences = sentencesOf(description ?? "");
  const denying = new Set(sentences.filter(s => DENIES_A_FREE_TIER.test(s.text)).map(s => s.at));
  if (denying.size === 0) return false;
  return !sentences.some(s => !denying.has(s.at) && sentenceOffersSomethingFree(s.text));
}
