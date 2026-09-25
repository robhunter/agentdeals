import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/a-check-that-kept-only-the-name-is-read-next.test.ts",
  "test/check-figure-bears-on-the-offer.test.ts",
  "test/reverify-rolling.test.ts",
  "test/read-corroboration.test.ts",
  "test/change-refusals.test.ts",
];

const MUTANTS = [
  ["the-queue-draws-by-age-alone", "scripts/reverify-rolling.js",
    "    Number(b.keptOnlyTheName) - Number(a.keptOnlyTheName) ||\n",
    ""],

  ["the-queue-draws-a-kept-name-last", "scripts/reverify-rolling.js",
    "    Number(b.keptOnlyTheName) - Number(a.keptOnlyTheName) ||\n",
    "    Number(a.keptOnlyTheName) - Number(b.keptOnlyTheName) ||\n"],

  ["a-kept-name-goes-ahead-of-a-held-verdicts-second-reading", "scripts/reverify-rolling.js",
    "    Number(b.awaitingCorroboration) - Number(a.awaitingCorroboration) ||\n    Number(b.keptOnlyTheName) - Number(a.keptOnlyTheName) ||\n",
    "    Number(b.keptOnlyTheName) - Number(a.keptOnlyTheName) ||\n    Number(b.awaitingCorroboration) - Number(a.awaitingCorroboration) ||\n"],

  ["no-check-keeps-only-the-name", "scripts/vendor-naming.js",
    "  return check?.outcome === SOURCE_CHECK_OK && detailIsOnlyTheNaming(check.detail, offer?.vendor);",
    "  return false;"],

  ["a-check-of-any-outcome-keeps-only-the-name", "scripts/vendor-naming.js",
    "  return check?.outcome === SOURCE_CHECK_OK && detailIsOnlyTheNaming(check.detail, offer?.vendor);",
    "  return detailIsOnlyTheNaming(check?.detail, offer?.vendor);"],

  ["a-naming-clause-with-a-finding-after-it-keeps-only-the-name", "scripts/vendor-naming.js",
    "    return new RegExp(`^${pattern},?$`).test(text);",
    "    return new RegExp(`^${pattern}`).test(text);"],

  ["any-vendor-in-the-clause-counts-as-the-records-own", "scripts/vendor-naming.js",
    "    const pattern = escapeForPattern(clause).replace(ANY_FORM, '[^\"]*');",
    "    const pattern = escapeForPattern(clause).replace(ANY_FORM, '[^\"]*').replace(escapeForPattern(vendor), \".+\");"],

  ["only-the-names-form-is-recognised", "scripts/vendor-naming.js",
    "  return [NAMED_IN_PAGE_TEXT, NAMED_BY_A_HOST_THE_PAGE_WRITES].some((via) => {",
    "  return [NAMED_IN_PAGE_TEXT].some((via) => {"],

  ["the-restatement-cuts-the-finding-to-the-naming-again", "scripts/withdraw-figures-we-do-not-publish.js",
    "  if (keep.length === 0) return detail;",
    '  if (keep.length === 0) return reported.named.replace(/,$/, "");'],

  ["a-finding-with-no-figure-we-publish-needs-no-reread", "scripts/withdraw-figures-we-do-not-publish.js",
    "  return reported !== null && figuresWorthReporting(reported.figures, terms).length === 0;",
    "  return false;"],

  ["the-summary-counts-every-waiting-record-as-drawn", "scripts/reverify-rolling.js",
    "    pickedBecauseTheCheckKeptOnlyTheName: fromQueue.filter((entry) => entry.keptOnlyTheName).length,",
    "    pickedBecauseTheCheckKeptOnlyTheName: queue.filter((entry) => entry.keptOnlyTheName).length,"],

  ["the-summary-never-says-it", "scripts/reverify-rolling.js",
    "  if (queuedWithACheckThatKeptOnlyTheName !== undefined) {",
    "  if (false) {"],

  ["the-summary-says-it-with-nothing-to-count", "scripts/reverify-rolling.js",
    "  if (queuedWithACheckThatKeptOnlyTheName !== undefined) {",
    "  if (true) {"],
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
  const green = suitesPass();
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}
const scored = MUTANTS.length - notApplied.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
