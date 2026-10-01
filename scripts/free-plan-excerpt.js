export const FREE_PLAN_EXCERPT = "free_plan_excerpt";
export const MAX_FREE_PLAN_EXCERPT_LENGTH = 400;

export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
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
