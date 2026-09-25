import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/data-push-holdback.test.ts",
];

const MUTANTS = [
  ["the-ledger-is-not-held-back", "src/data-push-holdback.ts",
    '  { path: "data/restated_terms.json", arrayKeys: ["restatements"] },\n',
    ""],

  ["only-held-readings-are-held-back", "src/data-push-holdback.ts",
    '  { path: "data/change_corroboration.json", arrayKeys: ["held", "resolved"] },',
    '  { path: "data/change_corroboration.json", arrayKeys: ["held"] },'],

  ["only-the-first-array-is-restored", "src/data-push-holdback.ts",
    "  return arrayKeys.reduce((doc, arrayKey) => withVendorsAsTheyWereBefore(before, doc, arrayKey, vendors), after);",
    "  return arrayKeys.slice(0, 1).reduce((doc, arrayKey) => withVendorsAsTheyWereBefore(before, doc, arrayKey, vendors), after);"],

  ["only-the-first-array-is-read-for-movement", "src/data-push-holdback.ts",
    "  for (const arrayKey of arrayKeys) {\n    for (const name of vendorsMoved(before, after, arrayKey)) {",
    "  for (const arrayKey of arrayKeys.slice(0, 1)) {\n    for (const name of vendorsMoved(before, after, arrayKey)) {"],

  ["a-vendor-moved-in-two-arrays-is-named-twice", "src/data-push-holdback.ts",
    "  return [...moved.values()].sort((a, b) => a.localeCompare(b));\n}\n\nexport function withVendorsAsTheyWereBeforeIn(",
    "  return arrayKeys.flatMap((arrayKey) => vendorsMoved(before, after, arrayKey)).sort((a, b) => a.localeCompare(b));\n}\n\nexport function withVendorsAsTheyWereBeforeIn("],
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
