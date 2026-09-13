export type DurabilityGroup = "held" | "narrowed" | "widened" | "unknown";

const GROUP_OF: Record<string, DurabilityGroup> = {
  stable: "held",
  watch: "narrowed",
  volatile: "narrowed",
  improving: "widened",
};

export function durabilityGroupOf(stability: string | null | undefined): DurabilityGroup {
  return stability ? GROUP_OF[stability] ?? "unknown" : "unknown";
}

export interface DurabilitySplit {
  total: number;
  held: number;
  narrowed: number;
  widened: number;
  unknown: number;
}

export function durabilitySplit(stabilities: readonly (string | null | undefined)[]): DurabilitySplit {
  const split: DurabilitySplit = { total: stabilities.length, held: 0, narrowed: 0, widened: 0, unknown: 0 };
  for (const stability of stabilities) split[durabilityGroupOf(stability)] += 1;
  return split;
}

export const DURABILITY_WITHHOLDING_RULE =
  "We withhold the class where the pricing page does not resolve or states no amount, tier or rate we can read, " +
  "where we refused the last read, or where the listing is gated.";

export const DURABILITY_NOT_A_SIZE_RANKING =
  "We do not rank these by how much you get, because the limits are not comparable without reading each vendor's page.";

const PREDICATE: Record<Exclude<DurabilityGroup, "unknown">, string> = {
  held: "no recorded change",
  narrowed: "a recorded narrowing",
  widened: "a recorded widening",
};

const OF_THE_TERMS = " to the terms we publish";

function carry(count: number): string {
  return count === 1 ? "carries" : "carry";
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0]!;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

export interface DurabilityScope {
  where: string;
  columnName: string;
  columnHref: string;
}

export function durabilityDenominatorSentence(split: DurabilitySplit, where: string): string {
  if (split.total === 0) return `No offer meets our criteria ${where} today.`;
  return `${split.total} ${split.total === 1 ? "offer meets" : "offers meet"} our criteria ${where}.`;
}

export function durabilitySplitSentence(split: DurabilitySplit): string {
  const { total, held, narrowed, widened, unknown } = split;
  if (total === 0) return "There is no durability split to publish.";
  const all = total === 1 ? "It carries" : "All of them carry";
  if (unknown === total) return `We publish no durability signal for ${total === 1 ? "it" : "any of them"}.`;
  for (const group of ["held", "narrowed", "widened"] as const) {
    if (split[group] === total) return `${all} ${PREDICATE[group]}${OF_THE_TERMS}.`;
  }
  const counted: [number, string][] = [
    [held, PREDICATE.held],
    [narrowed, PREDICATE.narrowed],
    [widened, PREDICATE.widened],
  ];
  const clauses = counted
    .filter(([count]) => count > 0)
    .map(([count, predicate], i) =>
      i === 0 ? `${count} ${carry(count)} ${predicate}${OF_THE_TERMS}` : `${count} ${predicate}`,
    );
  if (unknown > 0) clauses.push(`we publish no durability signal for ${unknown}`);
  return `Of those, ${joinClauses(clauses)}.`;
}

const COLUMN_SLOT = "{column}";

const WHERE_EACH_OFFER_SITS =
  `The ${COLUMN_SLOT} below says which offer is in which group, and links the dated record behind every change.`;

export const DURABILITY_VERDICT_LEAD = 2;

function slottedSentences(split: DurabilitySplit, scope: DurabilityScope, brief: boolean): string[] {
  const sentences = [durabilityDenominatorSentence(split, scope.where), durabilitySplitSentence(split)];
  if (brief || split.total === 0) return sentences;
  if (split.total > split.unknown) sentences.push(WHERE_EACH_OFFER_SITS);
  if (split.unknown > 0) sentences.push(DURABILITY_WITHHOLDING_RULE);
  sentences.push(DURABILITY_NOT_A_SIZE_RANKING);
  return sentences;
}

function plainSentences(split: DurabilitySplit, scope: DurabilityScope, brief: boolean): string[] {
  const label = `${scope.columnName} column`;
  return slottedSentences(split, scope, brief).map(sentence => sentence.split(COLUMN_SLOT).join(label));
}

function renderHtml(
  split: DurabilitySplit,
  scope: DurabilityScope,
  esc: (s: string) => string,
  brief: boolean,
): string {
  const anchor = `<a href="${scope.columnHref}">${esc(`${scope.columnName} column`)}</a>`;
  const rendered = slottedSentences(split, scope, brief).map(sentence =>
    esc(sentence).split(COLUMN_SLOT).join(anchor),
  );
  const lead = rendered.slice(0, DURABILITY_VERDICT_LEAD).join(" ");
  return [`<strong>${lead}</strong>`, ...rendered.slice(DURABILITY_VERDICT_LEAD)].join(" ");
}

export function durabilityVerdictSentences(split: DurabilitySplit, scope: DurabilityScope): string[] {
  return plainSentences(split, scope, false);
}

export function durabilityVerdictText(split: DurabilitySplit, scope: DurabilityScope): string {
  return durabilityVerdictSentences(split, scope).join(" ");
}

export function durabilityVerdictHtml(
  split: DurabilitySplit,
  scope: DurabilityScope,
  esc: (s: string) => string,
): string {
  return renderHtml(split, scope, esc, false);
}

export function durabilityBriefText(split: DurabilitySplit, scope: DurabilityScope): string {
  return plainSentences(split, scope, true).join(" ");
}

export function durabilityBriefHtml(
  split: DurabilitySplit,
  scope: DurabilityScope,
  esc: (s: string) => string,
): string {
  return renderHtml(split, scope, esc, true);
}
