import { QUALITY_BUDGET_NAMES, aDataRunMayRaise, type QualityBudgetName } from "../src/page-reviews.ts";

const EQUALITY = /assert\.(?:strictEqual|deepStrictEqual|equal|deepEqual)\(/g;

const BASELINE_CONSTANTS = [
  "STALE_FACT_PAGES_BASELINE",
  "UNSOURCED_TIER_A_BASELINE",
  "UNCITED_CHANGE_RECORDS_BASELINE",
  "FAQ_BASELINE",
];

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

export interface HeldAgainstABudget {
  line: number;
  text: string;
}

function operandsOf(source: string, open: number): string[] | null {
  const operands: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let at = open; at < source.length; at++) {
    const char = source[at];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        operands.push(source.slice(from, at));
        return operands;
      }
    } else if (char === "," && depth === 1) {
      operands.push(source.slice(from, at));
      from = at + 1;
    } else if (char === '"' || char === "'" || char === "`") {
      for (at++; at < source.length && source[at] !== char; at++) if (source[at] === "\\") at++;
    }
  }
  return null;
}

export function readsTheBudgetsFile(operand: string): boolean {
  const text = operand.trim();
  if (!IDENTIFIER_PATH.test(text)) return false;
  const segments = text.split(".");
  if (BASELINE_CONSTANTS.includes(segments[0]!)) return true;
  if (segments.includes("budgets") && segments.at(-1) !== "budgets") return true;
  return segments[0] === "budgets" && (QUALITY_BUDGET_NAMES as readonly string[]).includes(segments.at(-1)!);
}

export function budgetsHeldAgainstAMeasurement(source: string): HeldAgainstABudget[] {
  const found: HeldAgainstABudget[] = [];
  for (const call of source.matchAll(EQUALITY)) {
    const operands = operandsOf(source, call.index + call[0].length - 1);
    if (!operands) continue;
    const compared = operands.slice(0, 2);
    if (!compared.some(readsTheBudgetsFile) || compared.every(readsTheBudgetsFile)) continue;
    found.push({
      line: source.slice(0, call.index).split("\n").length,
      text: compared.join(",").replace(/\s+/g, " ").trim().slice(0, 90),
    });
  }
  return found;
}

const TAKES_A_BUDGET_BY_DEFAULT: Record<string, number> = {
  staleFactViolations: 4,
  pageSourceViolations: 3,
};

export function callsThatLetTheBudgetDefault(source: string): HeldAgainstABudget[] {
  const found: HeldAgainstABudget[] = [];
  for (const [name, arity] of Object.entries(TAKES_A_BUDGET_BY_DEFAULT)) {
    for (const call of source.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
      const operands = operandsOf(source, call.index + call[0].length - 1);
      if (!operands || operands.length >= arity) continue;
      found.push({
        line: source.slice(0, call.index).split("\n").length,
        text: `${name}(${operands.join(",").replace(/\s+/g, " ").trim().slice(0, 70)})`,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

const CEILING = /assert\.ok\(/g;

const COMPARISON = /[<>]=?/;

const NAMED_BUDGET = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*qualityBudget\(\s*"([a-z_]+)"\s*\)/g;

const INLINE_BUDGET = /\bqualityBudget\(\s*"([a-z_]+)"\s*\)/g;

const BUDGET_BEHIND_A_CONSTANT: Record<string, QualityBudgetName> = {
  STALE_FACT_PAGES_BASELINE: "stale_fact_pages",
  UNSOURCED_TIER_A_BASELINE: "unsourced_tier_a",
  UNCITED_CHANGE_RECORDS_BASELINE: "uncited_change_records",
};

export function ceilingsHeldAgainstABudget(source: string): HeldAgainstABudget[] {
  const behindALocal = new Map<string, string>();
  for (const declaration of source.matchAll(NAMED_BUDGET)) behindALocal.set(declaration[1]!, declaration[2]!);

  const found: HeldAgainstABudget[] = [];
  for (const call of source.matchAll(CEILING)) {
    const operands = operandsOf(source, call.index + call[0].length - 1);
    if (!operands) continue;
    const condition = operands[0]!;
    if (!COMPARISON.test(condition)) continue;
    const named = new Set<string>();
    for (const inline of condition.matchAll(INLINE_BUDGET)) named.add(inline[1]!);
    for (const word of condition.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const behind = behindALocal.get(word[0]) ?? BUDGET_BEHIND_A_CONSTANT[word[0]];
      if (behind) named.add(behind);
    }
    const holding = [...named].filter(name => !aDataRunMayRaise(name as QualityBudgetName));
    if (holding.length === 0) continue;
    found.push({
      line: source.slice(0, call.index).split("\n").length,
      text: `${condition.replace(/\s+/g, " ").trim().slice(0, 70)} — ${holding.join(", ")}`,
    });
  }
  return found;
}

export const WIRING_CHECKS = `assert.strictEqual(FAQ_BASELINE.answers, budgets.faq_answers);
assert.strictEqual(STALE_FACT_PAGES_BASELINE, shipped.budgets.stale_fact_pages);`;

export const RATCHETS = `assert.strictEqual(answers.length, FAQ_BASELINE.answers);
assert.strictEqual(frozen, FAQ_BASELINE.stating_a_figure);
assert.strictEqual(UNSOURCED_TIER_A_BASELINE, unsourcedTierAPaths(shipped).length);`;

export const MEASUREMENTS_COMPARED_TO_EACH_OTHER = `assert.strictEqual(census.records_with_superseded_terms, supersededRecords().length);
assert.strictEqual(next.stale_fact_pages, 57);`;

export const A_BUDGET_REACHED_THROUGH_A_DEFAULT = `assert.deepStrictEqual(staleFactViolations(pages, TODAY, changeDateFor), []);
assert.deepStrictEqual(pageSourceViolations(pages, measured), []);`;

export const A_BUDGET_PASSED_IN = `assert.deepStrictEqual(staleFactViolations(pages, TODAY, moved, 1), []);
assert.deepStrictEqual(pageSourceViolations(pages, measured, unsourcedTierAPaths(pages).length), []);`;

export const CEILINGS_ON_A_BUDGET_THAT_HOLDS_A_COMMIT = `const budget = qualityBudget("uncited_change_records");
assert.ok(measured <= budget, "over budget");
assert.ok(offers.filter(f).length <= qualityBudget("source_checks_ok_without_quoted_evidence"));
assert.ok(unsourced.length <= UNSOURCED_TIER_A_BASELINE);`;

export const CEILINGS_A_DATA_RUN_RAISES_IN_THE_SAME_COMMIT = `const budget = qualityBudget("records_with_superseded_terms");
assert.ok(measured <= budget, "over the recorded count");
assert.ok(atRest <= qualityBudget("ungated_pages_withholding_superseded_terms"));
assert.ok(shipped.length > 60, "only a few pages on the register");`;
