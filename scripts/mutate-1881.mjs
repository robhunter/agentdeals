import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SNIPPET_SUITES = ["test/snippet-order.test.ts"];
const DESCRIPTION_SUITES = ["test/category-gate-lede.test.ts", "test/eligibility-disclosure.test.ts"];
const VERDICT_SUITES = ["test/vendor-verdict.test.ts"];

const MUTANTS = [
  ["an-absent-vendor-list-counts-as-position-minus-one", "test/snippet-order.ts",
    "  if (beside === -1) return false;\n",
    "",
    SNIPPET_SUITES],

  ["the-ordering-reads-the-other-way-round", "test/snippet-order.ts",
    "  return description.indexOf(clause) > beside;",
    "  return description.indexOf(clause) < beside;",
    SNIPPET_SUITES],

  ["a-clause-at-the-same-offset-counts-as-appended", "test/snippet-order.ts",
    "  return description.indexOf(clause) > beside;",
    "  return description.indexOf(clause) >= beside;",
    SNIPPET_SUITES],

  ["either-clause-alone-counts-as-both", "test/snippet-order.ts",
    "  return description.includes(clause) && description.includes(other);",
    "  return description.includes(clause) || description.includes(other);",
    SNIPPET_SUITES],

  ["the-gate-clause-is-appended-after-the-vendor-list", "src/serve.ts",
    "${catGatedClause ? ` ${catGatedClause}` : \"\"}${catUncontradictedSentence}",
    "${catUncontradictedSentence}${catGatedClause ? ` ${catGatedClause}` : \"\"}",
    DESCRIPTION_SUITES],

  ["no-category-description-names-an-uncontradicted-vendor", "src/serve.ts",
    `  const catUncontradictedSentence = catUncontradicted.length === 0
    ? ""
    : \` \${NOTHING_CONTRADICTS_OUR_TERMS_FOR} \${catUncontradicted.slice(0, 5).map(o => o.vendor).join(", ")}\${catUncontradicted.length > 5 ? " and more" : ""}.\`;`,
    `  const catUncontradictedSentence = "";`,
    DESCRIPTION_SUITES],

  ["the-refused-read-we-hold-never-sees-a-later-reading", "src/vendor-verdict.ts",
    "    lastReadOn: input.lastReadOn,\n    refusals: input.refusedReads ?? [],",
    "    lastReadOn: input.termsConfirmedOn,\n    refusals: input.refusedReads ?? [],",
    VERDICT_SUITES],

  ["the-verdict-input-stops-carrying-the-date-of-the-last-read", "src/vendor-verdict-input.ts",
    "      lastReadOn: enriched.last_read_date,",
    "      lastReadOn: primary.verifiedDate,",
    VERDICT_SUITES],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function suitesPass(suites) {
  for (const file of suites) {
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
const ALL_SUITES = [...new Set(MUTANTS.flatMap(([, , , , suites]) => suites))];
if (!suitesPass(ALL_SUITES)) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
const notApplied = [];
for (const [name, file, from, to, suites] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass(suites);
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
