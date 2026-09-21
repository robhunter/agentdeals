import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/refused-read-register.test.ts",
  "test/refused-change-not-stable.test.ts",
  "test/badge-withholding.test.ts",
];

const MUTANTS = [
  ["a-voiding-refusal-falls-back-into-the-unreconciled-register", "src/change-refusal.ts",
    `  if (refusalVoidsTheReadsStanding(refusal)) return "had_no_standing_to_contradict";\n  return "could_not_reconcile_the_change";`,
    `  return "could_not_reconcile_the_change";`],

  ["a-voided-read-badges-as-a-change-not-reconciled", "src/vendor-verdict.ts",
    `  had_no_standing_to_contradict: "read_had_no_standing",`,
    `  had_no_standing_to_contradict: "read_not_reconciled",`],

  ["the-voided-clause-states-a-change-again", "src/change-refusal.ts",
    `      : readHadNoStandingClause(read.refusedOn, whatAVoidedReadFound(read)),`,
    `      : unreconciledReadClause(read.refusedOn),`],

  ["the-voided-meta-clause-states-a-change-again", "src/change-refusal.ts",
    `      : readHadNoStandingMetaClause(read.refusedOn, whatAVoidedReadFound(read)),`,
    `      : unreconciledReadMetaClause(read.refusedOn),`],

  ["the-voided-sentence-states-a-change-again", "src/change-refusal.ts",
    `      : readHadNoStandingSentence(subject, read.refusedOn, whatAVoidedReadFound(read)),`,
    `      : unreconciledReadSentence(subject, read.refusedOn),`],

  ["every-voiding-reason-publishes-the-first-reasons-finding", "src/change-refusal.ts",
    `  return WHAT_A_VOIDED_READ_FOUND[read.refusedFor as VoidingRefusalReason];`,
    `  return WHAT_A_VOIDED_READ_FOUND.no_price_signal;`],

  ["the-register-that-was-not-moved-takes-the-new-wording", "src/change-refusal.ts",
    `      : unreconciledReadClause(read.refusedOn),`,
    `      : readHadNoStandingClause(read.refusedOn, "read the page"),`],

  ["a-voided-withholding-is-no-longer-a-refused-read", "src/vendor-verdict.ts",
    `const TAGS_A_REFUSED_READ_WITHHOLDS_UNDER = new Set<string>(\n  Object.values(REFUSED_READ_WITHHOLDING_TAG),\n);`,
    `const TAGS_A_REFUSED_READ_WITHHOLDS_UNDER = new Set<string>(["read_not_reconciled", "change_measured_no_difference"]);`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function suitesPass() {
  for (const file of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", file])) return false;
  }
  return true;
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!run("npm", ["run", "build"])) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suitesPass()) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "NOT APPLIED — did not compile"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const scored = MUTANTS.length - notApplied.length - uncompiled.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
