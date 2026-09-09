import { CLIPPED_TERMS_MARKER, openingOfTerms } from "./terms-opening.js";

export const A_FREE_PLAN =
  /\b(?:always\s+free|free\s+forever|forever\s+free)\b|\bfree[\s'"’-]{0,3}(?:plans?|tiers?|editions?|versions?|accounts?|keys?|api)\b|\b(?:plans?|tiers?|editions?|versions?|accounts?)\b[^.!?]{0,24}?\bis\s+free\b|\bfree\s+for(?:ever)?\b(?!\s+(?:\d|a\s+(?:limited|month|year)|the\s+first))|[$€£]\s?0(?:\.00)?\s*(?:\/\s*|per\s+)(?:mo|month|user|seat|year|yr)\b|\bfree\b\s*[:=]\s*[$€£]\s?0\b/i;

export const A_FREE_PRICE = /\bfree\b|[$€£]\s?0\b/i;

export const A_TRIAL_A_CREDIT_OR_A_DISCOUNT =
  /\btrials?\b|[$€£]\s?[\d,.]+\s*[km]?\s*(?:in\s+)?(?:free\s+)?credits?\b|\bcredits?\s+(?:of|worth|for\s+new)\b|\bfree\s+credits?\b|\bcoupons?\b|\bdiscounts?\b|\b\d+\s*%\s*off\b|\bvouchers?\b/i;

export const A_TRIAL = /\btrials?\b|\bfree\s+for\s+\d+\s+(?:days?|weeks?|months?)\b/i;

export const A_PLAN_PRICE = /[$€£]\s?[\d,]+(?:\.\d+)?|\b[\d,]+(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/i;

export const DENIES_A_FREE_PLAN =
  /\b(?:does\s+not|doesn['’]t|do\s+not|no\s+longer|not\s+available|only\s+available|is\s+not|are\s+not|remov(?:e|es|ed|ing|al)|sunset(?:s|ting|ted)?|shutting\s+down|shut\s+down|deprecat(?:e|ed|ing|ion)|discontinu(?:e|ed|ing)|retir(?:e|es|ed|ing|ement)|phas(?:e|es|ed|ing)\s+out|wind(?:s|ing)?\s+down|winding\s+down)\b/i;

const CLAUSE_BREAK = /[;:|]|,(?=\s)|\s+[-–—]\s+/g;

const SENTENCE_BREAK = /(?<=[.!?])\s+/;

const WORDS_EITHER_SIDE = 24;

function clauseAround(text: string, index: number): { at: number; text: string } {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    if (match.index < index) start = match.index + match[0].length;
    else {
      end = match.index;
      break;
    }
  }
  return { at: start, text: text.slice(start, end) };
}

function isQualifiedAway(text: string, index: number, length: number): boolean {
  const clause = clauseAround(text, index);
  const from = index - clause.at - WORDS_EITHER_SIDE;
  const to = index - clause.at + length + WORDS_EITHER_SIDE;
  for (const match of clause.text.matchAll(new RegExp(A_TRIAL_A_CREDIT_OR_A_DISCOUNT.source, "gi"))) {
    if (match.index < to && match.index + match[0].length > from) return true;
  }
  return false;
}

function whereItIsOfferedOutrightIn(text: string, pattern: RegExp): number {
  for (const match of text.matchAll(new RegExp(pattern.source, "gi"))) {
    if (!isQualifiedAway(text, match.index, match[0].length)) return match.index;
  }
  return -1;
}

export function offeredOutrightAndNotDenied(sentence: string, pattern: RegExp): boolean {
  const at = whereItIsOfferedOutrightIn(sentence, pattern);
  if (at < 0) return false;
  return !DENIES_A_FREE_PLAN.test(clauseAround(sentence, at).text);
}

export function namesAFreePlan(sentence: string): boolean {
  return offeredOutrightAndNotDenied(sentence, A_FREE_PLAN);
}

export function mentionsSomethingFree(text: string): boolean {
  return whereItIsOfferedOutrightIn(text, A_FREE_PRICE) >= 0;
}

export function sentencesOf(text: string): { at: number; text: string }[] {
  const found: { at: number; text: string }[] = [];
  let from = 0;
  for (const part of text.split(SENTENCE_BREAK)) {
    const at = text.indexOf(part, from);
    if (part.trim() !== "") found.push({ at, text: part });
    from = at + part.length;
  }
  return found;
}

export function whereAFreePlanIsNamed(reading: string): number {
  for (const sentence of sentencesOf(reading)) {
    if (namesAFreePlan(sentence.text)) return sentence.at;
  }
  return -1;
}

export function describesOnlyATrial(reading: string): boolean {
  if (!A_TRIAL.test(reading)) return false;
  if (A_PLAN_PRICE.test(reading)) return false;
  return whereAFreePlanIsNamed(reading) === -1;
}

export function openingOfAReading(reading: string, cap: number): string {
  const opening = openingOfTerms(reading, cap);
  if (mentionsSomethingFree(opening)) return opening;
  const at = whereAFreePlanIsNamed(reading);
  if (at <= 0) return opening;
  return `${CLIPPED_TERMS_MARKER}${openingOfTerms(reading.slice(at), cap - CLIPPED_TERMS_MARKER.length)}`;
}
