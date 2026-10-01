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

export function excerptPrompt(offer, pageText) {
  return `You are copying, word for word, the part of a vendor's pricing page that states the terms of its free plan.

THE PLAN:
- Vendor: ${offer.vendor}
- Category: ${offer.category}
- Plan: ${offer.tier}

PAGE TEXT (truncated):
${pageText}

Find the words on this page that state the terms of this vendor's free plan: its price, its limits, what it includes and who can get it. Copy them exactly as they appear, as one contiguous stretch of the page of at most ${MAX_FREE_PLAN_EXCERPT_LENGTH} characters. Never reword, never leave out words inside the stretch, and never join words that are apart on the page. If the page does not state a free plan for this vendor, give an empty string.

Respond with exactly one JSON object and no other text:
{"excerpt":"<the words copied from the page, or an empty string>"}`;
}

export function parseExcerptAnswer(raw) {
  const text = typeof raw === "string" ? raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim() : "";
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidates = first >= 0 && last > first ? [text, text.slice(first, last + 1)] : [text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.excerpt === "string") return { copied: parsed.excerpt };
    } catch {}
  }
  return { copied: null, why: "the reader's answer could not be parsed" };
}

export function verbatimExcerpt(copied, pageText) {
  const text = collapseWhitespace(copied);
  if (!text) return { found: false, excerpt: null };
  if (text.length > MAX_FREE_PLAN_EXCERPT_LENGTH) {
    return { found: true, excerpt: null, why: `the copy runs to ${text.length} characters, over the ${MAX_FREE_PLAN_EXCERPT_LENGTH} an excerpt may hold` };
  }
  if (!collapseWhitespace(pageText).includes(text)) {
    return { found: true, excerpt: null, why: "the copy is not on the page as the page words it" };
  }
  return { found: true, excerpt: text };
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

export function writeFreePlanExcerpt(offer, { copied, pageText, url, readOn }) {
  if (typeof copied !== "string") return { outcome: "unread" };
  const verdict = verbatimExcerpt(copied, pageText);
  if (verdict.excerpt) {
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
