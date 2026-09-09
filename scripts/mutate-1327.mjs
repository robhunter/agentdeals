import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/stale-page-facts.test.ts",
  "test/quality-budget-report.test.ts",
  "test/page-data-provenance.test.ts",
  "test/faq-provenance.test.ts",
];

const MUTANTS = [
  ["a-failed-review-restarts-the-staleness-clock", "src/page-reviews.ts",
    '  const clockStarts = reviewedAt !== null && record.review_outcome === "fail" ? record.published : lastRead;',
    "  const clockStarts = lastRead;"],

  ["a-failed-review-stops-the-review-cadence-clock-too", "src/page-reviews.ts",
    "  const daysSince = Math.max(0, daysBetween(lastRead, today));",
    "  const daysSince = Math.max(0, daysBetween(clockStarts, today));"],

  ["the-published-date-drifts-from-the-staleness-clock-again", "src/page-reviews.ts",
    "  return reviewStatus(record, today).clock_starts;",
    "  return reviewStatus(record, today).reviewed_at ?? record.published;"],

  ["a-count-a-data-run-raises-is-reported-as-an-overrun", "src/quality-budgets.ts",
    "  return measurements.filter(m => m.measured > m.budget && !aDataRunMayRaise(m.name));",
    "  return measurements.filter(m => m.measured > m.budget);"],

  ["a-budget-nothing-measured-is-read-as-zero", "src/quality-budgets.ts",
    '    if (typeof count !== "number") continue;',
    '    if (typeof count !== "number") {\n      out.push({ name, budget: budgets[name], measured: 0, cohort: [] });\n      continue;\n    }'],

  ["the-report-carries-no-marker-to-find-it-by", "src/quality-budgets.ts",
    "  lines.push(`<!-- ${BUDGET_REPORT_MARKER} -->`);",
    '  lines.push("");'],

  ["a-cohort-is-printed-whole-however-long-it-is", "src/quality-budgets.ts",
    "  const shown = cohort.slice(0, COHORT_SHOWN);",
    "  const shown = cohort.slice();"],

  ["an-overrun-that-names-no-entries-prints-nothing", "src/quality-budgets.ts",
    '  if (cohort.length === 0) return ["  The measurement names no entries."];',
    "  if (cohort.length === 0) return [];"],

  ["a-digit-counts-as-a-figure", "src/faq-provenance.ts",
    "  return !statesVendorFigure(answer) && /\\d/.test(answer);",
    "  return /\\d/.test(answer);"],

  ["any-structured-block-counts-as-an-faq", "src/faq-provenance.ts",
    '      if (!entry || entry["@type"] !== "FAQPage" || !Array.isArray(entry.mainEntity)) continue;',
    "      if (!entry || !Array.isArray(entry.mainEntity)) continue;"],

  ["a-server-that-answered-nothing-is-a-measurement-of-zero", "scripts/report-quality-budgets.js",
    "    if (served.size < FAQ_PAGES_FLOOR) {",
    "    if (false) {"],

  ["the-issue-is-looked-up-by-searching-for-the-markers-words", "scripts/report-quality-budgets.sh",
    'EXISTING="$(gh issue list --state open --limit 200 --json number,body \\\n  --jq "[.[] | select(.body | contains(\\"<!-- $MARKER -->\\"))] | .[0].number // empty")"',
    'EXISTING="$(gh issue list --state open --search "$MARKER in:body" --json number --jq \'.[0].number // empty\')"'],

  ["nothing-in-test-reads-as-a-budget", "test/budget-assertions.ts",
    "  if (!IDENTIFIER_PATH.test(text)) return false;",
    "  if (!IDENTIFIER_PATH.test(text)) return false;\n  return false;"],

  ["a-budget-compared-to-a-budget-counts-as-a-ratchet", "test/budget-assertions.ts",
    "    if (!compared.some(readsTheBudgetsFile) || compared.every(readsTheBudgetsFile)) continue;",
    "    if (!compared.some(readsTheBudgetsFile)) continue;"],

  ["only-one-function-is-checked-for-a-defaulted-budget", "test/budget-assertions.ts",
    "  pageSourceViolations: 3,",
    "  // pageSourceViolations: 3,"],

  ["a-ceiling-on-a-count-a-data-run-raises-is-flagged-too", "test/budget-assertions.ts",
    "    const holding = [...named].filter(name => !aDataRunMayRaise(name as QualityBudgetName));",
    "    const holding = [...named];"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, TZ: "UTC" } });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("npx", ["tsx", "--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
