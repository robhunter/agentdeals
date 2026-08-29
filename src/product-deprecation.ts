import type { DealChange } from "./types.js";

export const PRODUCT_DEPRECATED = "product_deprecated";

const PREDICATE = new RegExp(
  [
    "\\b(?:is|are|was|were)\\s+(?:being\\s+|now\\s+)?(?:shut\\s?down|shutting\\s+down|deprecated|discontinued|sunset|sunsetting|retired|closed)\\b",
    "\\bwill\\s+(?:be\\s+)?(?:shut\\s?down|shutting\\s+down|deprecated|discontinued|sunset|retired|close)\\b",
    "\\b(?:shut(?:ting|s)?\\s+down|shutdown)\\b",
    "\\bbeing\\s+(?:sunset|deprecated|discontinued|retired|phased\\s+out|wound\\s+down)\\b",
    "\\bdeprecat(?:ed|ion|ing)\\b",
    "\\bdiscontinu(?:ed|ing|ation)\\b",
    "\\bsunset(?:ting|s)?\\b",
    "\\bretir(?:ed|ement|ing)\\b",
    "\\bphased\\s+out\\b",
    "\\bwind(?:ing|s)?\\s+down\\b",
    "\\bend\\s+of\\s+(?:support|availability|life|sale|service)\\b",
    "\\bclosed\\s+to\\s+new\\s+customers\\b",
    "\\bno\\s+longer\\s+(?:maintained|supported|available|being\\s+developed)\\b",
  ].join("|"),
  "i",
);

const GENERIC_WORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "its", "their", "our", "his", "her",
  "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from", "as", "than",
  "is", "are", "was", "were", "be", "been", "being", "will", "would", "has", "have", "had",
  "it", "they", "we", "you", "all", "both", "now", "still", "also", "only", "then",
  "service", "services", "platform", "product", "products", "offering", "offerings",
  "tier", "tiers", "plan", "plans", "company", "business", "tool", "tools",
  "site", "website", "websites", "software", "free", "paid",
]);

const TLDS = new Set([
  "com", "io", "dev", "sh", "ai", "co", "net", "org", "app", "cloud", "xyz", "gg", "so", "tech",
]);

const RENAME_ASIDE = /\(\s*(?:formerly|previously|forme?rly\s+known\s+as|also\s+known\s+as|f\/k\/a|fka|aka|née|nee|now)\b[^)]*\)/gi;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const MONTH_NAMES = MONTHS.join("|");

const DATE_PATTERNS = [
  new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES}),?\\s+(\\d{4})\\b`, "gi"),
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
];

function words(text: string): string[] {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

export function vendorWords(vendor: string): Set<string> {
  const parts = words(vendor);
  const suffix = (vendor ?? "").match(/\.([a-z]{2,})\s*$/i)?.[1]?.toLowerCase();
  if (parts.length > 1 && suffix && TLDS.has(suffix) && parts[parts.length - 1] === suffix) parts.pop();
  return new Set(parts);
}

function sentences(text: string): string[] {
  return (text ?? "").split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
}

export interface DeprecationReading {
  subject: string;
  predicate: string;
  sentence: string;
}

export function readDeprecation(text: string): DeprecationReading | null {
  for (const sentence of sentences(text ?? "")) {
    const match = sentence.match(PREDICATE);
    if (!match || match.index === undefined) continue;
    return { subject: sentence.slice(0, match.index).trim(), predicate: match[0], sentence };
  }
  return null;
}

export function productNamedApartFromVendor(subject: string, vendor: string): string[] {
  const fromVendor = vendorWords(vendor);
  const named = (subject ?? "").replace(RENAME_ASIDE, " ");
  return words(named).filter(w => !fromVendor.has(w) && !GENERIC_WORDS.has(w));
}

type DeprecationRecord = Pick<DealChange, "change_type" | "vendor" | "summary">;

const endsTheListedProductCache = new WeakMap<object, boolean>();

function decide(change: DeprecationRecord): boolean {
  if (change.change_type !== PRODUCT_DEPRECATED) return false;
  const reading = readDeprecation(change.summary ?? "");
  if (!reading) return false;
  return productNamedApartFromVendor(reading.subject, change.vendor).length === 0;
}

export function deprecationEndsTheListedProduct(change: DeprecationRecord): boolean {
  const cached = endsTheListedProductCache.get(change as object);
  if (cached !== undefined) return cached;
  const decision = decide(change);
  endsTheListedProductCache.set(change as object, decision);
  return decision;
}

function isoFrom(match: RegExpExecArray, pattern: RegExp): string | null {
  const source = pattern.source;
  let year: number;
  let month: number;
  let day: number;
  if (source.startsWith("\\b(\\d{4})")) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (source.startsWith("\\b(january")) {
    year = Number(match[3]);
    month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
    day = Number(match[2]);
  } else {
    year = Number(match[3]);
    month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
    day = Number(match[1]);
  }
  if (!year || !month || !day || month > 12 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function datesAfterPredicate(text: string): string[] {
  const found: string[] = [];
  for (const sentence of sentences(text ?? "")) {
    const match = sentence.match(PREDICATE);
    if (!match || match.index === undefined) continue;
    const tail = sentence.slice(match.index + match[0].length);
    for (const pattern of DATE_PATTERNS) {
      pattern.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = pattern.exec(tail)) !== null) {
        const iso = isoFrom(hit, pattern);
        if (iso) found.push(iso);
      }
    }
  }
  return found;
}

export function discontinuationDate(
  change: Pick<DealChange, "change_type" | "vendor" | "summary" | "current_state">,
): string | null {
  if (!deprecationEndsTheListedProduct(change)) return null;
  const dates = [
    ...datesAfterPredicate(change.summary ?? ""),
    ...datesAfterPredicate(change.current_state ?? ""),
  ];
  if (dates.length === 0) return null;
  return dates.sort().pop() ?? null;
}

export function discontinuedOnOrBefore(
  changes: Array<Pick<DealChange, "change_type" | "vendor" | "summary" | "current_state">>,
  today: string,
): string | null {
  let latestPast: string | null = null;
  for (const change of changes) {
    const date = discontinuationDate(change);
    if (!date || date > today) continue;
    if (latestPast === null || date > latestPast) latestPast = date;
  }
  return latestPast;
}
