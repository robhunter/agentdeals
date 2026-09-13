import {
  gradeSuperlatives,
  measuresTheFreeTier,
  outrankedElsewhere,
  pageTables,
  type UngradedClaim,
  type UpheldClaim,
} from "./superlative-claims.js";

export const GENEROSITY_PROSE_TOKEN = "[[generosity-prose]]";
export const GENEROSITY_JSON_TOKEN = "[[generosity-json]]";

export const NO_COLUMN_SETTLES_GENEROSITY =
  "We name no most generous free tier here, because generosity is not one quantity: " +
  "the columns above measure different things and a tier that leads one trails another.";

function biggestFirst(claims: UpheldClaim[]): UpheldClaim[] {
  return claims.filter(({ claim }) => claim.direction === "max");
}


function byColumn(claims: UpheldClaim[]): UpheldClaim[] {
  const kept = new Map<string, UpheldClaim>();
  for (const claim of claims) {
    const key = claim.column.header.toLowerCase();
    const held = kept.get(key);
    if (!held || claim.comparands > held.comparands) kept.set(key, claim);
  }
  return [...kept.values()];
}

function leadClause(claim: UpheldClaim): string {
  return `${claim.subject} leads it with ${claim.held}`;
}

function namedLeadClause(claim: UpheldClaim): string {
  return `${claim.subject} leads on ${claim.column.header} with ${claim.held}`;
}

export function generosityReason(ungraded: UngradedClaim[]): string {
  const ranking = ungraded.filter(({ claim }) => claim.direction !== null);
  if (ranking.length === 0) return "";
  const named = ranking[0]!;
  return ` A badge on this page reads "${named.claim.label}", and we do not repeat it here: ${named.reason}.`;
}

export function generosityAnswer(html: string): string {
  const graded = gradeSuperlatives(html);
  const tables = pageTables(html);
  const standing = biggestFirst(graded.upheld).filter(
    claim => measuresTheFreeTier(claim, tables) && !outrankedElsewhere(claim, tables),
  );
  const leaders = byColumn(standing);
  if (leaders.length === 0) return `${NO_COLUMN_SETTLES_GENEROSITY}${generosityReason(graded.ungraded)}`;
  const sorted = leaders.slice().sort((a, b) => a.column.header.localeCompare(b.column.header));
  if (sorted.length === 1) {
    const only = sorted[0]!;
    return (
      `The one column on this page we can rank is ${only.column.header}, and ${leadClause(only)}. ` +
      `Generosity is not one quantity, so that settles ${only.column.header} and not the free tier as a whole.`
    );
  }
  const clauses = sorted.map(namedLeadClause);
  const joined = `${clauses.slice(0, -1).join("; ")}; and ${clauses[clauses.length - 1]}`;
  return (
    `These free tiers rank differently by column, so there is no single most generous one. ` +
    `${joined}. Each figure is read from a table on this page, and a tier that leads one column trails another.`
  );
}

export function withGenerosityAnswer(
  html: string,
  answerFor: (page: string) => string,
  esc: (s: string) => string,
): string {
  if (!html.includes(GENEROSITY_PROSE_TOKEN) && !html.includes(GENEROSITY_JSON_TOKEN)) return html;
  const answer = answerFor(html);
  return html
    .split(GENEROSITY_PROSE_TOKEN)
    .join(esc(answer))
    .split(GENEROSITY_JSON_TOKEN)
    .join(JSON.stringify(answer).slice(1, -1));
}
