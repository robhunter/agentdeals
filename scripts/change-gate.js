import { pageNamesVendor } from "./vendor-naming.js";
import { definedEquivalences } from "./unit-aliases.js";
import { readPeriod, renderPeriod } from "../src/growth-limits.ts";

export const REJECT_NULL_COMPARISON = "null_comparison";
export const REJECT_STATES_NO_DIFFERENCE = "states_no_difference";
export const REJECT_NO_PRICE_SIGNAL = "no_price_signal";
export const REJECT_PAGE_NOT_ABOUT_VENDOR = "page_does_not_name_vendor";
export const REJECT_UNQUANTIFIED_LIMIT = "unquantified_limit";
export const REJECT_CONFIRMED_UNCHANGED = "confirmed_unchanged";
export const REJECT_STATES_NO_TERMS = "states_no_terms";
export const REJECT_NO_REMOVAL_EVIDENCE = "no_removal_evidence";
export const REJECT_REMOVAL_READ_FROM_ROOT = "removal_read_from_root";
export const REJECT_FREE_TIER_STILL_OFFERED = "free_tier_still_offered";
export const REJECT_NO_BASELINE = "no_baseline";
export const REJECT_DANGLING_REFERENCE = "dangling_reference";
export const REJECT_MEASURES_NO_CHANGE = "measures_no_change";
export const REJECT_MEASURES_THE_OPPOSITE = "measures_the_opposite";
export const REJECT_STATES_NO_NARROWING = "states_no_narrowing";
export const REJECT_NO_TERMS_TO_NARROW = "no_terms_to_narrow";

export const GATE_REASONS = [
  REJECT_NULL_COMPARISON,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_PAGE_NOT_ABOUT_VENDOR,
  REJECT_UNQUANTIFIED_LIMIT,
  REJECT_CONFIRMED_UNCHANGED,
  REJECT_STATES_NO_TERMS,
  REJECT_NO_REMOVAL_EVIDENCE,
  REJECT_REMOVAL_READ_FROM_ROOT,
  REJECT_FREE_TIER_STILL_OFFERED,
  REJECT_NO_BASELINE,
  REJECT_DANGLING_REFERENCE,
  REJECT_MEASURES_NO_CHANGE,
  REJECT_MEASURES_THE_OPPOSITE,
  REJECT_STATES_NO_NARROWING,
  REJECT_NO_TERMS_TO_NARROW,
];

export const FREE_TIER_REMOVED = "free_tier_removed";
export const RESTRICTION = "restriction";

const QUANTITY_CHANGE_TYPES = ["limits_reduced", "limits_increased"];

export const RECLASSIFIED_AS_RESTRUCTURE = "pricing_restructured";
export const RECLASSIFIED_AS_CORRECTION = "record_corrected";
export const HAND_WRITTEN = "hand_written";

export const MIN_PRICE_SIGNALS = 1;

const COMPARISON_CONNECTIVES = [
  "instead of",
  "down from",
  "up from",
  "reduced from",
  "increased from",
  "rather than",
  "previously",
];

const AGREEMENT_PHRASES = [
  "matches the stored",
  "matches what we",
  "matches our stored",
  "aligns with the stored",
  "same as the stored",
  "identical to the stored",
  "consistent with the stored",
  "unchanged from the stored",
  "agrees with the stored",
  "confirms the stored",
  "no change from the stored",
  "no changes from the stored",
];

const OPERAND_WINDOW = 30;
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

const CURRENCY_AMOUNT = /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP)\b)/gi;
const NAMED_TIER =
  /\b(?:(?:free|hobby|starter|basic|pro|team|business|enterprise|premium|growth|standard|community|developer)\s+(?:plans?|tiers?|package)|free\s+(?:api|forever|version)|starts?\s+at)\b/gi;
const METERED_RATE =
  /\b\d[\d,]*(?:\.\d+)?\s?[A-Za-z][\w-]*(?:\s+[\w-]+){0,3}\s*(?:\/\s*|\bper\s+|\ba\s+)(?:mo|month|monthly|yr|year|day|hour|hr|min|minute|sec|second|user|seat|request|call|query)\b/gi;
const PERIODIC_ALLOWANCE =
  /\b\d[\d,]*(?:\.\d+)?\s+(?:daily|monthly|weekly|hourly|yearly|annual)\s+[a-z]/gi;

const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT, NAMED_TIER, METERED_RATE, PERIODIC_ALLOWANCE];

const ATTRIBUTE_WINDOW = 60;
const ATTRIBUTE_WORDS = 6;
const ATTRIBUTE_STOPWORDS = new Set([
  "up", "to", "a", "an", "the", "of", "per", "and", "or", "for", "in", "on", "at", "with", "from",
  "free", "plan", "plans", "tier", "tiers", "month", "monthly", "year", "yearly", "day", "daily",
  "hour", "minute", "min", "second", "sec", "mo", "yr", "total", "maximum", "max", "included",
  "includes", "include",
  "concurrent", "unlimited", "new", "additional", "more", "than", "only", "each", "all", "other",
  "its", "their", "this", "that", "which", "are", "is", "be", "was", "has", "have", "had",
  "limit", "limits",
]);

export const BYTE_UNITS = new Map([
  ["kb", 1e3],
  ["mb", 1e6],
  ["gb", 1e9],
  ["tb", 1e12],
  ["pb", 1e15],
  ["kib", 1024],
  ["mib", 1024 ** 2],
  ["gib", 1024 ** 3],
  ["tib", 1024 ** 4],
  ["pib", 1024 ** 5],
]);

const UNIT_AFTER_NUMBER = /^\s?(kib|mib|gib|tib|pib|kb|mb|gb|tb|pb)\b/i;

export const MAGNITUDE_UNITS = new Map([
  ["k", 1e3],
  ["m", 1e6],
  ["bn", 1e9],
  ["b", 1e9],
  ["thousand", 1e3],
  ["million", 1e6],
  ["billion", 1e9],
  ["trillion", 1e12],
]);

const MAGNITUDE_AFTER_NUMBER = /^(?:(bn|k|m|b)|\s(thousand|million|billion|trillion))\b/i;

const DURATION_AFTER_NUMBER =
  /^[\s-]?(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|weeks?|wks?|months?|years?|yrs?)\b/i;

const PERIOD_SECONDS = new Map([
  ["sec", 1],
  ["min", 60],
  ["hour", 3600],
  ["day", 86400],
  ["week", 604800],
  ["mo", 2592000],
  ["yr", 31536000],
]);

const PERIOD_SCAN_WORDS = 4;
const PERIOD_SCAN_ENDS = /[,;()]/;
const A_WORD = /[A-Za-z][\w-]*/g;
const A_FIGURE = /\d/;
const CLAUSE_ENDS = /[,;.()✓•|]/;
const A_SCOPE = /\sper\s/i;

function periodAfter(window) {
  const ends = window.search(PERIOD_SCAN_ENDS);
  const scan = ends === -1 ? window : window.slice(0, ends);
  const offsets = [0];
  const words = new RegExp(A_WORD.source, "g");
  for (let word = words.exec(scan); word && offsets.length <= PERIOD_SCAN_WORDS; word = words.exec(scan)) {
    offsets.push(word.index + word[0].length);
  }
  for (const at of offsets) {
    if (A_FIGURE.test(scan.slice(0, at))) break;
    const rest = scan.slice(at);
    const period = readPeriod(rest) ?? readPeriod(rest.replace(/^\s+/, ""));
    if (period) return { period, at, ends: at + period.length };
  }
  return null;
}

export function periodSeconds(period) {
  const seconds = PERIOD_SECONDS.get(period?.unit ?? "");
  if (seconds === undefined) return null;
  const count = Number(String(period.count ?? "1").replace(/,/g, ""));
  return Number.isFinite(count) && count > 0 ? count * seconds : seconds;
}

function spanOf(word) {
  return word ? (PERIOD_SECONDS.get(readPeriod(`/${word}`)?.unit ?? "") ?? null) : null;
}

export function priceSignals(text) {
  if (typeof text !== "string") return [];
  const found = [];
  for (const pattern of PRICE_SIGNAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.push(match[0].trim());
  }
  return found;
}

export function quantities(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(NUMBER)].map((m) => Number(m[0].replace(/,/g, "")));
}

function singular(word) {
  return word.replace(/ies$/, "y").replace(/(?:es|s)$/, "");
}

export const PRICE_ATTRIBUTE = "currency";

function wordsIn(trailing) {
  const words = [];
  for (const word of trailing.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean).slice(0, ATTRIBUTE_WORDS)) {
    const stem = singular(word);
    if (ATTRIBUTE_STOPWORDS.has(word) || ATTRIBUTE_STOPWORDS.has(stem)) continue;
    if (A_FIGURE.test(stem.charAt(0))) continue;
    if (stem.length <= 2 && !BYTE_UNITS.has(stem)) continue;
    words.push(stem);
  }
  return words;
}

export function readQuantities(text) {
  if (typeof text !== "string") return [];
  const read = [];
  let readThrough = 0;
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index + match[0].length;
    const trailing = text.slice(start, start + ATTRIBUTE_WINDOW);
    const rate = periodAfter(trailing);
    const beside = trailing.slice(rate?.at === 0 ? rate.ends : 0);
    const stops = [
      rate?.at > 0 ? rate.at : -1,
      beside.search(A_FIGURE),
      beside.search(CLAUSE_ENDS),
      beside.search(A_SCOPE),
    ];
    const describes = Math.min(...stops.filter((at) => at !== -1), beside.length);
    const words = [];
    if (/[$€£¥₹]\s?$/.test(text.slice(0, match.index))) words.push(PRICE_ATTRIBUTE);
    const named = wordsIn(beside.slice(0, describes));
    words.push(...(named.length > 0 || rate ? named : wordsIn(trailing)));
    const unitMatch = trailing.match(UNIT_AFTER_NUMBER);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : null;
    const magnitudeMatch = unit === null ? trailing.match(MAGNITUDE_AFTER_NUMBER) : null;
    const magnitude = magnitudeMatch ? (magnitudeMatch[1] ?? magnitudeMatch[2]).toLowerCase() : "";
    const durationMatch = unit === null && magnitude === "" ? trailing.match(DURATION_AFTER_NUMBER) : null;
    const scale =
      BYTE_UNITS.get(unit ?? "") ??
      MAGNITUDE_UNITS.get(magnitude) ??
      spanOf(durationMatch ? durationMatch[1] : null) ??
      1;
    const period = rate?.period ?? null;
    read.push({ value: match[0], words, unit, scale, period, spellsAPeriod: match.index < readThrough });
    if (rate) readThrough = start + rate.ends;
  }
  return read;
}

export function quantifiedAttributes(text) {
  return readQuantities(text).filter(({ words, spellsAPeriod }) => words.length > 0 && !spellsAPeriod);
}

function isAMeasureWord(word) {
  return !BYTE_UNITS.has(word) && !MAGNITUDE_UNITS.has(word) && !A_FIGURE.test(word.charAt(0));
}

export function measuredWord(attribute) {
  return (attribute?.words ?? []).find(isAMeasureWord) ?? null;
}

export function measuredValue(attribute) {
  const value = Number(String(attribute?.value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return value * (attribute?.scale ?? 1);
}

const NO_ALIASES = new Map();

export function unitAliases(pageText) {
  const index = new Map();
  const link = (from, to) => {
    if (!from || !to || from === to) return;
    if (!index.has(from)) index.set(from, new Set());
    index.get(from).add(to);
  };
  for (const { left, right } of definedEquivalences(pageText)) {
    const leftWords = wordsIn(left);
    const rightWords = wordsIn(right);
    for (const a of leftWords) {
      for (const b of rightWords) {
        link(a, b);
        link(b, a);
      }
    }
  }
  return index;
}

function namesTheSameUnit(word, words, aliases) {
  if (words.includes(word)) return true;
  const equivalents = aliases.get(word);
  return equivalents ? words.some((other) => equivalents.has(other)) : false;
}

export function measuresTheSameThing(before, after, aliases = NO_ALIASES) {
  const priced = (attribute) => (attribute?.words ?? []).includes(PRICE_ATTRIBUTE);
  if (priced(before) !== priced(after)) return false;
  const left = measuredWord(before);
  const right = measuredWord(after);
  if (!left || !right) return false;
  return namesTheSameUnit(left, after.words, aliases) || namesTheSameUnit(right, before.words, aliases);
}

function sameAmount(from, to) {
  return Math.abs(from - to) <= 1e-9 * Math.max(Math.abs(from), Math.abs(to), 1);
}

export function comparedQuantity(before, after, aliases = NO_ALIASES) {
  if (!measuresTheSameThing(before, after, aliases)) return null;
  const aliased = !measuresTheSameThing(before, after, NO_ALIASES);
  let from = measuredValue(before);
  let to = measuredValue(after);
  if (from === null || to === null) return null;
  const over = periodSeconds(before?.period);
  const under = periodSeconds(after?.period);
  if (over !== null && under !== null) {
    from /= over;
    to /= under;
  }
  return {
    attribute: measuredWord(before),
    previous: renderedQuantity(before),
    current: renderedQuantity(after),
    aliased,
    priced: (before.words ?? []).includes(PRICE_ATTRIBUTE),
    before,
    after,
    from,
    to,
    direction: sameAmount(from, to) ? "equal" : to > from ? "increase" : "decrease",
  };
}

function renderedQuantity(attribute) {
  const unit = attribute?.unit ? ` ${attribute.unit.toUpperCase()}` : "";
  const period = attribute?.period ? renderPeriod(attribute.period) : "";
  return `${attribute?.value}${unit} ${measuredWord(attribute) ?? ""}${period}`.replace(/\s+/g, " ").trim();
}

function measuresAnAmount(attribute) {
  return !(attribute?.words ?? []).includes(PRICE_ATTRIBUTE);
}

export function quantityComparison(entry, aliases = NO_ALIASES) {
  const previous = quantifiedAttributes(entry?.previous_state).filter(measuresAnAmount);
  const current = quantifiedAttributes(entry?.current_state).filter(measuresAnAmount);
  const compared = [];
  const matched = new Set();
  for (const before of previous) {
    for (const after of current) {
      const quantity = comparedQuantity(before, after, aliases);
      if (!quantity) continue;
      compared.push(quantity);
      matched.add(before).add(after);
    }
  }
  const unmatched = [...previous, ...current].filter((attribute) => !matched.has(attribute));
  return { compared, unmatched };
}

export function comparedQuantities(entry) {
  return quantityComparison(entry).compared;
}

export function measuredDifferences(entry) {
  return comparedQuantities(entry).filter(({ direction }) => direction !== "equal");
}

export function storedDimensionsAbsentFromPage(entry, pageText) {
  if (typeof pageText !== "string") return [];
  const lower = pageText.toLowerCase();
  const carriesAnAmount = new RegExp(CURRENCY_AMOUNT.source, "i").test(pageText);
  const absent = [];
  for (const attribute of quantifiedAttributes(entry?.previous_state)) {
    const word = measuredWord(attribute);
    if (!word) continue;
    const present = word === PRICE_ATTRIBUTE ? carriesAnAmount : lower.includes(word);
    if (!present) absent.push({ value: attribute.value, measured: word });
  }
  return absent;
}

export function unquantifiedInCurrentState(entry) {
  const previous = quantifiedAttributes(entry?.previous_state);
  if (previous.length === 0) return null;
  const current = quantifiedAttributes(entry?.current_state);
  const currentWords = new Set(current.flatMap((a) => a.words));
  if (previous.some((a) => a.words.some((word) => currentWords.has(word)))) return null;
  return { previous, current };
}

function multisetEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortNum = (xs) => [...xs].sort((x, y) => x - y);
  const left = sortNum(a);
  const right = sortNum(b);
  return left.every((v, i) => v === right[i]);
}

function containsAll(haystack, needles) {
  const pool = [...haystack];
  for (const n of needles) {
    const at = pool.indexOf(n);
    if (at === -1) return false;
    pool.splice(at, 1);
  }
  return true;
}

export function nullComparisons(summary) {
  if (typeof summary !== "string") return [];
  const lower = summary.toLowerCase();
  const found = [];
  for (const connective of COMPARISON_CONNECTIVES) {
    let at = lower.indexOf(connective);
    while (at !== -1) {
      const before = summary.slice(Math.max(0, at - OPERAND_WINDOW), at);
      const after = summary.slice(at + connective.length, at + connective.length + OPERAND_WINDOW);
      const left = quantities(before).pop();
      const right = quantities(after).shift();
      if (left !== undefined && right !== undefined && left === right) {
        found.push({ connective, value: left });
      }
      at = lower.indexOf(connective, at + connective.length);
    }
  }
  return found;
}

export function assertsAgreement(summary) {
  if (typeof summary !== "string") return false;
  const lower = summary.toLowerCase();
  if (AGREEMENT_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return AGREEMENT_CLAUSES.some((pattern) => pattern.test(summary));
}

const AGREEMENT_CLAUSES = [
  /\bmatch(?:es|ing)?\s+(?:the|our|what)\b/i,
  /\baligns?\s+with\b/i,
  /\bconsistent\s+with\b/i,
  /\bidentical\s+to\b/i,
  /\bremains?\s+(?:the\s+same|unchanged|in\s+place)\b/i,
  /\b(?:is|are|was|were)\s+unchanged\b/i,
  /\bha(?:s|ve)\s?n[o']?t\s+changed\b/i,
  /\bno\s+(?:actual\s+|material\s+|real\s+)?changes?\s+(?:to|in|was|were|has|have|is|are)\b/i,
  /\b(?:tier|plan|program|offering)\s+still\s+(?:exists?|applies|stands)\b/i,
  /\bstill\s+(?:offers?|provides?|includes?|allows?)\b/i,
];

const CLAUSE_BREAK = "\u0000";
const CONTINUES_A_SENTENCE = "\u0001";
const TRAILING_CONNECTIVE =
  /^(?:but|while|whereas|which|although|though|however|yet|and|with)\b[,\s]*/i;

export function summaryClauses(summary) {
  if (typeof summary !== "string") return [];
  return summary
    .replace(/([.!?])\s+(?=["'“(]?[A-Z0-9])/g, `$1${CLAUSE_BREAK}`)
    .replace(
      /[,;]\s+(?=(?:but|while|whereas|which|although|though|however|yet)\b)/gi,
      CLAUSE_BREAK + CONTINUES_A_SENTENCE
    )
    .replace(
      /[,;]?\s+(?=(?:compared\s+to|versus|vs\.?|as\s+opposed\s+to|instead\s+of|rather\s+than)\s+(?:the\s+|our\s+|what\s+)?(?:stored|previously|prior|original|old|we)\b)/gi,
      CLAUSE_BREAK + CONTINUES_A_SENTENCE
    )
    .replace(/;\s+/g, CLAUSE_BREAK + CONTINUES_A_SENTENCE)
    .replace(/\s+[—–]\s+|\s+--\s+/g, CLAUSE_BREAK + CONTINUES_A_SENTENCE)
    .split(CLAUSE_BREAK)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

const ABSENCE_FRAMES = [
  /\bdoes\s?n[o']?t\s+(?:explicitly\s+|specifically\s+|clearly\s+|directly\s+)?(?:mention|specify|state|detail|list|describe|indicate|provide|show|give)/i,
  /\b(?:is|are|was|were)\s+not\s+(?:explicitly\s+|specifically\s+|clearly\s+)?(?:mentioned|specified|stated|listed|detailed|described|indicated|shown|provided|given)\b/i,
  /\bno\s+longer\s+(?:explicitly\s+|specifically\s+|clearly\s+)?(?:mentioned|stated|specified|detailed|described|shown|indicated)\b/i,
  /\bno\s+(?:specific|explicit|detailed)\s+(?:limits?|figures?|numbers?|details?|information|mention|pricing)\b/i,
  /\bno\s+(?:mention|details?|information|specifics|breakdown)\s+(?:of|about|on|regarding|for)\b/i,
  /\bnot\s+specified\b/i,
  /\bunspecified\b/i,
  /\bwithout\s+(?:detailing|specifying|mentioning|stating|listing|providing)\b/i,
  /\bfails?\s+to\s+(?:mention|state|specify|detail|list)\b/i,
  /\black(?:s|ing)?\s+(?:any\s+|specific\s+)?(?:detail|mention|information|specifics)\b/i,
];

const OUR_RECORD_FRAMES = [
  /\b(?:the\s+)?stored\s+(?:info|information|deal|description|record|data|state|figures?|values?|limits?|entry|text)/i,
  /\bwe\s+(?:stored|store|recorded|previously|had|listed)\b/i,
  /\bour\s+(?:record|records|stored|previous|listing|data|description)\b/i,
  /\bthe\s+(?:previous|original|old|prior)\s+(?:record|description|information|entry|listing|state|figures?|limits?|free\s+tier|terms|deal)\b/i,
  /\bdiffer(?:s|ent)\s+from\s+the\s+(?:original|previous|stored|old|prior)\b/i,
];

const PLAIN_PAST_FRAMES = [
  /\bpreviously\s+(?:stated|mentioned|listed|recorded|noted|described|specified|offered|included|allowed|had|was|were)\b/i,
  /\b(?:was|were|is|are|had|stated)\s+previously\b/i,
];

const BOOKKEEPING_FRAMES = [...OUR_RECORD_FRAMES, ...PLAIN_PAST_FRAMES];

export function namesOurRecord(clause) {
  const text = clauseText(clause);
  return typeof text === "string" && OUR_RECORD_FRAMES.some((pattern) => pattern.test(text));
}

const REPORTING_VERB =
  "(?:stated|states|state|said|says|listed|lists|specified|specifies|mentioned|mentions|showed|shows|described|describes|noted|notes|indicated|indicates|had|has|offered|offers|included|includes|allowed|allows|gave|gives)";

const OUR_RECORD_NOUN =
  "(?:(?:original\\s+)?stored\\s+(?:info|information|deal|description|record|data|entry|text)|(?:previous|original|old|prior)\\s+(?:record|description|information|entry|listing|deal|terms|limits?|state|figures?|values?))";

const STORED_REFERENCE_REWRITES = [
  [/\bcompared\s+(?:to|with)\s+(?=the\s+(?:stored|previous|original|old|prior)\b)/gi, ""],
  [new RegExp(`\\bthe\\s+${OUR_RECORD_NOUN}(?:\\s+(?:${REPORTING_VERB}|were|was))?\\b(?:\\s+(?:of|for|that))?`, "gi"), "previously"],
  [new RegExp(`\\bwe\\s+(?:previously\\s+)?(?:stored|store|recorded|had|listed)\\b(?:\\s+that)?`, "gi"), "previously"],
  [new RegExp(`\\bour\\s+(?:stored\\s+)?(?:record|records|listing|data|description)\\s+${REPORTING_VERB}\\b(?:\\s+that)?`, "gi"), "previously"],
  [/\bthe\s+previously\s+stated\b/gi, ""],
];

const LEADING_PUNCTUATION = /^[\s,;:]+/;
const DOUBLED_CONNECTIVE = new RegExp(
  `\\bpreviously,?\\s+(?:also\\s+|only\\s+|explicitly\\s+)?(?:${REPORTING_VERB}|were|was)\\b(?:\\s+(?:as|that|of|for))?`,
  "i"
);
const OPENS_ON_A_COMPARISON = /^(?:instead\s+of|rather\s+than|compared\s+(?:to|with)|versus|vs\.?)\s+/i;
const WHOLLY_PARENTHESISED = /^\(([^()]*)\)\.?$/;

const A_NEW_PREDICATE_AFTER_THE_FIGURE =
  /(?:\s+(?:which|whilst|while|whereas|but|although|though|however)\b|\s+(?:is|are|was|were)\s+(?:no\s+longer|not|now)\b|\s+and\s+(?:is|are|was|were|did|does|do)\b|\s+(?:compared\s+(?:to|with)|according\s+to)\b|\s+on\s+the\s+(?:current|new|live|updated)\b)/i;

export function trimmedToItsFigures(text) {
  const numbers = [...text.matchAll(NUMBER)];
  if (numbers.length === 0) return text;
  const last = numbers[numbers.length - 1];
  const tailFrom = last.index + last[0].length;
  const breaks = text.slice(tailFrom).search(A_NEW_PREDICATE_AFTER_THE_FIGURE);
  if (breaks === -1) return text;
  return `${text.slice(0, tailFrom + breaks).replace(/[\s,;:]+$/, "")}.`;
}

export function withoutStoredReference(clause) {
  if (typeof clause !== "string") return "";
  let text = clauseText(clause);
  for (const [pattern, replacement] of STORED_REFERENCE_REWRITES) text = text.replace(pattern, replacement);
  return text
    .replace(DOUBLED_CONNECTIVE, "previously")
    .replace(/\s{2,}/g, " ")
    .replace(LEADING_PUNCTUATION, "")
    .replace(/\s+([,.;:])/g, "$1")
    .trim()
    .replace(OPENS_ON_A_COMPARISON, "previously ")
    .replace(/^previously\s+\(([^()]*)\)/i, "previously $1")
    .replace(WHOLLY_PARENTHESISED, "$1");
}

const HEDGE_FRAMES = [
  /\bwhich\s+equates?\s+to\b/i,
  /\bappears?\s+to\b/i,
  /\bseems?\s+to\b/i,
  /\bsuggest(?:s|ing)\b/i,
  /\bimpl(?:y|ies|ying)\b/i,
  /\bpresumabl(?:y|e)\b/i,
  /\bpossibly\b/i,
  /\bmay\s+(?:not\s+)?(?:apply|be|have|mean|indicate)\b/i,
  /\bmight\s+(?:not\s+)?(?:apply|be|have|mean|indicate)\b/i,
  /\bpotential(?:ly)?\s+(?:need|change|reduction|increase)\b/i,
];

const PAGE_SUBJECT = /\b(?:the\s+)?(?:current\s+|new\s+|updated\s+|live\s+)?(?:pricing|landing|product|home|main|vendor'?s?|linked|cited|source)?\s*(?:page|site|website|homepage|url)\b/i;
const READING_VERB =
  /\b(?:mentions?|highlights?|promotes?|focuses|emphasi[sz]es?|details?|lists?|states?|shows?|says?|describes?|specifies|notes?|refers?|advertises?|displays?|indicates?|encourages?)\b/i;

const PRONOUN_SUBJECT = /^\s*(?:but|while|whereas|which|although|though|however|yet|and)?\s*(?:it|they)\b/i;
const PAGE_HOLDS = /\b(?:includes?|contains?|carries|only\s+has|has\s+no)\b/i;

export function narratesTheReading(clause) {
  if (typeof clause !== "string") return false;
  const verbAt = clause.search(READING_VERB);
  if (verbAt === -1) return PAGE_SUBJECT.test(clause) && PAGE_HOLDS.test(clause);
  const subject = clause.slice(0, verbAt);
  return PAGE_SUBJECT.test(subject) || PRONOUN_SUBJECT.test(subject);
}

export const CLAUSE_TERMS = "terms";
export const CLAUSE_ABSENCE = "absence";
export const CLAUSE_BOOKKEEPING = "bookkeeping";
export const CLAUSE_HEDGE = "hedge";
export const CLAUSE_NARRATION = "narration";

export function clauseText(clause) {
  return typeof clause === "string" ? clause.replace(CONTINUES_A_SENTENCE, "") : clause;
}

export function classifyClause(raw) {
  const clause = clauseText(raw);
  if (ABSENCE_FRAMES.some((pattern) => pattern.test(clause))) return CLAUSE_ABSENCE;
  if (BOOKKEEPING_FRAMES.some((pattern) => pattern.test(clause))) return CLAUSE_BOOKKEEPING;
  if (HEDGE_FRAMES.some((pattern) => pattern.test(clause))) return CLAUSE_HEDGE;
  if (narratesTheReading(clause) && !statesTerms(clause)) return CLAUSE_NARRATION;
  return CLAUSE_TERMS;
}

export function statesTerms(clause) {
  return priceSignals(clause).length > 0 || quantifiedAttributes(clause).length > 0;
}

const DIFFERENCE_MARKER =
  /\b(?:now|no\s+longer|instead\s+of|rather\s+than|down\s+from|up\s+from|increased|decreased|reduced|raised|lowered|dropped|removed|added|replaced|introduced|discontinued|eliminated|ended|rose|fell|shrank|grew|expanded|narrowed|changed|moved|new(?:ly)?\s+|from\s+\d)/i;

export function statesADifference(clause) {
  return typeof clause === "string" && DIFFERENCE_MARKER.test(clause);
}

export const CLAUSE_RESTATEMENT = "restatement";

function sameQuantities(a, b) {
  const left = quantities(a);
  const right = quantities(b);
  return left.length > 0 && multisetEqual(left, right);
}

export function summaryEvidence(summary) {
  const clauses = summaryClauses(summary);
  const kinds = clauses.map(classifyClause);
  for (let i = 1; i < clauses.length; i++) {
    if (kinds[i] !== CLAUSE_TERMS && kinds[i] !== CLAUSE_NARRATION) continue;
    if (kinds[i - 1] === CLAUSE_TERMS || kinds[i - 1] === CLAUSE_RESTATEMENT) continue;
    if (sameQuantities(clauses[i - 1], clauses[i])) kinds[i] = CLAUSE_RESTATEMENT;
  }
  const kept = [];
  const dropped = [];
  clauses.forEach((clause, i) => {
    if (kinds[i] === CLAUSE_TERMS) kept.push(clause);
    else dropped.push({ clause: clauseText(clause), kind: kinds[i] });
  });
  return { clauses, kinds, kept, dropped, changed: kept.filter(statesADifference) };
}

const BASELINE_CONNECTIVE =
  /\b(?:previously|formerly|used\s+to|up\s+from|down\s+from|increase\s+from|increased\s+from|decrease\s+from|decreased\s+from|reduced\s+from|raised\s+from|lowered\s+from|instead\s+of|rather\s+than)\b/i;

export function statesABaseline(summary) {
  if (typeof summary !== "string" || !BASELINE_CONNECTIVE.test(summary)) return false;
  return quantities(summary).length > 0;
}

export function restoredBaseline(clause, mustStateADifference = false) {
  const opening = clauseText(clause).trimStart().charAt(0);
  const stripped = trimmedToItsFigures(withoutStoredReference(clause));
  if (!stripped || namesOurRecord(stripped) || quantities(stripped).length === 0) return null;
  if (classifyClause(stripped) !== CLAUSE_BOOKKEEPING && classifyClause(stripped) !== CLAUSE_TERMS) {
    return null;
  }
  if (mustStateADifference && !statesADifference(stripped)) return null;
  const cased =
    opening === opening.toUpperCase() ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : stripped;
  return clause.startsWith(CONTINUES_A_SENTENCE) ? CONTINUES_A_SENTENCE + cased : cased;
}

export function statesTheSameFigure(baseline, elsewhere) {
  const carried = quantifiedAttributes(baseline);
  if (carried.length === 0) return false;
  const already = elsewhere.flatMap((text) => quantifiedAttributes(text));
  return carried.every((figure) =>
    already.some((other) => comparedQuantity(figure, other)?.direction === "equal")
  );
}

export function namesWhatItMeasures(baseline) {
  return quantifiedAttributes(baseline).length > 0;
}

export function withBaselineRestored(evidence, mustStateADifference = false) {
  const clauses = [...evidence.clauses];
  const kinds = [...evidence.kinds];
  const kept = [];
  const dropped = [];
  let restored = 0;
  evidence.clauses.forEach((clause, i) => {
    if (kinds[i] === CLAUSE_TERMS) {
      kept.push(clause);
      return;
    }
    const restatedByTheNext = evidence.kinds[i + 1] === CLAUSE_RESTATEMENT;
    const baseline =
      kinds[i] === CLAUSE_BOOKKEEPING && !restatedByTheNext
        ? restoredBaseline(clause, mustStateADifference)
        : null;
    const carriesItsOwnSubject = baseline !== null && namesWhatItMeasures(baseline);
    const followsASurvivor = i > 0 && kinds[i - 1] === CLAUSE_TERMS;
    const alreadyStated =
      baseline !== null &&
      statesTheSameFigure(
        baseline,
        clauses.filter((_, j) => j !== i && kinds[j] === CLAUSE_TERMS)
      );
    if (baseline === null || alreadyStated || !(carriesItsOwnSubject || followsASurvivor)) {
      dropped.push({ clause: clauseText(clause), kind: kinds[i] });
      return;
    }
    clauses[i] = baseline;
    kinds[i] = CLAUSE_TERMS;
    kept.push(baseline);
    restored += 1;
  });
  if (restored === 0) return null;
  return { clauses, kinds, kept, dropped, restored, changed: kept.filter(statesADifference) };
}

export function namesTheDimensionThatChanged(record, summary) {
  const stored = quantifiedAttributes(record?.previous_state);
  if (stored.length === 0) return true;
  const stated = quantifiedAttributes(summary);
  return stored.some((before) =>
    stated.some((after) =>
      before.words.some((word) => after.words.includes(word) && !BYTE_UNITS.has(word))
    )
  );
}

export function summaryFromClauses(clauses) {
  const sentences = [];
  for (const clause of clauses) {
    const continues = clause.startsWith(CONTINUES_A_SENTENCE);
    const opened = clause.replace(CONTINUES_A_SENTENCE, "").replace(TRAILING_CONNECTIVE, "");
    const trimmed = opened.replace(/[\s,;]+$/, "").replace(/\.$/, "").trim();
    if (!trimmed) continue;
    const started = continues || opened.length !== clause.length;
    sentences.push(started ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed);
  }
  return sentences.length === 0 ? "" : `${sentences.join(". ")}.`;
}

const REMOVAL_EVIDENCE = [
  /\b(?:removed|removing|discontinued|discontinuing|deprecated|retired|retiring|sunset|shut\s?down|shutting\s+down|eliminated|withdrawn|closed|ceased|killed|ends?|ended|ending)\b/i,
  /\bno\s+longer\s+(?:offer|offers|offered|offering|available|free|listed|includes?|included|provides?|provided|has|have|exists?|accessible|supported|on\s+offer)\b/i,
  /\bno\s+(?:ongoing|permanent|permanently|public|documented|visible|clear)?\s?free\b/i,
  /\b(?:trial|paid|subscription|enterprise)[-\s]only\b/i,
  /\bonly\s+(?:a\s+|the\s+)?(?:\d+[-\s]day\s+)?(?:free\s+)?trial\b/i,
  /\b(?:now|only)\s+(?:offers?\s+|has\s+)?(?:a\s+)?(?:\d+[-\s]day\s+)?(?:free\s+)?trial\b/i,
  /\b(?:plans?|pricing|tiers?)\s+(?:now\s+)?(?:start|starts|starting|begin|begins|from)\b/i,
  /\bstarting\s+(?:plan|price|tier|at|from)\b/i,
  /\b(?:starts?|starting|priced|paid|pricing|from)\s+(?:at\s+|from\s+)?[$€£¥₹]\d/i,
  /\bminimum\s+plan\b/i,
  /\blowest\s+(?:tier|plan)\s+is\s+(?:a\s+)?paid\b/i,
  /\b(?:locked|gated|moved|placed)\s+behind\b/i,
  /\brequires?\s+(?:a\s+)?(?:paid|payment|purchase|subscription|credit\s+card|licen[cs]e)\b/i,
  /\b(?:replaced|superseded)\s+by\b/i,
  /\bmust\s+migrate\b/i,
  /\ball\s+plans?\s+(?:now\s+)?(?:start|require|cost)\b/i,
];

export function statesARemoval(summary) {
  if (typeof summary !== "string") return false;
  return REMOVAL_EVIDENCE.some((pattern) => pattern.test(summary));
}

const FREE_STILL_OFFERED = [
  /\b(?:start|get\s+started|sign\s?-?up|signup|try|begin)\s+(?:it\s+|now\s+)?(?:for\s+)?free\b/i,
  /\b['"‘“]free['"’”]\s+(?:sign\s?-?up|signup|account|access|option)\b/i,
  /\bfree\s+(?:plan|tier|version)\s+(?:is\s+|are\s+)?(?:still|remains?)\b/i,
  /\bstill\s+(?:offers?|has|provides?)\s+a\s+free\s+(?:plan|tier|version)\b/i,
];

export function reportsSomethingStillFree(summary) {
  if (typeof summary !== "string") return false;
  const withoutTrials = summary.replace(/\bfree\s+trials?\b/gi, "trial");
  return FREE_STILL_OFFERED.some((pattern) => pattern.test(withoutTrials));
}

const ONLY_THE_WORDING_MOVED = [
  /\b(?:description|wording|phrasing)\s+is\s+(?:now\s+)?less\s+(?:specific|detailed|explicit)\b/i,
  /\bonly\s+the\s+(?:description|wording|phrasing)\s+(?:has\s+)?changed\b/i,
  /\b(?:terms?|limits?|allowances?)\s+(?:are|is|remain|remains)\s+(?:the\s+)?(?:same|unchanged)\b/i,
];

export function reportsNoNarrowing(summary) {
  if (typeof summary !== "string") return false;
  const nothingMoved =
    reportsSomethingStillFree(summary) || ONLY_THE_WORDING_MOVED.some((pattern) => pattern.test(summary));
  return nothingMoved && summaryEvidence(summary).changed.length === 0;
}

const OUR_OWN_ENTRY =
  /\b(?:data\s+correction|(?:the\s+)?(?:previous|prior|original|old)\s+(?:entry|listing|record|description)|our\s+(?:entry|listing|record)|we\s+(?:previously\s+)?(?:listed|recorded|stored))\b/i;
const STATED_IT_WRONGLY =
  /\b(?:incorrect(?:ly)?|erroneous(?:ly)?|mistaken(?:ly)?|wrongly|in\s+error|corrected|correction)\b/i;

export function correctsOurOwnRecord(record) {
  return summaryClauses(record?.summary).some((raw) => {
    const clause = clauseText(raw);
    return OUR_OWN_ENTRY.test(clause) && STATED_IT_WRONGLY.test(clause);
  });
}

export function baselineIsAStoredDescription(record) {
  return record?.date_source !== HAND_WRITTEN;
}

export function restrictionEvidence(record, context = {}) {
  if (record?.change_type !== RESTRICTION) return { ok: true };

  if (correctsOurOwnRecord(record)) {
    return {
      ok: true,
      reclassifyAs: RECLASSIFIED_AS_CORRECTION,
      detail: `the summary states that our own earlier entry was wrong, so the record corrects our data rather than reporting terms the vendor narrowed`,
    };
  }

  if (reportsNoNarrowing(record?.summary)) {
    return {
      ok: false,
      reason: REJECT_STATES_NO_NARROWING,
      detail: `a restriction was recorded by a summary that reports the free tier still standing and names no term that moved`,
    };
  }

  if (baselineIsAStoredDescription(record) && !statesTerms(record?.previous_state)) {
    return {
      ok: false,
      reason: REJECT_NO_TERMS_TO_NARROW,
      detail: `a restriction was measured against "${record?.previous_state}", a stored description that states no price, named tier or allowance, so there is nothing for the terms to have narrowed from`,
    };
  }

  const { compared, unmatched } = quantityComparison(record, unitAliases(context.pageText));
  if (
    unmatched.length === 0 &&
    compared.some(({ aliased }) => aliased) &&
    compared.every(({ direction }) => direction === "equal")
  ) {
    const held = compared.map(({ previous, current }) => `${previous} against ${current}`).slice(0, 3).join(", ");
    return {
      ok: false,
      reason: REJECT_MEASURES_NO_CHANGE,
      detail: `a restriction was recorded over quantities that all hold the same value once notation, period and any unit the page defines as equivalent are normalised — ${held}`,
    };
  }

  return { ok: true };
}

export function isDomainRoot(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function registrableHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function redirectedOffDomain(requestedUrl, finalUrl) {
  const from = registrableHost(requestedUrl);
  const to = registrableHost(finalUrl);
  if (!from || !to || from === to) return false;
  return !from.endsWith(`.${to}`) && !to.endsWith(`.${from}`);
}

export function describesChange(entry, context = {}) {
  const previous = quantities(entry?.previous_state);
  const current = quantities(entry?.current_state);

  const pageText = context.pageText;
  if (typeof pageText === "string") {
    const naming = pageNamesVendor(pageText, entry?.vendor, { url: entry?.source_url });
    if (!naming.named) {
      return {
        ok: false,
        reason: REJECT_PAGE_NOT_ABOUT_VENDOR,
        detail: `the page read never names ${entry?.vendor} and is not served from its domain, so any terms on it belong to somebody else`,
      };
    }
    const signals = priceSignals(pageText);
    if (signals.length < MIN_PRICE_SIGNALS) {
      return {
        ok: false,
        reason: REJECT_NO_PRICE_SIGNAL,
        detail: `the page read carries no price signal — no amount, named tier or metered rate in ${pageText.length} characters, so it states no terms to have changed`,
      };
    }
  }

  const audit = auditRecord(entry, context);
  const refusedByAudit =
    audit.outcome === OUTCOME_REFUSED
      ? { ok: false, reason: audit.reason, detail: audit.detail }
      : null;

  const nulls = nullComparisons(entry?.summary);
  if (nulls.length > 0 && containsAll(current, previous)) {
    return {
      ok: false,
      reason: REJECT_NULL_COMPARISON,
      detail: `summary states "${nulls[0].connective}" between two values of ${nulls[0].value} and no stored quantity is absent from the current state`,
    };
  }

  if (
    QUANTITY_CHANGE_TYPES.includes(entry?.change_type) &&
    assertsAgreement(entry?.summary) &&
    multisetEqual(previous, current)
  ) {
    return {
      ok: false,
      reason: REJECT_STATES_NO_DIFFERENCE,
      detail: `${entry.change_type} claimed, summary asserts the page matches what we stored, and the two states carry the same quantities`,
    };
  }

  if (QUANTITY_CHANGE_TYPES.includes(entry?.change_type)) {
    const unquantified = unquantifiedInCurrentState(entry);
    if (unquantified) {
      const gone =
        context.pageComplete === true ? storedDimensionsAbsentFromPage(entry, pageText) : [];
      if (gone.length > 0) {
        const asRestructure = auditRecord(
          { ...entry, change_type: RECLASSIFIED_AS_RESTRUCTURE },
          context
        );
        if (asRestructure.outcome === OUTCOME_REFUSED) {
          return { ok: false, reason: asRestructure.reason, detail: asRestructure.detail };
        }
        const missing = gone.map((a) => `${a.value} ${a.measured}`).join(", ");
        return {
          ok: true,
          reclassifyAs: RECLASSIFIED_AS_RESTRUCTURE,
          rewriteSummary: asRestructure.summary ?? undefined,
          detail: `the whole page was read and states nothing at all about ${missing}, so the stored dimension is gone rather than left unquantified`,
        };
      }
      const stored = unquantified.previous.map((a) => `${a.value} ${a.words[0]}`).join(", ");
      return {
        ok: false,
        reason: REJECT_UNQUANTIFIED_LIMIT,
        detail: `${entry.change_type} claimed, but the current state names no quantity for anything the stored state measured (${stored})`,
      };
    }
  }

  const restriction = restrictionEvidence(entry, context);
  if (!restriction.ok) return restriction;
  if (restriction.reclassifyAs) {
    return { ok: true, reclassifyAs: restriction.reclassifyAs, detail: restriction.detail };
  }

  if (refusedByAudit) return refusedByAudit;
  return { ok: true, rewriteSummary: audit.summary ?? undefined };
}

export function changeConfirmationPrompt(entry) {
  return `A monitoring job compared a stored description of a vendor's free tier against the vendor's live page and reported a change. Decide whether the report actually describes a change.

STORED DESCRIPTION (what we published before):
${entry.previous_state}

CURRENT PAGE (what the job read today):
${entry.current_state}

THE JOB'S REPORT:
${entry.summary}

Answer "no" if the two descriptions state the same terms in different words, if the report restates the stored description, if the report says the page matches what was stored, or if the only difference is wording, formatting, or detail the stored description never claimed.

Answer "yes" only if a developer relying on the stored description would get something different today.

Respond with EXACTLY one JSON object and no other text:
{"change":"yes"}
{"change":"no","reason":"<short reason>"}`;
}

export function parseConfirmation(raw) {
  const text =
    typeof raw === "string"
      ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
      : "";
  const accept = (parsed) =>
    parsed && (parsed.change === "yes" || parsed.change === "no") ? parsed : null;
  try {
    const parsed = accept(JSON.parse(text));
    if (parsed) return { verdict: parsed.change, reason: parsed.reason ?? null };
  } catch {
    const match = text.match(/\{[^}]*\}/);
    if (match) {
      try {
        const parsed = accept(JSON.parse(match[0]));
        if (parsed) return { verdict: parsed.change, reason: parsed.reason ?? null };
      } catch {}
    }
  }
  return { verdict: "unparsed", reason: null };
}

export async function confirmDescribesChange(client, entry) {
  return parseConfirmation(await client.complete(changeConfirmationPrompt(entry)));
}

export function rejectionCounts(rejected = []) {
  const counts = new Map(GATE_REASONS.map((reason) => [reason, 0]));
  for (const { reason } of rejected) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return counts;
}

export function describesQuantifiedDifference(entry) {
  return measuredDifferences(entry)[0] ?? null;
}

export async function gateCandidates(candidates, options = {}) {
  const confirmFn = options.confirmFn;
  const pageTextFor = options.pageTextFor ?? (() => undefined);
  const pageCompleteFor = options.pageCompleteFor ?? (() => false);
  const finalUrlFor = options.finalUrlFor ?? (() => undefined);
  const accepted = [];
  const rejected = [];
  const unchecked = [];
  const reclassified = [];
  const rewritten = [];
  const overruled = [];

  for (const original of candidates) {
    const verdict = describesChange(original, {
      pageText: pageTextFor(original),
      pageComplete: pageCompleteFor(original),
      finalUrl: finalUrlFor(original),
    });
    if (!verdict.ok) {
      rejected.push({ candidate: original, reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    let candidate = original;
    if (verdict.reclassifyAs) {
      candidate = { ...original, change_type: verdict.reclassifyAs };
      reclassified.push({
        candidate,
        from: original.change_type,
        to: verdict.reclassifyAs,
        detail: verdict.detail,
      });
    }
    if (verdict.rewriteSummary) {
      const was = candidate.summary;
      candidate = { ...candidate, summary: verdict.rewriteSummary };
      rewritten.push({ candidate, was, now: verdict.rewriteSummary });
    }
    if (!confirmFn) {
      accepted.push(candidate);
      continue;
    }
    let confirmation;
    try {
      confirmation = await confirmFn(candidate);
    } catch (err) {
      unchecked.push({ candidate, error: err.message });
      accepted.push(candidate);
      continue;
    }
    if (confirmation.verdict === "no") {
      const difference = describesQuantifiedDifference(candidate);
      if (!difference) {
        rejected.push({
          candidate,
          reason: REJECT_CONFIRMED_UNCHANGED,
          detail: confirmation.reason || "a second pass judged the report to describe no change",
        });
        continue;
      }
      overruled.push({
        candidate,
        opinion: confirmation.reason || "a second pass judged the report to describe no change",
        difference,
        detail: `the two states measure ${difference.attribute} at ${difference.previous} and ${difference.current}, a ${difference.direction} from ${difference.from.toLocaleString("en-US")} to ${difference.to.toLocaleString("en-US")} once notation and period are normalised`,
      });
      accepted.push(candidate);
      continue;
    }
    if (confirmation.verdict === "unparsed") {
      unchecked.push({ candidate, error: "second pass returned no usable verdict" });
    }
    accepted.push(candidate);
  }

  return { accepted, rejected, unchecked, reclassified, rewritten, overruled };
}



const QUANTITY_CLAIMS = ["limits_reduced", "limits_increased"];
const UNBOUNDED = /\bunlimited\b/i;

function namesSomethingNew(summary, previousState) {
  const held = new Set(quantities(previousState));
  return quantities(summary).some((figure) => !held.has(figure));
}

export const OUTCOME_UNCHANGED = "unchanged";
export const OUTCOME_REWRITTEN = "rewritten";
export const OUTCOME_REFUSED = "refused";

const ANAPHOR_OPENER =
  /^(?:it|they|these|those|there|also|additionally|furthermore|moreover|instead)\b/i;

export function opensWithDroppedAntecedent(evidence, summary) {
  const first = evidence.kinds.indexOf(CLAUSE_TERMS);
  if (first <= 0) return false;
  return ANAPHOR_OPENER.test(String(summary ?? "").trim());
}

const DIRECTIONAL_CLAIMS = [...QUANTITY_CLAIMS, FREE_TIER_REMOVED];

function statesWhatChanged(record, summary) {
  if (record?.change_type === FREE_TIER_REMOVED) return statesARemoval(summary);
  return namesTheDimensionThatChanged(record, summary);
}

function baselineWasDropped(evidence) {
  return evidence.dropped.some(
    ({ clause, kind }) => kind === CLAUSE_BOOKKEEPING && quantities(clause).length > 0
  );
}

export function hasABaselineToRestate(record, evidence) {
  if (!DIRECTIONAL_CLAIMS.includes(record?.change_type)) return false;
  return baselineWasDropped(evidence);
}

const EXPECTED_DIRECTION = {
  limits_reduced: "decrease",
  limits_increased: "increase",
};

export function statesBothSides(summary, quantity) {
  const stated = quantifiedAttributes(summary);
  const carries = (attribute) =>
    stated.some((other) => comparedQuantity(attribute, other)?.direction === "equal");
  return carries(quantity.before) && carries(quantity.after);
}

function everyStatedFigureHeldStill(summary, compared, restated) {
  const held = restated.map(({ value }) => value);
  return readQuantities(summary)
    .filter(({ spellsAPeriod }) => !spellsAPeriod)
    .filter(measuresAnAmount)
    .every((stated) => {
      if (held.includes(Number(String(stated.value).replace(/,/g, "")))) return true;
      if (measuredWord(stated) === null) return false;
      return compared.some(
        ({ before, after }) =>
          comparedQuantity(before, stated)?.direction === "equal" ||
          comparedQuantity(after, stated)?.direction === "equal"
      );
    });
}

export function measuredAgainstItsClaim(record, published = record?.summary) {
  const expected = EXPECTED_DIRECTION[record?.change_type];
  if (!expected) return null;
  const { compared } = quantityComparison(record);
  const restated = nullComparisons(published);
  if (compared.length + restated.length === 0) return null;
  const moved = compared.filter(({ direction }) => direction !== "equal");
  if (moved.length === 0) {
    if (!everyStatedFigureHeldStill(published, compared, restated)) return null;
    return { reason: REJECT_MEASURES_NO_CHANGE, quantities: compared, restated };
  }
  const contradicts = moved.filter(({ direction }) => direction !== expected);
  if (contradicts.length === moved.length && contradicts.some((q) => statesBothSides(published, q))) {
    return { reason: REJECT_MEASURES_THE_OPPOSITE, quantities: contradicts, restated };
  }
  return null;
}

function readsAsAList(measured) {
  const pairs = measured.quantities.map(({ previous, current }) => `${previous} against ${current}`);
  const stated = measured.restated.map(({ connective, value }) => `${value} "${connective}" ${value}`);
  return [...pairs, ...stated].slice(0, 3).join(", ");
}

export function lostTheSubjectOfItsClaim(record, evidence, summary) {
  if (!DIRECTIONAL_CLAIMS.includes(record?.change_type)) return false;
  if (statesABaseline(summary) || statesWhatChanged(record, summary)) return false;
  return evidence.dropped.some(({ clause }) => statesWhatChanged(record, clause));
}

export function auditRecord(record, context = {}) {
  let evidence = summaryEvidence(record?.summary);
  let dropped = evidence.dropped;
  const refuse = (reason, detail) => ({ outcome: OUTCOME_REFUSED, reason, detail, summary: null, dropped });

  const movedOffDomain = redirectedOffDomain(record?.source_url, context.finalUrl);
  if (movedOffDomain) {
    const host = registrableHost(context.finalUrl);
    return {
      outcome: OUTCOME_REWRITTEN,
      reason: null,
      detail: `the page we cite redirects to ${host}, so the change is sourced from the redirect rather than from what the page failed to say`,
      summary: summaryFromClauses([`${record.vendor}'s own page now redirects to ${host}`, ...evidence.kept]),
      dropped,
    };
  }

  if (evidence.kept.length === 0) {
    const restated = withBaselineRestored(evidence, true);
    if (restated === null) {
      const kinds = [...new Set(dropped.map(({ kind }) => kind))].sort();
      return refuse(
        REJECT_STATES_NO_TERMS,
        `every clause of the summary states ${kinds.join(" or ")} rather than a term the page carries, so it reports the reading rather than a change`
      );
    }
    evidence = restated;
    dropped = restated.dropped;
  }

  let rewritten = summaryFromClauses(evidence.kept);

  if (hasABaselineToRestate(record, evidence)) {
    const restored = withBaselineRestored(evidence);
    if (restored) {
      evidence = restored;
      dropped = restored.dropped;
      rewritten = summaryFromClauses(evidence.kept);
    }
  }

  if (
    assertsAgreement(record?.summary) &&
    evidence.changed.length === 0 &&
    !namesSomethingNew(rewritten, record?.previous_state)
  ) {
    return refuse(
      REJECT_STATES_NO_DIFFERENCE,
      `the summary states that the page agrees with what we hold, and names no figure the stored description did not already carry`
    );
  }

  if (
    QUANTITY_CLAIMS.includes(record?.change_type) &&
    quantities(record?.summary).length > 0 &&
    quantities(rewritten).length === 0 &&
    !UNBOUNDED.test(rewritten)
  ) {
    return refuse(
      REJECT_STATES_NO_DIFFERENCE,
      `${record.change_type} claimed, and every figure the summary carried sat in a clause about our own record rather than about the vendor's terms`
    );
  }

  if (record?.change_type === FREE_TIER_REMOVED) {
    const evidenced = statesARemoval(rewritten);
    if (reportsSomethingStillFree(record?.summary)) {
      return refuse(
        REJECT_FREE_TIER_STILL_OFFERED,
        `a free tier was recorded as removed by a summary that reports the page still offering one`
      );
    }
    if (!evidenced && isDomainRoot(record?.source_url)) {
      return refuse(
        REJECT_REMOVAL_READ_FROM_ROOT,
        `a free tier was recorded as removed from ${record.source_url}, a domain root that states no price, ending or replacement where the free tier was — a homepage's silence is not evidence that one ended`
      );
    }
    if (!evidenced && dropped.some(({ kind }) => kind === CLAUSE_ABSENCE)) {
      return refuse(
        REJECT_NO_REMOVAL_EVIDENCE,
        `a free tier was recorded as removed on the evidence that the page did not mention it, and the summary states no price, ending or replacement where the free tier was`
      );
    }
  }

  const measured = measuredAgainstItsClaim(record, rewritten);
  if (measured?.reason === REJECT_MEASURES_NO_CHANGE) {
    return refuse(
      REJECT_MEASURES_NO_CHANGE,
      `${record.change_type} claimed, and every quantity the record compares holds the same value once notation and period are normalised — ${readsAsAList(measured)}`
    );
  }
  if (measured?.reason === REJECT_MEASURES_THE_OPPOSITE) {
    return refuse(
      REJECT_MEASURES_THE_OPPOSITE,
      `${record.change_type} claimed, and every quantity that moved between the two states moved the other way — ${readsAsAList(measured)}`
    );
  }

  if (lostTheSubjectOfItsClaim(record, evidence, rewritten)) {
    return refuse(
      REJECT_NO_BASELINE,
      `${record.change_type} claimed, and the clause that named the terms the change was measured on was dropped — what is left states no earlier figure and nothing the stored description measured`
    );
  }

  if (opensWithDroppedAntecedent(evidence, rewritten)) {
    return refuse(
      REJECT_DANGLING_REFERENCE,
      `the summary now opens on a reference to a clause that was dropped, so the sentence that travels alone has no subject`
    );
  }

  const restored = evidence.restored ?? 0;
  if ((dropped.length === 0 && restored === 0) || rewritten === record?.summary) {
    return { outcome: OUTCOME_UNCHANGED, reason: null, detail: null, summary: null, dropped };
  }
  return {
    outcome: OUTCOME_REWRITTEN,
    reason: null,
    detail: `dropped ${dropped.length} clause(s) that stated our reading rather than the vendor's terms, and restated ${restored} as the vendor's earlier terms`,
    summary: rewritten,
    dropped,
  };
}

export function applyAudit(record, verdict) {
  if (verdict.outcome !== OUTCOME_REWRITTEN) return record;
  return { ...record, summary: verdict.summary };
}
