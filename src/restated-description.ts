import { comparableTerms } from "./change-tier.js";

const A_FIGURE = /(^|\s)[^A-Za-z\s]*\d/;

const A_WORD_STATING_TERMS =
  /\b(free|unlimited|plans?|tiers?|pricing|prices?|priced|per|months?|monthly|years?|yearly|annual|credits?|seats?|trial|includes?|included|including|limits?|quota|usage|discount|forever|costs?|paid|upgrade)\b/i;

const A_CLAUSE_ENDING = /\s[—–]\s|\s-\s|(?<=[^\s.])\.\s+|:\s/;

const AN_INITIALISM = /^[A-Za-z](\.[A-Za-z])+$/;

const LONGEST_OPENING_A_HUMAN_WROTE_ABOUT_A_PRODUCT = 120;

export const RESTATEMENT_JOIN = " — ";

function endsOnAnInitialism(clause: string): boolean {
  const last = clause.split(/\s+/).pop() ?? "";
  return AN_INITIALISM.test(last.replace(/^[^A-Za-z]+/, ""));
}

export function statesTerms(text: string): boolean {
  return A_FIGURE.test(text) || A_WORD_STATING_TERMS.test(text);
}

export function saysWhatTheProductIs(clause: string): boolean {
  if (clause.length < 4 || clause.length > LONGEST_OPENING_A_HUMAN_WROTE_ABOUT_A_PRODUCT) return false;
  if (!/[A-Za-z]/.test(clause)) return false;
  return !statesTerms(clause);
}

export function clauseSayingWhatTheProductIs(description: string | null | undefined): string | null {
  const text = (description ?? "").trim();
  const endings = new RegExp(A_CLAUSE_ENDING.source, "g");
  for (let end = endings.exec(text); end; end = endings.exec(text)) {
    const clause = text.slice(0, end.index).trim();
    if (endsOnAnInitialism(clause)) continue;
    return saysWhatTheProductIs(clause) ? clause : null;
  }
  return saysWhatTheProductIs(text) ? text : null;
}

export function restatedDescription(description: string, terms: string): string {
  const clause = clauseSayingWhatTheProductIs(description);
  if (!clause) return terms;
  if (comparableTerms(terms).includes(comparableTerms(clause))) return terms;
  return `${clause}${RESTATEMENT_JOIN}${terms}`;
}
