import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/one-direction-rule.test.ts", "test/risk-badge.test.ts"];

const MUTANTS = [
  ["the-trend-direction-keeps-its-own-set", "src/serve.ts",
    "const NEGATIVE_TYPES = NEGATIVE_CHANGE_TYPES;",
    'const NEGATIVE_TYPES = new Set(["free_tier_removed", "limits_reduced", "restriction", "open_source_killed", "product_deprecated"]);'],

  ["the-report-keeps-its-own-set", "src/serve.ts",
    "  const negativeTypes = NEGATIVE_CHANGE_TYPES;\n  const positiveTypes = POSITIVE_CHANGE_TYPES;\n  function tallyMonths",
    '  const negativeTypes = new Set(["free_tier_removed", "limits_reduced", "restriction", "open_source_killed", "product_deprecated"]);\n  const positiveTypes = new Set(["new_free_tier", "limits_increased", "startup_program_expanded"]);\n  function tallyMonths'],

  ["the-risk-page-drops-one-positive-type", "src/serve.ts",
    "  const negativeTypes = NEGATIVE_CHANGE_TYPES;\n  const positiveTypes = POSITIVE_CHANGE_TYPES;\n  const trackedHere = trackedChanges(changesInForce);",
    '  const negativeTypes = NEGATIVE_CHANGE_TYPES;\n  const positiveTypes = new Set(["limits_increased", "new_free_tier", "startup_program_expanded", "pricing_postponed"]);\n  const trackedHere = trackedChanges(changesInForce);'],

  ["the-change-log-keeps-its-own-map", "src/serve.ts",
    "  const filterCategory: Record<string, string> = CHANGE_DIRECTION;",
    '  const filterCategory: Record<string, string> = { free_tier_removed: "negative", limits_reduced: "negative", open_source_killed: "negative", product_deprecated: "negative", restriction: "negative", limits_increased: "positive", new_free_tier: "positive", startup_program_expanded: "positive", pricing_restructured: "neutral", pricing_model_change: "neutral", pricing_postponed: "neutral" };'],

  ["the-dashboard-prints-a-rule-it-does-not-apply", "src/serve.ts",
    "  const negativeTypes = [...NEGATIVE_CHANGE_TYPES];\n  const positiveTypes = [...POSITIVE_CHANGE_TYPES];",
    '  const negativeTypes = ["free_tier_removed", "open_source_killed", "limits_reduced", "restriction", "pricing_restructured", "product_deprecated"];\n  const positiveTypes = ["limits_increased", "new_free_tier", "startup_program_expanded", "pricing_postponed"];'],

  ["the-browser-gets-a-set-of-its-own", "src/serve.ts",
    "  var NEG_TYPES = ${JSON.stringify([...NEGATIVE_CHANGE_TYPES])};\n  var POS_TYPES = ${JSON.stringify([...POSITIVE_CHANGE_TYPES])};",
    "  var NEG_TYPES = ['free_tier_removed','limits_reduced','restriction','product_deprecated','open_source_killed','pricing_model_change','pricing_restructured'];\n  var POS_TYPES = ['new_free_tier','limits_increased','startup_program_expanded','new_tier'];"],

  ["the-published-table-types-its-own-column", "src/change-direction.ts",
    "    direction: CHANGE_DIRECTION[code],",
    '    direction: "negative",'],

  ["a-restructure-goes-back-to-counting-as-nothing", "src/change-direction.ts",
    '  pricing_restructured: "negative",',
    '  pricing_restructured: "neutral",'],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const hits = occurrences(original, from);
  if (hits !== 1) {
    console.log(`SKIP  ${name} — its target appears ${hits} times in ${file}, so it would score nothing`);
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
if (skipped.length > 0) console.log("skipped — target moved:", skipped.join(", "));
