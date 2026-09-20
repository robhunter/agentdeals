import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TARGET = "test/hardcoded-row-duration-agrees-with-the-record.test.ts";

const MUTANTS = [
  ["the rule never fires", "return !duration.recordStates.includes(duration.days);", "return false;"],
  ["the rule always fires", "return !duration.recordStates.includes(duration.days);", "return true;"],
  ["markup fields are read like any other", "&& !HOLDS_MARKUP.test(value)", ""],
  ["the exception ignores the number of days", "&& declared.days === duration.days,", ","],
  ["the exception ignores which field states it", "&& declared.field === duration.field", ""],
  ["the exception ignores which page states it", "declared.builder === duration.row.builder\n        &&", ""],
  ["a record stating no duration is read as stating zero", "if (recordStates.length === 0) continue;", ""],
  ["no number of days is read at all", "const A_NUMBER_OF_DAYS = /(\\d[\\d,]*)[\\s-]?days?\\b/gi;", "const A_NUMBER_OF_DAYS = /(\\d[\\d,]*)[\\s-]?daysx\\b/gi;"],
  ["a row is read against no record at all", "function recordTheResolutionReaches(resolution: Resolution): Offer | null {", "function recordTheResolutionReaches(resolution: Resolution): Offer | null {\n  if (resolution) return null;"],
  ["a rename no longer reaches the record it points at", 'if (resolution.type !== "exact" && resolution.type !== "redirect") return null;', 'if (resolution.type !== "exact") return null;'],
];

const original = readFileSync(TARGET, "utf-8");
let killed = 0;
let survived = 0;
let notApplied = 0;

for (const [name, from, to] of MUTANTS) {
  const occurrences = original.split(from).length - 1;
  if (occurrences !== 1) {
    console.log(`NOT APPLIED  ${name} — target text appears ${occurrences} times`);
    notApplied++;
    continue;
  }
  writeFileSync(TARGET, original.replace(from, to), "utf-8");
  let outcome = "SURVIVED";
  try {
    execFileSync("node", ["--test", "--test-concurrency", "1", TARGET], { stdio: "pipe" });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    outcome = /SyntaxError|TSError|ERR_/.test(output) && !/AssertionError/.test(output) ? "NOT APPLIED" : "KILLED";
    if (outcome === "NOT APPLIED") console.log(output.slice(0, 400));
  }
  if (outcome === "KILLED") killed++;
  else if (outcome === "SURVIVED") survived++;
  else notApplied++;
  console.log(`${outcome.padEnd(12)} ${name}`);
}

writeFileSync(TARGET, original, "utf-8");
console.log(`\n${killed} killed, ${survived} survived, ${notApplied} not applied, of ${MUTANTS.length}`);
process.exit(survived === 0 ? 0 : 1);
