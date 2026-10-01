import { tierMayCarryAFreePlanExcerpt } from "../dist/free-tier-record.js";
import { isNoLongerInForce } from "../dist/change-resolution.js";
import { MAX_PAGE_TEXT_LENGTH } from "./verify-freshness.js";

export const FREE_PLAN_EXCERPT = "free_plan_excerpt";
export const FREE_PLAN_EXCERPT_HOLD = "free_plan_excerpt_hold";
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

The stretch must state at least one of those terms. Words that only say the product is free or invite the reader to start, such as "Get started for free", words that point to another page, and lists of models or products state no terms.

Copy only this plan's own words: end the stretch before the next plan's name or terms begin. If this plan's words cannot be copied without another plan's, as when a table comparing plans is read row by row, give an empty string.

If the page states no terms for this plan, give an empty string.

Then list each term the stretch states, copied exactly from the stretch, and name every other plan whose words the stretch holds, as the page names it.

Respond with exactly one JSON object and no other text:
{"excerpt":"<the words copied from the page, or an empty string>","terms":["<each term the excerpt states, copied from it>"],"other_plans":["<each other plan whose words the excerpt holds>"]}`;
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
      if (parsed && typeof parsed === "object" && typeof parsed.excerpt === "string") {
        return { copied: parsed.excerpt, terms: termsListed(parsed.terms), otherPlans: termsListed(parsed.other_plans) };
      }
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

export const COPY_HOLDS_ANOTHER_PLAN = "the copy holds another plan's words";

const A_FIGURE = /(?:^|[^\p{L}\p{N}])\d/u;

const WORDS_THAT_STATE_A_TERM = new Set([
  "unlimited", "limited", "limit", "limits", "forever", "lifetime",
  "credit", "credits", "card", "payment", "registration", "signup", "verification", "verified",
  "personal", "individual", "individuals", "commercial", "noncommercial", "student", "students", "education", "educational",
  "academic", "nonprofit", "nonprofits", "startup", "startups", "eligible", "eligibility",
  "month", "months", "monthly", "day", "days", "daily", "week", "weeks", "weekly", "year", "years", "yearly", "annual", "annually",
  "hour", "hours", "minute", "minutes",
]);

function asTheCheckReadsIt(text) {
  return withPlainMarks(wordsAsThePageRendersThem(text)).toLowerCase();
}

function withoutTheNamesOf(text, plan) {
  return [plan?.vendor, plan?.tier]
    .map(asTheCheckReadsIt)
    .filter(Boolean)
    .reduce((rest, name) => rest.split(name).join(" "), text);
}

function statesATerm(term, plan) {
  const rest = withoutTheNamesOf(term, plan);
  return A_FIGURE.test(rest) || (rest.match(/[\p{L}\p{N}]+/gu) ?? []).some((word) => WORDS_THAT_STATE_A_TERM.has(word));
}

export function termsTheCopyStates(copy, terms, plan) {
  const copied = asTheCheckReadsIt(copy);
  return (terms ?? []).filter((term) => {
    const named = asTheCheckReadsIt(term);
    return Boolean(named) && copied.includes(named) && statesATerm(named, plan);
  });
}

function escapedForARegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function otherPlansTheCopyHolds(copy, otherPlans, plan) {
  const copied = asTheCheckReadsIt(copy);
  const ownName = asTheCheckReadsIt(plan?.tier);
  return (otherPlans ?? []).filter((name) => {
    const named = asTheCheckReadsIt(name);
    if (!named || named === ownName) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapedForARegExp(named)}(?![\\p{L}\\p{N}])`, "u").test(copied);
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

function answerToWrite(offer, { copied, terms, otherPlans, pageText }) {
  if (typeof copied !== "string") return { outcome: "unread" };
  const verdict = verbatimExcerpt(copied, pageText);
  if (verdict.excerpt) {
    const neighbours = otherPlansTheCopyHolds(verdict.excerpt, otherPlans, offer);
    if (neighbours.length > 0) return { outcome: "refused", why: `${COPY_HOLDS_ANOTHER_PLAN}: ${neighbours.join(", ")}` };
    if (termsTheCopyStates(verdict.excerpt, terms, offer).length === 0) return { outcome: "refused", why: COPY_STATES_NO_TERMS };
    return { outcome: "written", excerpt: verdict.excerpt };
  }
  if (!verdict.found) return { outcome: "none" };
  return { outcome: "refused", why: verdict.why };
}

function keepTheHeldExcerptOnlyIfThePageStillSaysIt(offer, { pageText, url, readOn }) {
  const held = offer[FREE_PLAN_EXCERPT];
  if (verbatimExcerpt(held?.text, pageText).excerpt) {
    offer[FREE_PLAN_EXCERPT] = { ...held, url, read_on: readOn };
    return "kept";
  }
  delete offer[FREE_PLAN_EXCERPT];
  return "removed";
}

export function writeFreePlanExcerpt(offer, { copied, terms, otherPlans, pageText, url, readOn }) {
  const { excerpt, ...answer } = answerToWrite(offer, { copied, terms, otherPlans, pageText });
  if (excerpt) {
    offer[FREE_PLAN_EXCERPT] = { text: excerpt, url, read_on: readOn };
    return answer;
  }
  if (!(FREE_PLAN_EXCERPT in offer)) return answer;
  return { ...answer, held_excerpt: keepTheHeldExcerptOnlyIfThePageStillSaysIt(offer, { pageText, url, readOn }) };
}

export const TIER_WITH_NO_FREE_PLAN = "the listed tier is not a free plan";

function withNoExcerptForTheTier(record) {
  const held = FREE_PLAN_EXCERPT in record;
  delete record[FREE_PLAN_EXCERPT];
  return { outcome: held ? "removed" : "not_a_free_plan", why: TIER_WITH_NO_FREE_PLAN };
}

export function holdOnTheExcerpt(hold) {
  return `a hold names the ${hold.change_type} record of ${hold.record_date}: ${hold.reason}`;
}

function withNoExcerptWhileHeld(record) {
  const held = FREE_PLAN_EXCERPT in record;
  delete record[FREE_PLAN_EXCERPT];
  return { outcome: held ? "removed" : "on_hold", why: holdOnTheExcerpt(record[FREE_PLAN_EXCERPT_HOLD]) };
}

export function excerptHoldsNamingNoRecordInForce(offers, changes) {
  const problems = [];
  for (const offer of offers) {
    const hold = offer?.[FREE_PLAN_EXCERPT_HOLD];
    if (hold === undefined) continue;
    const name = `${offer.vendor} (${offer.tier})`;
    if (!hold || typeof hold.reason !== "string" || !collapseWhitespace(hold.reason)) problems.push(`${name}: the hold gives no reason`);
    const named = changes.filter((change) => change.vendor === offer.vendor && change.change_type === hold?.change_type && change.date === hold?.record_date);
    if (named.length === 0) problems.push(`${name}: the hold names no ${hold?.change_type} record of ${hold?.record_date}`);
    else if (named.every(isNoLongerInForce)) problems.push(`${name}: the ${hold.change_type} record of ${hold.record_date} that the hold names is no longer in force`);
  }
  return problems;
}

export async function excerptTheFreePlan(record, { offer, pageText, read, readOn }) {
  if (record[FREE_PLAN_EXCERPT_HOLD]) return withNoExcerptWhileHeld(record);
  if (!tierMayCarryAFreePlanExcerpt(offer.tier)) return withNoExcerptForTheTier(record);
  let answer;
  try {
    answer = await read(offer, pageText);
  } catch (err) {
    answer = { copied: null, why: err?.message ?? String(err) };
  }
  const result = writeFreePlanExcerpt(record, { copied: answer?.copied, terms: answer?.terms, otherPlans: answer?.otherPlans, pageText: textTheReaderSees(pageText), url: offer.url, readOn });
  const copied = typeof answer?.copied === "string" ? answer.copied : null;
  return result.outcome === "unread" ? { ...result, why: answer?.why ?? "no answer", copied } : { ...result, copied };
}
