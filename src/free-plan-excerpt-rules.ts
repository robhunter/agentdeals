import type { Offer } from "./types.js";

export const EXCERPT_HOLDS_TEMPLATE_SYNTAX = "the copy holds template syntax the page never filled in";

export const EXCERPT_HOLDS_AN_UNDECODED_ENTITY = "the copy holds an HTML entity left after decoding";

export const EXCERPT_REPEATS_A_RUN_OF_ITS_WORDS = "the copy repeats a run of its own words";

export const EXCERPT_HOLDS_A_DATE_BESIDE_THE_TERMS = "the copy holds a date no word ties to the terms, as a table's date column beside the allowance";

export const EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE = "the copy names no allowance, limit or price for the plan";

export const LONGEST_RUN_AN_EXCERPT_MAY_REPEAT = 7;

export type QuotedPlan = Pick<Offer, "vendor" | "tier" | "eligibility">;

const TEMPLATE_SYNTAX = /\{\{|\}\}|\$\{|\{%|%\}/;

const AN_HTML_ENTITY = /&(?:[a-z][a-z0-9]*|#[0-9]+|#x[0-9a-f]+);/i;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function saidTwice(words: string[]): boolean {
  if (words.length < 2 || words.length % 2 !== 0) return false;
  const half = words.length / 2;
  return words.slice(0, half).join(" ") === words.slice(half).join(" ");
}

export function repeatsARunOfItsOwnWords(text: string): boolean {
  const words = wordsOf(text);
  if (saidTwice(words)) return true;
  const run = LONGEST_RUN_AN_EXCERPT_MAY_REPEAT + 1;
  const firstAt = new Map<string, number>();
  for (let at = 0; at + run <= words.length; at++) {
    const stretch = words.slice(at, at + run).join(" ");
    const first = firstAt.get(stretch);
    if (first === undefined) firstAt.set(stretch, at);
    else if (at - first >= run) return true;
  }
  return false;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
const YEAR = "(?:19|20)\\d{2}";

const A_CALENDAR_DATE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${MONTH}\\s+${DAY},?\\s+${YEAR}|${DAY}\\s+${MONTH},?\\s+${YEAR}|${MONTH},?\\s+${YEAR}|${YEAR}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/${YEAR})(?![\\p{L}\\p{N}])`,
  "giu",
);

const WORDS_THAT_TIE_A_DATE_TO_THE_TERMS = new Set([
  "from", "since", "until", "till", "through", "thru", "to", "by", "before", "after", "on", "in", "during", "of",
  "starting", "effective", "ends", "ending", "expires", "expiring", "begins", "beginning", "between", "and",
]);

export function holdsADateBesideTheTerms(text: string): boolean {
  for (const date of text.matchAll(A_CALENDAR_DATE)) {
    const wordsBefore = wordsOf(text.slice(0, date.index));
    if (!WORDS_THAT_TIE_A_DATE_TO_THE_TERMS.has(wordsBefore[wordsBefore.length - 1] ?? "")) return true;
  }
  return false;
}

const A_FIGURE = /(?:^|[^\p{L}\p{N}])\d/u;

const A_COUNT_OF_THE_SITES_OWN_USE = /\d[\d,.]*[kmb]?\+(?!\d)/giu;

const WORDS_THAT_NAME_A_LIMIT = new Set([
  "unlimited", "limited", "limit", "limits", "commercial", "noncommercial",
  "hour", "hours", "minute", "minutes", "day", "days", "daily", "week", "weeks", "weekly",
  "month", "months", "monthly", "year", "years", "yearly", "annual", "annually",
]);

const WORDS_THAT_NAME_WHO_MAY_APPLY = new Set([
  "student", "students", "education", "educational", "academic", "nonprofit", "nonprofits",
  "startup", "startups", "eligible", "eligibility",
]);

function withoutTheNamesOf(text: string, plan: QuotedPlan): string {
  return [plan.vendor, plan.tier]
    .map((name) => String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .reduce((rest, name) => rest.split(name).join(" "), text.toLowerCase().replace(/\s+/g, " "));
}

export function namesAnAllowanceALimitOrAPrice(text: string, plan: QuotedPlan): boolean {
  const rest = withoutTheNamesOf(text, plan).replace(A_COUNT_OF_THE_SITES_OWN_USE, " ");
  if (A_FIGURE.test(rest)) return true;
  const aProgramme = Boolean(plan.eligibility);
  return wordsOf(rest).some((word) => WORDS_THAT_NAME_A_LIMIT.has(word) || (aProgramme && WORDS_THAT_NAME_WHO_MAY_APPLY.has(word)));
}

export function whyTheExcerptCannotStand(text: string, plan: QuotedPlan): string | null {
  if (TEMPLATE_SYNTAX.test(text)) return EXCERPT_HOLDS_TEMPLATE_SYNTAX;
  if (AN_HTML_ENTITY.test(text)) return EXCERPT_HOLDS_AN_UNDECODED_ENTITY;
  if (repeatsARunOfItsOwnWords(text)) return EXCERPT_REPEATS_A_RUN_OF_ITS_WORDS;
  if (holdsADateBesideTheTerms(text)) return EXCERPT_HOLDS_A_DATE_BESIDE_THE_TERMS;
  if (!namesAnAllowanceALimitOrAPrice(text, plan)) return EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE;
  return null;
}
