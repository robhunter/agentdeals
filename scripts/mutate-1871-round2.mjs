import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/check-figure-bears-on-the-offer.test.ts",
  "test/vendor-naming.test.ts",
];

const MUTANTS = [
  ["the-record-with-no-terms-of-its-own-matches-everything", "scripts/change-gate.js",
    "  if (published.length === 0) return [];\n",
    ""],

  ["the-check-reads-the-tier-rather-than-the-terms", "scripts/vendor-naming.js",
    "  const reported = figuresWorthReporting(found, offer.description);",
    "  const reported = figuresWorthReporting(found, offer.tier);"],

  ["a-price-that-merely-starts-with-a-zero-reads-as-free", "scripts/vendor-naming.js",
    "const AN_AMOUNT_OF_ZERO = /^(?:[$€£¥₹]\\s?0(?:[.,]0+)?|0(?:\\.0+)?\\s?(?:USD|EUR|GBP))$/i;",
    "const AN_AMOUNT_OF_ZERO = /^(?:[$€£¥₹]\\s?0(?:[.,]0+)?|0(?:\\.0+)?\\s?(?:USD|EUR|GBP))/i;"],

  ["the-first-figure-that-bears-is-dropped-from-the-sentence", "scripts/vendor-naming.js",
    "  if (ours.length > 0) return ours.slice(0, MOST_FIGURES_REPORTED);",
    "  if (ours.length > 0) return ours.slice(1, MOST_FIGURES_REPORTED + 1);"],

  ["the-measure-has-to-be-the-one-the-reader-names-first", "scripts/change-gate.js",
    `  const measures = new Set((published?.words ?? []).filter(isAMeasureWord));
  return (stated?.words ?? []).some((word) => isAMeasureWord(word) && measures.has(word));`,
    "  return measuredWord(stated) !== null && measuredWord(stated) === measuredWord(published);"],

  ["the-withdrawal-takes-the-first-comma-rather-than-the-last", "scripts/withdraw-figures-we-do-not-publish.js",
    'reported.named.replace(/,$/, "")',
    'reported.named.replace(/,/, "")'],

  ["a-stored-figure-is-kept-whenever-one-of-the-pair-is-ours", "scripts/withdraw-figures-we-do-not-publish.js",
    "  if (keep.length === reported.figures.length && keep.every((figure, at) => figure === reported.figures[at])) {\n    return detail;\n  }",
    "  if (keep.length > 0) {\n    return detail;\n  }"],

  ["the-zero-is-read-off-the-end-of-the-page-rather-than-the-start", "scripts/vendor-naming.js",
    "  const free = (signals ?? []).find(statesAnAmountOfZero);",
    "  const free = (signals ?? []).findLast(statesAnAmountOfZero);"],
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
