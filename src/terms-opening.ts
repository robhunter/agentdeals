export const CLIPPED_TERMS_MARKER = "…";

function withoutTrailingSeparators(text: string): string {
  return text.replace(/[\s,;:—–-]+$/, "");
}

export function unclosedBrackets(text: string): number {
  let open = 0;
  for (const character of text) {
    if (character === "(") open++;
    else if (character === ")" && open > 0) open--;
  }
  return open;
}

function markedAsClipped(text: string): string {
  return `${text}${CLIPPED_TERMS_MARKER}${")".repeat(unclosedBrackets(text))}`;
}

function withoutASeveredNumber(text: string): string {
  let kept = text;
  while (/\d$/.test(kept)) {
    const lastSpace = kept.lastIndexOf(" ");
    if (lastSpace <= 0) break;
    kept = withoutTrailingSeparators(kept.slice(0, lastSpace));
  }
  return kept;
}

function wholeSentencesWithin(text: string, cap: number): string {
  let longest = "";
  for (const match of text.matchAll(/[.!?](\s|$)/g)) {
    const candidate = text.slice(0, match.index + 1);
    if (candidate.length > cap) break;
    longest = candidate;
  }
  return longest;
}

function upToAWordBoundary(text: string, cap: number): string {
  const clipped = text.slice(0, cap);
  const lastSpace = clipped.lastIndexOf(" ");
  return lastSpace > cap / 2 ? clipped.slice(0, lastSpace) : clipped;
}

export function openingOfTerms(terms: string, cap: number): string {
  const text = terms.trim();
  if (text.length <= cap) return text;
  const sentences = wholeSentencesWithin(text, cap);
  const wordBoundary = upToAWordBoundary(text, cap);
  const opening = sentences !== ""
    ? withoutTrailingSeparators(sentences.replace(/[.!?]+$/, ""))
    : withoutASeveredNumber(withoutTrailingSeparators(wordBoundary));
  return markedAsClipped(opening === "" ? wordBoundary : opening);
}

export function punctuated(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function punctuatedOpeningOfTerms(terms: string, cap: number): string {
  return punctuated(openingOfTerms(terms, cap));
}

export function termsWereClipped(opening: string): boolean {
  return opening.replace(/\)+$/, "").endsWith(CLIPPED_TERMS_MARKER);
}
