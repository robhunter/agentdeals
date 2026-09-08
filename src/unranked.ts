import { CRITERIA_PATH } from "./ranking.js";

export const NO_RANKING_HELD =
  "We publish no ranking of these. Nothing we record measures popularity or generosity, so naming a best or a top few would be our preference rather than our data.";

export interface UnrankedField {
  noun: string;
  size: number;
  whereToLook: string;
  basis?: string;
}

export function unrankedBestAnswer(field: UnrankedField): string | null {
  if (field.size < 1) return null;
  const basis = field.basis ? ` ${field.basis}` : "";
  return `${NO_RANKING_HELD} We hold ${field.size} ${field.noun}, ${field.whereToLook}.${basis} Our ranking rule is published at ${CRITERIA_PATH}.`;
}

export function unrankedListingBasis(qualified: number, demoted: number, gated: number): string {
  const clauses: string[] = [];
  if (qualified === 1) clauses.push("1 carries no recorded demerit");
  if (qualified > 1) {
    clauses.push(`${qualified} carry no recorded demerit and are indistinguishable under every signal we hold, so their order rotates daily`);
  }
  if (demoted > 0) clauses.push(`${demoted} ${demoted === 1 ? "is" : "are"} demoted with the reason named`);
  if (gated > 0) clauses.push(`${gated} ${gated === 1 ? "is" : "are"} listed last behind a stated gate`);
  return clauses.length === 0 ? "" : `Of those, ${clauses.join(", ")}.`;
}

export function statedFreeTierBasis(stating: number, denying: number): string {
  if (denying < 1) return "";
  return `${stating} of them state a free tier we hold as current and ${denying} ${denying === 1 ? "does" : "do"} not — the tier column says which.`;
}
