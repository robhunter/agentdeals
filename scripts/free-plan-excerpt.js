import { tierMayCarryAFreePlanExcerpt } from "../dist/free-tier-record.js";
import { MAX_PAGE_TEXT_LENGTH } from "./verify-freshness.js";

export const FREE_PLAN_EXCERPT = "free_plan_excerpt";
export const MAX_FREE_PLAN_EXCERPT_LENGTH = 400;

export function textTheReaderSees(pageText) {
  return String(pageText ?? "").slice(0, MAX_PAGE_TEXT_LENGTH);
}

export async function readFreePlanExcerpt(client, offer, pageText) {
  return parseExcerptAnswer(await client.complete(excerptPrompt(offer, textTheReaderSees(pageText))));
}

export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  lsquo: String.fromCharCode(0x2018),
  rsquo: String.fromCharCode(0x2019),
  ldquo: String.fromCharCode(0x201c),
  rdquo: String.fromCharCode(0x201d),
  ndash: String.fromCharCode(0x2013),
  mdash: String.fromCharCode(0x2014),
  hellip: String.fromCharCode(0x2026),
  middot: String.fromCharCode(0x00b7),
  euro: String.fromCharCode(0x20ac),
};

function characterOr(codePoint, original) {
  return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : original;
}

export function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (original, hex) => characterOr(parseInt(hex, 16), original))
    .replace(/&#(\d+);/g, (original, decimal) => characterOr(Number(decimal), original))
    .replace(/&([a-z]+);/gi, (original, name) => NAMED_ENTITIES[name.toLowerCase()] ?? original);
}

export function wordsAsThePageRendersThem(text) {
  return collapseWhitespace(decodeEntities(text));
}

const TYPOGRAPHIC_MARKS = new Map([
  ...[0x2018, 0x2019, 0x201a, 0x201b, 0x2032].map((code) => [String.fromCharCode(code), "'"]),
  ...[0x201c, 0x201d, 0x201e, 0x201f, 0x2033].map((code) => [String.fromCharCode(code), "\""]),
  ...[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((code) => [String.fromCharCode(code), "-"]),
]);

export function withPlainMarks(text) {
  return Array.from(text, (character) => TYPOGRAPHIC_MARKS.get(character) ?? character).join("");
}

export function excerptPrompt(offer, pageText) {
  return `You are copying, word for word, the part of a vendor's pricing page that states the terms of its free plan.

THE PLAN:
- Vendor: ${offer.vendor}
- Category: ${offer.category}
- Plan: ${offer.tier}

PAGE TEXT (truncated):
${pageText}

Find the words on this page that state the terms of this plan: its price, an allowance or limit, a credit amount, a duration, or who can get it. Copy them exactly as they appear, as one contiguous stretch of the page of at most ${MAX_FREE_PLAN_EXCERPT_LENGTH} characters. Never reword, never leave out words inside the stretch, and never join words that are apart on the page.

The stretch must state at least one of those terms. Words that only say the product is free or invite the reader to start, such as "Get started for free", words that point to another page, and lists of models or products state no terms. Where the page states the plan's figures, copy those rather than a sentence about the plan.

Copy only this plan's own words: end the stretch before the next plan's name or terms begin. If this plan's words cannot be copied without another plan's, as when a table comparing plans is read row by row, give an empty string.

If the page states no terms for this plan, give an empty string.

Then list each term the stretch states, copied exactly from the stretch.

Respond with exactly one JSON object and no other text:
{"excerpt":"<the words copied from the page, or an empty string>","terms":["<each term the excerpt states, copied from it>"]}`;
}

function termsListed(terms) {
  return Array.isArray(terms) ? terms.filter((term) => typeof term === "string") : [];
}

export function parseExcerptAnswer(raw) {
  const text = typeof raw === "string" ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim() : "";
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidates = first >= 0 && last > first ? [text, text.slice(first, last + 1)] : [text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.excerpt === "string") return { copied: parsed.excerpt, terms: termsListed(parsed.terms) };
    } catch {}
  }
  return { copied: null, why: "the reader's answer could not be parsed" };
}

export function verbatimExcerpt(copied, pageText) {
  const copy = wordsAsThePageRendersThem(copied);
  if (!copy) return { found: false, excerpt: null };
  if (copy.length > MAX_FREE_PLAN_EXCERPT_LENGTH) {
    return { found: true, excerpt: null, why: `the copy runs to ${copy.length} characters, over the ${MAX_FREE_PLAN_EXCERPT_LENGTH} an excerpt may hold` };
  }
  const page = wordsAsThePageRendersThem(pageText);
  const at = withPlainMarks(page).indexOf(withPlainMarks(copy));
  if (at < 0) {
    return { found: true, excerpt: null, why: "the copy is not on the page as the page words it" };
  }
  return { found: true, excerpt: page.slice(at, at + copy.length) };
}

export const COPY_STATES_NO_TERMS = "the copy states none of the plan's terms";

const WORDS_THAT_ONLY_SAY_IT_IS_FREE = new Set([
  "free", "for", "get", "started", "start", "starting", "sign", "signup", "up", "try", "it", "now", "today",
  "deploy", "build", "use", "create", "join", "begin", "launch", "download", "install", "register",
  "no", "cost", "charge", "of", "at", "the", "a", "an", "and", "to", "you", "your", "with", "is", "plan",
]);

function lowerWordsOf(text) {
  return withPlainMarks(wordsAsThePageRendersThem(text)).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function termsTheCopyStates(copy, terms, plan) {
  const copied = withPlainMarks(wordsAsThePageRendersThem(copy)).toLowerCase();
  const namesOfThePlan = new Set([...lowerWordsOf(plan?.vendor), ...lowerWordsOf(plan?.tier)]);
  return (terms ?? []).filter((term) => {
    const named = withPlainMarks(wordsAsThePageRendersThem(term)).toLowerCase();
    if (!named || !copied.includes(named)) return false;
    return lowerWordsOf(named).some((word) => !WORDS_THAT_ONLY_SAY_IT_IS_FREE.has(word) && !namesOfThePlan.has(word));
  });
}

const ASSIGNS_THE_FIELD = new RegExp(`(?:\\b${FREE_PLAN_EXCERPT}\\b|\\[\\s*FREE_PLAN_EXCERPT\\s*\\])\\s*(?:=(?!=)|:)`, "g");

export function assignmentsOfTheExcerpt(source) {
  const found = [];
  for (const match of String(source).matchAll(ASSIGNS_THE_FIELD)) {
    found.push(String(source).slice(0, match.index).split("\n").length);
  }
  return found;
}

export function excerptsDisagreeingWithTheirCitation(offers) {
  const problems = [];
  for (const offer of offers) {
    const excerpt = offer?.[FREE_PLAN_EXCERPT];
    if (excerpt === undefined) continue;
    const name = `${offer.vendor} (${offer.tier})`;
    if (!excerpt || typeof excerpt.text !== "string" || !collapseWhitespace(excerpt.text)) problems.push(`${name}: the excerpt holds no text`);
    else if (excerpt.text.length > MAX_FREE_PLAN_EXCERPT_LENGTH) problems.push(`${name}: the excerpt runs to ${excerpt.text.length} characters`);
    if (excerpt?.url !== offer.url) problems.push(`${name}: the excerpt was read from ${excerpt?.url}, and the record cites ${offer.url}`);
    const checked = offer.source_check?.checked;
    if (typeof excerpt?.read_on !== "string" || !checked || excerpt.read_on > checked) {
      problems.push(`${name}: the excerpt was read on ${excerpt?.read_on}, and the record's last check is ${checked ?? "missing"}`);
    }
  }
  return problems;
}

export function writeFreePlanExcerpt(offer, { copied, terms, pageText, url, readOn }) {
  if (typeof copied !== "string") return { outcome: "unread" };
  const verdict = verbatimExcerpt(copied, pageText);
  if (verdict.excerpt) {
    if (termsTheCopyStates(verdict.excerpt, terms, offer).length === 0) return { outcome: "refused", why: COPY_STATES_NO_TERMS };
    offer[FREE_PLAN_EXCERPT] = { text: verdict.excerpt, url, read_on: readOn };
    return { outcome: "written" };
  }
  if (!verdict.found) {
    const held = FREE_PLAN_EXCERPT in offer;
    delete offer[FREE_PLAN_EXCERPT];
    return { outcome: held ? "removed" : "none" };
  }
  return { outcome: "refused", why: verdict.why };
}

export const TIER_WITH_NO_FREE_PLAN = "the listed tier is not a free plan";

function withNoExcerptForTheTier(record) {
  const held = FREE_PLAN_EXCERPT in record;
  delete record[FREE_PLAN_EXCERPT];
  return { outcome: held ? "removed" : "not_a_free_plan", why: TIER_WITH_NO_FREE_PLAN };
}

export async function excerptTheFreePlan(record, { offer, pageText, read, readOn }) {
  if (!tierMayCarryAFreePlanExcerpt(offer.tier)) return withNoExcerptForTheTier(record);
  let answer;
  try {
    answer = await read(offer, pageText);
  } catch (err) {
    answer = { copied: null, why: err?.message ?? String(err) };
  }
  const result = writeFreePlanExcerpt(record, { copied: answer?.copied, terms: answer?.terms, pageText: textTheReaderSees(pageText), url: offer.url, readOn });
  const copied = typeof answer?.copied === "string" ? answer.copied : null;
  return result.outcome === "unread" ? { ...result, why: answer?.why ?? "no answer", copied } : { ...result, copied };
}
