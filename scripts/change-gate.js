import { pageNamesVendor } from "./vendor-naming.js";

export const REJECT_NULL_COMPARISON = "null_comparison";
export const REJECT_STATES_NO_DIFFERENCE = "states_no_difference";
export const REJECT_NO_PRICE_SIGNAL = "no_price_signal";
export const REJECT_PAGE_NOT_ABOUT_VENDOR = "page_does_not_name_vendor";
export const REJECT_UNQUANTIFIED_LIMIT = "unquantified_limit";
export const REJECT_CONFIRMED_UNCHANGED = "confirmed_unchanged";

export const GATE_REASONS = [
  REJECT_NULL_COMPARISON,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_PAGE_NOT_ABOUT_VENDOR,
  REJECT_UNQUANTIFIED_LIMIT,
  REJECT_CONFIRMED_UNCHANGED,
];

const QUANTITY_CHANGE_TYPES = ["limits_reduced", "limits_increased"];

export const RECLASSIFIED_AS_RESTRUCTURE = "pricing_restructured";

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
    const unitMatch = text.slice(start, start + ATTRIBUTE_WINDOW).match(UNIT_AFTER_NUMBER);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : null;
    if (words.length > 0) attributes.push({ value: match[0], words, unit });
  }
  return attributes;
}

export function measuredWord(attribute) {
  return (attribute?.words ?? []).find((word) => !BYTE_UNITS.has(word)) ?? null;
}

export function normalizedMagnitude(attribute) {
  const scale = BYTE_UNITS.get(attribute?.unit ?? "");
  if (scale === undefined) return null;
  const value = Number(String(attribute.value).replace(/,/g, ""));
  return Number.isFinite(value) ? value * scale : null;
}

export function measuredDifferences(entry) {
  const previous = quantifiedAttributes(entry?.previous_state);
  const current = quantifiedAttributes(entry?.current_state);
  const differences = [];
  for (const before of previous) {
    const word = measuredWord(before);
    const from = normalizedMagnitude(before);
    if (!word || from === null) continue;
    for (const after of current) {
      if (measuredWord(after) !== word) continue;
      const to = normalizedMagnitude(after);
      if (to === null || to === from) continue;
      differences.push({
        attribute: word,
        previous: `${before.value} ${before.unit}`,
        current: `${after.value} ${after.unit}`,
        from,
        to,
        direction: to > from ? "increase" : "decrease",
      });
    }
  }
  return differences;
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
  return AGREEMENT_PHRASES.some((phrase) => lower.includes(phrase));
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
        const missing = gone.map((a) => `${a.value} ${a.measured}`).join(", ");
        return {
          ok: true,
          reclassifyAs: RECLASSIFIED_AS_RESTRUCTURE,
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

export function describesQuantifiedDifference(entry) {
  return measuredDifferences(entry)[0] ?? null;
}

export async function gateCandidates(candidates, options = {}) {
  const confirmFn = options.confirmFn;
  const pageTextFor = options.pageTextFor ?? (() => undefined);
  const pageCompleteFor = options.pageCompleteFor ?? (() => false);
  const accepted = [];
  const rejected = [];
  const unchecked = [];
  const reclassified = [];
  const overruled = [];

  for (const original of candidates) {
    const verdict = describesChange(original, {
      pageText: pageTextFor(original),
      pageComplete: pageCompleteFor(original),
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
        detail: `the two states measure ${difference.attribute} at ${difference.previous} and ${difference.current}, a ${difference.direction} from ${difference.from.toLocaleString("en-US")} to ${difference.to.toLocaleString("en-US")} bytes`,
      });
      accepted.push(candidate);
      continue;
    }
    if (confirmation.verdict === "unparsed") {
      unchecked.push({ candidate, error: "second pass returned no usable verdict" });
    }
    accepted.push(candidate);
  }

  return { accepted, rejected, unchecked, reclassified, overruled };
}
