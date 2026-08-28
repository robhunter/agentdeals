export const REJECT_NULL_COMPARISON = "null_comparison";
export const REJECT_STATES_NO_DIFFERENCE = "states_no_difference";
export const REJECT_NO_PRICE_SIGNAL = "no_price_signal";
export const REJECT_UNQUANTIFIED_LIMIT = "unquantified_limit";
export const REJECT_CONFIRMED_UNCHANGED = "confirmed_unchanged";

export const GATE_REASONS = [
  REJECT_NULL_COMPARISON,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_UNQUANTIFIED_LIMIT,
  REJECT_CONFIRMED_UNCHANGED,
];

const QUANTITY_CHANGE_TYPES = ["limits_reduced", "limits_increased"];

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
  "hour", "minute", "min", "mo", "yr", "total", "maximum", "max", "included", "includes", "include",
  "concurrent", "unlimited", "new", "additional", "more", "than", "only", "each", "all", "other",
  "its", "their", "this", "that", "which", "are", "is", "be", "was", "has", "have", "had",
  "limit", "limits",
]);

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

export function quantifiedAttributes(text) {
  if (typeof text !== "string") return [];
  const attributes = [];
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index + match[0].length;
    const trailing = text.slice(start, start + ATTRIBUTE_WINDOW).toLowerCase();
    const words = [];
    if (/[$€£¥₹]\s?$/.test(text.slice(0, match.index))) words.push(PRICE_ATTRIBUTE);
    for (const word of trailing.split(/[^a-z0-9%]+/).filter(Boolean).slice(0, ATTRIBUTE_WORDS)) {
      const stem = singular(word);
      if (ATTRIBUTE_STOPWORDS.has(word) || ATTRIBUTE_STOPWORDS.has(stem)) continue;
      if (stem.length <= 2) continue;
      words.push(stem);
    }
    if (words.length > 0) attributes.push({ value: match[0], words });
  }
  return attributes;
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
  return AGREEMENT_PHRASES.some((phrase) => lower.includes(phrase));
}

export function describesChange(entry, context = {}) {
  const previous = quantities(entry?.previous_state);
  const current = quantities(entry?.current_state);

  const pageText = context.pageText;
  if (typeof pageText === "string") {
    const signals = priceSignals(pageText);
    if (signals.length < MIN_PRICE_SIGNALS) {
      return {
        ok: false,
        reason: REJECT_NO_PRICE_SIGNAL,
        detail: `the page read carries no price signal — no amount, named tier or metered rate in ${pageText.length} characters, so it states no terms to have changed`,
      };
    }
  }

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
      const stored = unquantified.previous.map((a) => `${a.value} ${a.words[0]}`).join(", ");
      return {
        ok: false,
        reason: REJECT_UNQUANTIFIED_LIMIT,
        detail: `${entry.change_type} claimed, but the current state names no quantity for anything the stored state measured (${stored})`,
      };
    }
  }

  return { ok: true };
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
      } catch { /* fall through */ }
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

export async function gateCandidates(candidates, options = {}) {
  const confirmFn = options.confirmFn;
  const pageTextFor = options.pageTextFor ?? (() => undefined);
  const accepted = [];
  const rejected = [];
  const unchecked = [];

  for (const candidate of candidates) {
    const verdict = describesChange(candidate, { pageText: pageTextFor(candidate) });
    if (!verdict.ok) {
      rejected.push({ candidate, reason: verdict.reason, detail: verdict.detail });
      continue;
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
      rejected.push({
        candidate,
        reason: REJECT_CONFIRMED_UNCHANGED,
        detail: confirmation.reason || "a second pass judged the report to describe no change",
      });
      continue;
    }
    if (confirmation.verdict === "unparsed") {
      unchecked.push({ candidate, error: "second pass returned no usable verdict" });
    }
    accepted.push(candidate);
  }

  return { accepted, rejected, unchecked };
}
