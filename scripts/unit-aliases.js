const EQUATION =
  /(?:^|[^\w.])1\s+([a-z][a-z\s/-]{0,60}?)\s*(?:=|equals|is\s+equal\s+to)\s*1\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})/gi;

const EXPANSION_THEN_ABBREVIATION =
  /\b([a-z][a-z-]*(?:\s+[a-z][a-z-]*){1,4})\s*\(\s*([A-Za-z]{2,6})s?\s*\)/g;

const ABBREVIATION_THEN_EXPANSION =
  /\b([A-Z]{2,6})s?\s*\(\s*([a-z][a-z-]*(?:\s+[a-z][a-z-]*){1,4})\s*\)/g;

export const FORM_EQUATION = "equation";
export const FORM_ABBREVIATION = "abbreviation";

const CONNECTIVES = new Set(["or", "and", "of", "per", "the", "a", "an", "to", "for"]);

function isAConnective(token) {
  return CONNECTIVES.has(token.toLowerCase());
}

function expansionSpelling(expansion, abbreviation) {
  const letters = abbreviation.toLowerCase();
  if (letters.length < 2) return null;
  const tokens = expansion.split(/\s+/).filter(Boolean);
  let needed = letters.length;
  let start = tokens.length;
  while (start > 0 && needed > 0) {
    start--;
    if (!isAConnective(tokens[start])) needed--;
  }
  if (needed > 0) return null;
  const phrase = tokens.slice(start);
  const initials = phrase
    .filter((token) => !isAConnective(token))
    .map((token) => token.toLowerCase().charAt(0))
    .join("");
  return initials === letters ? phrase.join(" ") : null;
}

function tidy(phrase) {
  return phrase.replace(/\s+/g, " ").trim();
}

function push(into, seen, left, right, form) {
  const pair = { left: tidy(left), right: tidy(right), form };
  if (!pair.left || !pair.right) return;
  const key = `${pair.left}|${pair.right}|${form}`;
  if (seen.has(key)) return;
  seen.add(key);
  into.push(pair);
}

export function definedEquivalences(pageText) {
  if (typeof pageText !== "string") return [];
  const found = [];
  const seen = new Set();

  for (const match of pageText.matchAll(EQUATION)) {
    push(found, seen, match[1], match[2], FORM_EQUATION);
  }
  for (const match of pageText.matchAll(EXPANSION_THEN_ABBREVIATION)) {
    const expansion = expansionSpelling(match[1], match[2]);
    if (expansion) push(found, seen, expansion, match[2], FORM_ABBREVIATION);
  }
  for (const match of pageText.matchAll(ABBREVIATION_THEN_EXPANSION)) {
    const expansion = expansionSpelling(match[2], match[1]);
    if (expansion) push(found, seen, expansion, match[1], FORM_ABBREVIATION);
  }
  return found;
}
