import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/change-resolution-totals.test.ts"];

const MUTANTS = [
  ["the-report-counts-every-record-it-holds-again", "src/serve.ts",
    "  const changesInForce = recordsStillInForce(dealChanges);\n  const title = \"State of Developer Free Tiers",
    "  const changesInForce = dealChanges;\n  const title = \"State of Developer Free Tiers"],
  ["the-negative-and-positive-lists-are-taken-before-the-filter", "src/serve.ts",
    "  const negativeChanges = changesInForce.filter(c => negativeTypes.has(c.change_type)).sort((a, b) => b.date.localeCompare(a.date));",
    "  const negativeChanges = dealChanges.filter(c => negativeTypes.has(c.change_type)).sort((a, b) => b.date.localeCompare(a.date));"],
  ["the-monthly-chart-bins-a-record-we-no-longer-stand-behind", "src/serve.ts",
    "  const changeMonths = monthlyChangeSeries(changesInForce);\n  const sortedMonths = tallyMonths(changeMonths.effective);",
    "  const changeMonths = monthlyChangeSeries(dealChanges);\n  const sortedMonths = tallyMonths(changeMonths.effective);"],
  ["the-risk-index-counts-every-record-it-holds-again", "src/serve.ts",
    "  const changesInForce = recordsStillInForce(dealChanges);\n\n  const negativeTypes = [\"free_tier_removed\", \"limits_reduced\", \"restriction\", \"product_deprecated\"",
    "  const changesInForce = dealChanges;\n\n  const negativeTypes = [\"free_tier_removed\", \"limits_reduced\", \"restriction\", \"product_deprecated\""],
  ["the-site-wide-tracked-total-counts-every-record-it-holds", "src/serve.ts",
    "const trackedChangeCount = recordsStillInForce(dealChanges).length;",
    "const trackedChangeCount = dealChanges.length;"],
  ["the-landing-page-teaser-counts-every-record-it-holds", "src/serve.ts",
    "<span style=\"color:#f85149;font-weight:600\">${recordsStillInForce(dealChanges).filter(c => NEGATIVE_CHANGE_TYPES.has(c.change_type)).length} negative</span>",
    "<span style=\"color:#f85149;font-weight:600\">${dealChanges.filter(c => NEGATIVE_CHANGE_TYPES.has(c.change_type)).length} negative</span>"],
  ["the-change-log-tiles-count-every-record-they-hold", "src/serve.ts",
    "function buildChangesPage(): string {\n  const allChanges = loadDealChanges();\n  const countable = recordsStillInForce(allChanges);",
    "function buildChangesPage(): string {\n  const allChanges = loadDealChanges();\n  const countable = allChanges;"],
  ["the-timeline-tiles-count-every-record-they-hold", "src/serve.ts",
    "  const inForceAll = recordsStillInForce(allChanges);\n  const countable = recordsStillInForce(sorted);",
    "  const inForceAll = allChanges;\n  const countable = recordsStillInForce(sorted);"],
  ["the-month-report-counts-every-record-it-holds", "src/serve.ts",
    "  const monthChanges = recordsStillInForce(recordedInMonth);",
    "  const monthChanges = recordedInMonth;"],
  ["the-reports-index-counts-every-record-it-holds", "src/serve.ts",
    "    + '<p class=\"subtitle\">Auto-generated monthly analysis of developer tool pricing trends across ' + recordsStillInForce(allChanges).length",
    "    + '<p class=\"subtitle\">Auto-generated monthly analysis of developer tool pricing trends across ' + allChanges.length"],
  ["the-trends-index-counts-every-record-it-holds", "src/serve.ts",
    "function buildTrendsIndexPage(): string {\n  const allChanges = recordsStillInForce(loadDealChanges());",
    "function buildTrendsIndexPage(): string {\n  const allChanges = loadDealChanges();"],
  ["a-reversal-stops-counting-and-only-a-retraction-does", "src/change-resolution.ts",
    "export function recordsStillInForce<T extends Resolvable>(changes: readonly T[]): T[] {\n  return changes.filter((c) => !isNoLongerInForce(c));",
    "export function recordsStillInForce<T extends Resolvable>(changes: readonly T[]): T[] {\n  return changes.filter((c) => !theEventNeverHappened(c));"],
  ["the-filter-drops-nothing", "src/change-resolution.ts",
    "  return changes.filter((c) => !isNoLongerInForce(c));\n}",
    "  return changes.filter(() => true);\n}"],
  ["the-record-is-dropped-from-the-log-as-well-as-the-totals", "src/serve.ts",
    "  const { dated: eventDated, discovered: undatedChanges } = partitionByDateProvenance(allChanges);\n  const today = new Date().toISOString().slice(0, 10);\n  const thirtyDaysAgo",
    "  const { dated: eventDated, discovered: undatedChanges } = partitionByDateProvenance(recordsStillInForce(allChanges));\n  const today = new Date().toISOString().slice(0, 10);\n  const thirtyDaysAgo"],
  ["a-ratio-is-rounded-to-a-whole-number-however-far-that-is-from-the-figures", "src/change-direction.ts",
    "  if (Math.abs(exact - whole) <= RATIO_ROUNDING_TOLERANCE) return `${whole}:1`;\n  return `${exact.toFixed(1)}:1`;",
    "  return `${whole}:1`;"],
  ["a-ratio-is-never-rounded-even-when-rounding-is-true-to-the-figures", "src/change-direction.ts",
    "  if (Math.abs(exact - whole) <= RATIO_ROUNDING_TOLERANCE) return `${whole}:1`;\n  return `${exact.toFixed(1)}:1`;",
    "  return `${exact.toFixed(1)}:1`;"],
  ["the-tolerance-is-widened-until-any-rounding-passes", "src/change-direction.ts",
    "export const RATIO_ROUNDING_TOLERANCE = 0.25;",
    "export const RATIO_ROUNDING_TOLERANCE = 0.5;"],
  ["a-retracted-record-is-filed-again-under-the-vendors-cutting-back", "src/serve.ts",
    "  const squeezeHtml = negativeChanges.slice(0, 15).map(c => {",
    "  const squeezeHtml = dealChanges.filter(c => negativeTypes.has(c.change_type)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15).map(c => {"],
  ["a-builder-decides-on-a-resolution-without-the-shared-predicate", "src/serve.ts",
    "${isNoLongerInForce(c) ? \" pc-resolved\" : \"\"}",
    "${c.resolution ? \" pc-resolved\" : \"\"}"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
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
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
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
