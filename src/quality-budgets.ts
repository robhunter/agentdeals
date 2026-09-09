import { QUALITY_BUDGET_NAMES, aDataRunMayRaise, type QualityBudgetName } from "./page-reviews.js";

export const BUDGET_REPORT_MARKER = "quality-budget-report";

export const BUDGET_REPORT_TITLE = "A quality budget is over its ceiling";

export interface BudgetMeasurement {
  name: QualityBudgetName;
  budget: number;
  measured: number;
  cohort: string[];
}

export interface BudgetReportContext {
  measured_for: string;
  run_url?: string;
  commit?: string;
}

export const COHORT_SHOWN = 25;

export function overBudget(measurements: readonly BudgetMeasurement[]): BudgetMeasurement[] {
  return measurements.filter(m => m.measured > m.budget && !aDataRunMayRaise(m.name));
}

export function measurementsFrom(
  budgets: Record<QualityBudgetName, number>,
  measured: Record<string, number | undefined>,
  cohorts: Record<string, string[] | undefined> = {},
): BudgetMeasurement[] {
  const out: BudgetMeasurement[] = [];
  for (const name of QUALITY_BUDGET_NAMES) {
    const count = measured[name];
    if (typeof count !== "number") continue;
    out.push({ name, budget: budgets[name], measured: count, cohort: cohorts[name] ?? [] });
  }
  return out;
}

function cohortLines(cohort: readonly string[]): string[] {
  if (cohort.length === 0) return ["  The measurement names no entries."];
  const shown = cohort.slice(0, COHORT_SHOWN);
  const lines = shown.map(entry => `  - ${entry}`);
  if (cohort.length > shown.length) {
    lines.push(`  - …and ${cohort.length - shown.length} more.`);
  }
  return lines;
}

function verdictLine(m: BudgetMeasurement): string {
  if (m.measured > m.budget) return `**${m.measured - m.budget} over** a ceiling of ${m.budget}`;
  if (m.measured < m.budget) return `${m.budget - m.measured} under a ceiling of ${m.budget}`;
  return `at its ceiling of ${m.budget}`;
}

export function budgetReportBody(
  measurements: readonly BudgetMeasurement[],
  context: BudgetReportContext,
): string {
  const over = overBudget(measurements);
  const lines: string[] = [];
  lines.push(
    over.length === 0
      ? `Every quality budget measured on ${context.measured_for} is at or under its ceiling.`
      : `${over.length} quality ${over.length === 1 ? "budget is" : "budgets are"} over ceiling, measured on ${context.measured_for}.`,
  );
  lines.push("");
  lines.push(
    "These are counts of editorial debt: entries nobody has read yet, not entries anyone has shown to be wrong. " +
      "A ceiling may fall on its own and rises only by a deliberate edit to `data/quality_budgets.json`. " +
      "None of them fails the suite, so this is where the number is read.",
  );
  lines.push("");
  for (const m of over) {
    lines.push(`### \`${m.name}\` — ${verdictLine(m)}`);
    lines.push("");
    lines.push(...cohortLines(m.cohort));
    lines.push("");
  }
  lines.push("| budget | ceiling | measured |");
  lines.push("|---|---|---|");
  for (const m of measurements) {
    const flag = m.measured > m.budget ? " ⚠" : "";
    lines.push(`| \`${m.name}\` | ${m.budget} | ${m.measured}${flag} |`);
  }
  const unmeasured = QUALITY_BUDGET_NAMES.filter(n => !measurements.some(m => m.name === n));
  if (unmeasured.length > 0) {
    lines.push("");
    lines.push(`Not measured by this run: ${unmeasured.map(n => `\`${n}\``).join(", ")}.`);
  }
  lines.push("");
  if (context.commit) lines.push(`Measured on \`${context.commit}\`.`);
  if (context.run_url) lines.push(`The run: ${context.run_url}`);
  if (over.length > 0) {
    lines.push("");
    lines.push(
      "To clear one: fix the entries above, then `npm run ratchet:budgets` to bring the ceiling down to what the data now measures.",
    );
  }
  lines.push("");
  lines.push(`<!-- ${BUDGET_REPORT_MARKER} -->`);
  return `${lines.join("\n")}\n`;
}
