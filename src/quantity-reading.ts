import { readPeriod, type LimitPeriod } from "./growth-limits.js";

export const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

export const ATTRIBUTE_WINDOW = 60;
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
const HOUR = "hour";

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
export const A_FIGURE = /\d/;
const A_LETTER = /[A-Za-z]/;
export const CLAUSE_ENDS = /[,;.()✓•|]/;
export const A_SCOPE = /\sper\s/i;
const A_CLAUSE_BOUNDARY = /[;:()]|[.,](?!\d)/g;
const ALLOWANCE_SCAN = 80;
const TIME_UNIT_RATE = /^\s?(hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|months?|years?)\s?\//i;
const A_NAMED_SCOPE = /(?:\s+per\s+|\s*\/\s*)([a-z][a-z-]+)/i;

export interface Quantity {
  value: string;
  words: string[];
  unit: string | null;
  scale: number;
  period: LimitPeriod | null;
  scope: string | null;
  at: number;
  spellsAPeriod: boolean;
}

interface PeriodRead {
  period: LimitPeriod;
  at: number;
  ends: number;
}

function periodAfter(window: string): PeriodRead | null {
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

export function periodSeconds(period: Partial<LimitPeriod> | null | undefined): number | null {
  const seconds = PERIOD_SECONDS.get(period?.unit ?? "");
  if (seconds === undefined) return null;
  const count = Number(String(period?.count ?? "1").replace(/,/g, ""));
  return Number.isFinite(count) && count > 0 ? count * seconds : seconds;
}

function spanOf(word: string | null): number | null {
  return word ? (PERIOD_SECONDS.get(readPeriod(`/${word}`)?.unit ?? "") ?? null) : null;
}

export function singular(word: string): string {
  return word.replace(/ies$/, "y").replace(/(?:es|s)$/, "");
}

export const PRICE_ATTRIBUTE = "currency";

export function wordsIn(trailing: string): string[] {
  const words: string[] = [];
  for (const word of trailing.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean).slice(0, ATTRIBUTE_WORDS)) {
    const stem = singular(word);
    if (ATTRIBUTE_STOPWORDS.has(word) || ATTRIBUTE_STOPWORDS.has(stem)) continue;
    if (A_FIGURE.test(stem.charAt(0))) continue;
    if (stem.length <= 2 && !BYTE_UNITS.has(stem)) continue;
    words.push(stem);
  }
  return words;
}

export function namesAProduct(text: string, at: number): boolean {
  return A_LETTER.test(text.charAt(at - 1));
}

function timeUnitRateIn(trailing: string): string[] {
  const match = trailing.match(TIME_UNIT_RATE);
  return match ? [singular(match[1].toLowerCase())] : [];
}

function scopeNamedIn(span: string): string | null {
  const named = span.match(A_NAMED_SCOPE);
  if (!named) return null;
  const word = singular(named[1].toLowerCase());
  if (ATTRIBUTE_STOPWORDS.has(word) || readPeriod(`/${word}`)) return null;
  return word;
}

function scopeOf(beside: string, rate: PeriodRead | null): string | null {
  if (rate?.period?.scope) return singular(rate.period.scope.toLowerCase());
  const stops = [beside.search(A_FIGURE), beside.search(CLAUSE_ENDS)].filter((at) => at !== -1);
  return scopeNamedIn(beside.slice(0, Math.min(...stops, beside.length)));
}

export const ALLOWANCE_NOUNS = new Set([
  "user", "seat", "member", "collaborator", "device", "session",
  "request", "call", "query", "lookup", "operation", "invocation", "execution",
  "project", "site", "app", "application", "workspace", "environment", "vault",
  "repository", "repo", "database", "table", "dataset", "bucket", "container",
  "instance", "node", "sandbox", "machine", "worker", "runner",
  "build", "deployment", "deploy", "job", "run", "pipeline", "check", "monitor",
  "minute", "hour", "credit", "token", "message", "email", "notification",
  "contact", "subscriber", "record", "row", "document", "image", "video",
  "domain", "location", "region", "alias", "key", "form", "submission",
  "event", "replay", "span", "log", "trace", "metric", "view", "page",
]);

export function allowanceNamedBefore(text: string, at: number): string[] {
  const window = text.slice(Math.max(0, at - ALLOWANCE_SCAN), at);
  const boundaries = [...window.matchAll(A_CLAUSE_BOUNDARY)];
  const last = boundaries.at(-1);
  const clause = last ? window.slice(last.index! + last[0].length) : window;
  const words = clause.toLowerCase().match(A_WORD) ?? [];
  for (const word of words.reverse()) {
    const stem = singular(word);
    if (ALLOWANCE_NOUNS.has(stem)) return [stem];
  }
  return [];
}

export function readQuantities(text: unknown): Quantity[] {
  if (typeof text !== "string") return [];
  const read: Quantity[] = [];
  let readThrough = 0;
  for (const match of text.matchAll(NUMBER)) {
    const index = match.index!;
    if (namesAProduct(text, index)) continue;
    const start = index + match[0].length;
    const trailing = text.slice(start, start + ATTRIBUTE_WINDOW);
    const rate = periodAfter(trailing);
    const beside = trailing.slice(rate && rate.at === 0 ? rate.ends : 0);
    const stops = [
      rate && rate.at > 0 ? rate.at : -1,
      beside.search(A_FIGURE),
      beside.search(CLAUSE_ENDS),
      beside.search(A_SCOPE),
    ];
    const describes = Math.min(...stops.filter((at) => at !== -1), beside.length);
    const words: string[] = [];
    if (/[$€£¥₹]\s?$/.test(text.slice(0, index))) words.push(PRICE_ATTRIBUTE);
    const named = wordsIn(beside.slice(0, describes));
    words.push(...(named.length > 0 || rate ? named : wordsIn(trailing)));
    if (words.length === 0) words.push(...timeUnitRateIn(trailing));
    if (words.length === 0 && rate) words.push(...allowanceNamedBefore(text, index));
    const unitMatch = trailing.match(UNIT_AFTER_NUMBER);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : null;
    const magnitudeMatch = unit === null ? trailing.match(MAGNITUDE_AFTER_NUMBER) : null;
    const magnitude = magnitudeMatch ? (magnitudeMatch[1] ?? magnitudeMatch[2]).toLowerCase() : "";
    const durationMatch = unit === null && magnitude === "" ? trailing.match(DURATION_AFTER_NUMBER) : null;
    const span = spanOf(durationMatch ? durationMatch[1] : null);
    if (span === PERIOD_SECONDS.get(HOUR) && !words.includes(HOUR)) words.push(HOUR);
    const scale =
      BYTE_UNITS.get(unit ?? "") ??
      MAGNITUDE_UNITS.get(magnitude) ??
      span ??
      1;
    const period = rate?.period ?? null;
    const scope = scopeOf(beside, rate);
    read.push({ value: match[0], words, unit, scale, period, scope, at: index, spellsAPeriod: index < readThrough });
    if (rate) readThrough = start + rate.ends;
  }
  return read;
}

export function quantifiedAttributes(text: unknown): Quantity[] {
  return readQuantities(text).filter(({ words, spellsAPeriod }) => words.length > 0 && !spellsAPeriod);
}

export function isAMeasureWord(word: string): boolean {
  return !BYTE_UNITS.has(word) && !MAGNITUDE_UNITS.has(word) && !A_FIGURE.test(word.charAt(0));
}

export function measuredWord(attribute: Partial<Quantity> | null | undefined): string | null {
  return (attribute?.words ?? []).find(isAMeasureWord) ?? null;
}

export function measuredValue(attribute: Partial<Quantity> | null | undefined): number | null {
  const value = Number(String(attribute?.value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return value * (attribute?.scale ?? 1);
}

export function statesTheSameQuantity(
  stated: Partial<Quantity> | null | undefined,
  published: Partial<Quantity> | null | undefined,
): boolean {
  const value = measuredValue(stated);
  if (value === null || value !== measuredValue(published)) return false;
  if (stated?.scope && stated.scope !== published?.scope) return false;
  if (stated?.unit && stated.unit === published?.unit) return true;
  const measures = new Set((published?.words ?? []).filter(isAMeasureWord));
  return (stated?.words ?? []).some((word) => isAMeasureWord(word) && measures.has(word));
}

export function carriesAScopeOursDoNot(
  quantity: Partial<Quantity> | null | undefined,
  published: readonly Partial<Quantity>[],
): boolean {
  return Boolean(quantity?.scope) && !published.some((ours) => ours.scope === quantity?.scope);
}

export function figuresWeAlsoPublish(signals: Iterable<unknown> | null | undefined, terms: unknown): string[] {
  const published = quantifiedAttributes(terms);
  if (published.length === 0) return [];
  const bearing: string[] = [];
  const seen = new Set<string>();
  for (const signal of signals ?? []) {
    const figure = String(signal ?? "").trim();
    const key = figure.toLowerCase().replace(/\s+/g, " ");
    if (key === "" || seen.has(key)) continue;
    const stated = quantifiedAttributes(figure);
    if (stated.some((quantity) => carriesAScopeOursDoNot(quantity, published))) continue;
    if (!stated.some((quantity) => published.some((ours) => statesTheSameQuantity(quantity, ours)))) continue;
    seen.add(key);
    bearing.push(figure);
  }
  return bearing;
}
