const TIME_UNITS: Record<string, string> = {
  sec: "sec",
  secs: "sec",
  second: "sec",
  seconds: "sec",
  min: "min",
  mins: "min",
  minute: "min",
  minutes: "min",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  day: "day",
  days: "day",
  wk: "week",
  week: "week",
  weeks: "week",
  mo: "mo",
  month: "mo",
  months: "mo",
  yr: "yr",
  year: "yr",
  years: "yr",
};

const ADVERB_UNITS: Record<string, string> = {
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "mo",
  yearly: "yr",
  annually: "yr",
};

const PLURAL_UNITS: Record<string, string> = {
  sec: "seconds",
  min: "minutes",
  hour: "hours",
  day: "days",
  week: "weeks",
  mo: "months",
  yr: "years",
};

const SLASH_PERIOD = /^\/(\d[\d,]*)?\s*([a-z]+)(?:\/([a-z]+))?/i;
const WORDED_PERIOD = /^(?:\s+for)?(?:\s+free)?\s+(?:per|a|an|every)\s+(?:(\d[\d,]*)[\s-]*)?([a-z]+)/i;
const ADVERB_PERIOD = /^(?:\s+for)?(?:\s+free)?\s+(hourly|daily|weekly|monthly|yearly|annually)\b/i;
const SCOPE_SUFFIX = /^\s+per\s+([a-z]+)/i;
const NON_RATE_QUALIFIER = /^\s+of\s+((?!and\b)[a-z]+(?:\s+(?!and\b)[a-z]+){0,2})/i;

export type LimitPeriod = {
  unit: string;
  count?: string;
  scope?: string;
  length: number;
};

function timeUnit(word: string | undefined): string | undefined {
  return word ? TIME_UNITS[word.toLowerCase()] : undefined;
}

export function readPeriod(rest: string): LimitPeriod | null {
  const slash = rest.match(SLASH_PERIOD);
  if (slash) {
    const direct = timeUnit(slash[2]);
    if (direct) {
      return withScope(rest, { unit: direct, count: slash[1], length: slash[0].length });
    }
    const scoped = timeUnit(slash[3]);
    if (scoped) {
      return { unit: scoped, count: slash[1], scope: slash[2], length: slash[0].length };
    }
    return null;
  }

  const worded = rest.match(WORDED_PERIOD);
  const wordedUnit = worded ? timeUnit(worded[2]) : undefined;
  if (worded && wordedUnit) {
    return withScope(rest, { unit: wordedUnit, count: worded[1], length: worded[0].length });
  }

  const adverb = rest.match(ADVERB_PERIOD);
  if (adverb) {
    return withScope(rest, { unit: ADVERB_UNITS[adverb[1].toLowerCase()], length: adverb[0].length });
  }

  return null;
}

function withScope(rest: string, period: LimitPeriod): LimitPeriod {
  const scope = rest.slice(period.length).match(SCOPE_SUFFIX);
  if (!scope) return period;
  return { ...period, scope: scope[1], length: period.length + scope[0].length };
}

export function renderPeriod(period: LimitPeriod): string {
  const base = period.count
    ? ` per ${period.count} ${PLURAL_UNITS[period.unit]}`
    : `/${period.unit}`;
  return period.scope ? `${base} per ${period.scope}` : base;
}

export function readRateLimit(description: string, match: RegExpMatchArray): string {
  const quantity = match[1];
  const noun = match[2];
  const rest = description.slice((match.index ?? 0) + match[0].length);
  const period = readPeriod(rest);
  if (period) return `${quantity} ${noun}${renderPeriod(period)}`;
  const qualifier = rest.match(NON_RATE_QUALIFIER);
  if (qualifier) return `${quantity} ${noun} of ${qualifier[1]}`;
  return `${quantity} ${noun}`;
}

type LimitPattern = {
  regex: RegExp;
  unit: string;
  format: (m: RegExpMatchArray, description: string) => string;
};

const NOT_INSIDE_A_WORD_OR_A_FIGURE = "(?<![\\p{L}\\p{N}.\\-])(?<!\\p{N},)";
const NOT_A_PRICE_UNIT = "(?<!\\bper\\s+)";
const A_WHOLE_NUMBER = "\\d[\\d,]*";
const A_DECIMAL = `${A_WHOLE_NUMBER}(?:\\.\\d+)?`;
const A_COUNT_IN_THOUSANDS = `${A_DECIMAL}k?`;

function aLimitOf(figure: string, nouns: string): RegExp {
  return new RegExp(`${NOT_INSIDE_A_WORD_OR_A_FIGURE}${NOT_A_PRICE_UNIT}(${figure}(?:\\s*[-–]\\s*${figure})?)\\s*${nouns}`, "iu");
}

export const LIMIT_PATTERNS: LimitPattern[] = [
  {
    regex: aLimitOf(A_DECIMAL, "(gb|gib)\\s*(storage|data|disk)"),
    unit: "storage",
    format: (m) => `${m[1]} ${m[2].toUpperCase()} storage`,
  },
  {
    regex: aLimitOf(A_DECIMAL, "(gb|gib)\\s*(bandwidth|transfer|egress)"),
    unit: "bandwidth",
    format: (m) => `${m[1]} ${m[2].toUpperCase()} bandwidth`,
  },
  {
    regex: aLimitOf(A_COUNT_IN_THOUSANDS, "(mau|monthly active users)"),
    unit: "users",
    format: (m) => `${m[1]} MAU`,
  },
  {
    regex: aLimitOf(A_COUNT_IN_THOUSANDS, "(api\\s*calls|requests|invocations|events|emails|messages)"),
    unit: "requests",
    format: (m, description) => readRateLimit(description, m),
  },
  {
    regex: aLimitOf(A_WHOLE_NUMBER, "(projects?|repos?|sites?|apps?|databases?|instances?)"),
    unit: "projects",
    format: (m) => `${m[1]} ${m[2]}`,
  },
];

const REPORTS_WHAT_A_PAGE_ADVERTISES = /\badvertis(?:es|ed)\b/i;

function clausesThatStateTheTerms(description: string): string {
  const clauses = description.split(/(?<=[.!?])\s+|;\s+/);
  const stated = clauses.filter((clause) => !REPORTS_WHAT_A_PAGE_ADVERTISES.test(clause));
  return stated.length === clauses.length ? description : stated.join(" ");
}

export function growthLimitPhrases(description: string): string[] {
  const stated = clausesThatStateTheTerms(description);
  const phrases: string[] = [];
  for (const pattern of LIMIT_PATTERNS) {
    const m = stated.match(pattern.regex);
    if (m) phrases.push(pattern.format(m, stated));
  }
  return phrases;
}
