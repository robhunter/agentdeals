import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_BUDGET_NAMES, aDataRunMayRaise } from "../dist/page-reviews.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGETS = join(REPO, "data", "quality_budgets.json");
const HELD = `${BUDGETS}.demo-1327`;

const HELP = `Show that a quality budget over its ceiling no longer decides whether the suite passes.

Every budget a data run cannot raise is put far under what the shipped data measures, the test
files that used to hold those counts are run, and the reporter is asked what it would say. A
green suite and a report naming every overrun is the pair this demonstrates. The budgets file is
restored either way.

Usage: node scripts/demo-1327.mjs [--all]

  --all   Run the whole suite rather than the files that held a budget
`;

const FILES = [
  "test/stale-page-facts.test.ts",
  "test/page-data-provenance.test.ts",
  "test/page-source-ratchet.test.ts",
  "test/faq-provenance.test.ts",
  "test/uncited-change-records.test.ts",
  "test/change-reporting.test.ts",
  "test/vendor-naming.test.ts",
  "test/quality-budget-report.test.ts",
];

function run(command, args) {
  return spawnSync(command, args, { cwd: REPO, encoding: "utf-8", env: { ...process.env, TZ: "UTC" } });
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const whole = process.argv.includes("--all");

  const shipped = JSON.parse(readFileSync(BUDGETS, "utf-8"));
  const lowered = { ...shipped, budgets: { ...shipped.budgets } };
  const held = [];
  for (const name of QUALITY_BUDGET_NAMES) {
    if (aDataRunMayRaise(name)) continue;
    lowered.budgets[name] = Math.floor(shipped.budgets[name] / 2);
    held.push(`${name} ${shipped.budgets[name]} → ${lowered.budgets[name]}`);
  }

  console.log("── Every budget a data run cannot raise, put under what the data measures ──");
  for (const line of held) console.log(`  ${line}`);
  console.log();

  copyFileSync(BUDGETS, HELD);
  let suite;
  let report;
  try {
    writeFileSync(BUDGETS, `${JSON.stringify(lowered, null, 2)}\n`);
    report = run("node", ["scripts/report-quality-budgets.js", "--json"]);
    suite = whole
      ? run("npm", ["test"])
      : run("node", ["--test", "--test-concurrency", "1", ...FILES]);
  } finally {
    copyFileSync(HELD, BUDGETS);
    rmSync(HELD, { force: true });
  }

  const summary = (suite.stdout ?? "").match(/^ℹ (?:tests|pass|fail) \d+$/gm) ?? [];
  console.log("── The suite, with every one of those over its ceiling ──");
  for (const line of summary) console.log(`  ${line}`);
  if (suite.status !== 0) {
    console.log((suite.stdout ?? "").split("✖ failing tests:")[1]?.slice(0, 4000) ?? suite.stderr);
  }
  console.log(suite.status === 0 ? "  green\n" : `  RED (exit ${suite.status})\n`);

  console.log("── What the reporter would say about the same data ──");
  if (report.status !== 0) {
    console.log(`  the reporter failed: ${report.stderr}`);
  } else {
    for (const m of JSON.parse(report.stdout).over) {
      console.log(`  ${m.name}: ceiling ${m.budget}, measured ${m.measured} — ${m.measured - m.budget} over`);
    }
  }

  const over = report.status === 0 ? JSON.parse(report.stdout).over.length : 0;
  const ok = suite.status === 0 && over === held.length;
  console.log(
    ok
      ? `\n${held.length} budgets over ceiling, ${over} of them reported, suite green.`
      : `\nsuite exit ${suite.status}, ${over} of ${held.length} reported.`,
  );
  return ok ? 0 : 1;
}

process.exit(main());
