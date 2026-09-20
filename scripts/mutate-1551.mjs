import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/what-the-last-read-found.test.ts",
  "test/read-date.test.ts",
];

const MUTANTS = [
  ["the-date-stops-bounding-which-refusal-settles", "src/change-refusal.ts",
    "  const sameRead = refusals.filter(r => r.refused_date === read);",
    "  const sameRead = refusals.filter(() => true);"],

  ["a-read-with-no-refusal-is-settled", "src/change-refusal.ts",
    "  if (sameRead.length === 0) return null;",
    "  if (false) return null;"],

  ["a-refusal-on-other-grounds-stops-holding-the-disagreement", "src/change-refusal.ts",
    "  if (sameRead.some(r => !refusalSettledTheRead(r))) return null;",
    ""],

  ["one-settling-reason-is-enough-however-the-others-read", "src/change-refusal.ts",
    "  if (sameRead.some(r => !refusalSettledTheRead(r))) return null;",
    "  if (sameRead.every(r => !refusalSettledTheRead(r))) return null;"],

  ["a-confirming-reason-stops-outranking-a-measured-one", "src/change-refusal.ts",
    `  if (confirming) return { settlement: "restated_the_terms_we_publish", refusal: confirming };`,
    ""],

  ["the-two-settlements-are-reported-the-other-way-round", "src/change-refusal.ts",
    `  if (confirming) return { settlement: "restated_the_terms_we_publish", refusal: confirming };`,
    `  if (confirming) return { settlement: "named_no_figure_that_moved", refusal: confirming };`],

  ["a-measured-difference-is-reported-as-a-restatement", "src/change-refusal.ts",
    `  return { settlement: "named_no_figure_that_moved", refusal: mostRecent(sameRead)! };`,
    `  return { settlement: "restated_the_terms_we_publish", refusal: mostRecent(sameRead)! };`],

  ["settling-stops-reading-the-reasons-that-confirm-our-terms", "src/change-refusal.ts",
    "  return refusalConfirmsTheStoredTerms(refusal) || refusalMeasuredNoDifference(refusal);",
    "  return refusalMeasuredNoDifference(refusal);"],

  ["settling-stops-reading-the-reasons-that-measured-no-difference", "src/change-refusal.ts",
    "  return refusalConfirmsTheStoredTerms(refusal) || refusalMeasuredNoDifference(refusal);",
    "  return refusalConfirmsTheStoredTerms(refusal);"],

  ["every-reason-settles-the-read-that-raised-it", "src/change-refusal.ts",
    "  return refusalConfirmsTheStoredTerms(refusal) || refusalMeasuredNoDifference(refusal);",
    "  return true;"],

  ["a-settled-read-of-any-outcome-takes-the-settled-clause", "src/read-date.ts",
    "  if (settled && outcome === OUTCOME_CONTRADICTING_WHAT_WE_STORE) {",
    "  if (settled) {"],

  ["the-settlement-answers-for-a-read-that-confirmed-instead", "src/read-date.ts",
    "  if (settled && outcome === OUTCOME_CONTRADICTING_WHAT_WE_STORE) {",
    "  if (settled && outcome === OUTCOME_THAT_CONFIRMED) {"],

  ["an-unsettled-read-stops-saying-what-it-found", "src/read-date.ts",
    "  return outcome ? WHAT_THE_LAST_READ_FOUND[outcome] ?? null : null;",
    "  return null;"],

  ["a-reading-of-any-outcome-is-rewritten-by-a-refusal", "src/read-date.ts",
    "  if (!reading || reading.outcome !== OUTCOME_CONTRADICTING_WHAT_WE_STORE) return reading;",
    "  if (!reading) return reading;"],

  ["the-rewrite-stops-reaching-the-reading", "src/read-date.ts",
    "  return { ...reading, found: WHAT_A_SETTLED_READ_FOUND[settled.settlement] };",
    "  return reading;"],

  ["the-rewrite-reports-the-other-settlement", "src/read-date.ts",
    "  return { ...reading, found: WHAT_A_SETTLED_READ_FOUND[settled.settlement] };",
    `  return { ...reading, found: WHAT_A_SETTLED_READ_FOUND.named_no_figure_that_moved };`],

  ["the-reading-lookup-stops-reading-the-refusals", "src/read-date.ts",
    "  return readingSettledByRefusals(readingFromVerificationState(offer), storedRefusalsFor(offer.vendor));",
    "  return readingSettledByRefusals(readingFromVerificationState(offer), []);"],

  ["the-note-stops-reading-the-refusals", "src/read-date.ts",
    "    const settled = howWeSettledTheRead(refusals, read);",
    "    const settled = null;"],

  ["the-note-settles-on-the-catalogue-date-rather-than-the-read", "src/read-date.ts",
    "    const settled = howWeSettledTheRead(refusals, read);",
    "    const settled = howWeSettledTheRead(refusals, verified);"],

  ["the-outcome-is-published-for-a-day-we-did-not-read", "src/data.ts",
    "  if (!reading || reading.date !== publishedReadDate) {",
    "  if (!reading) {"],

  ["the-outcome-field-stops-carrying-what-the-store-holds", "src/data.ts",
    "  return { last_read_outcome: reading.outcome, last_read_found: reading.found };",
    "  return { last_read_outcome: null, last_read_found: reading.found };"],

  ["the-clause-field-stops-carrying-what-the-read-found", "src/data.ts",
    "  return { last_read_outcome: reading.outcome, last_read_found: reading.found };",
    "  return { last_read_outcome: reading.outcome, last_read_found: null };"],

  ["the-refusal-store-stops-folding-the-vendor-name", "src/refusal-store.ts",
    "      const key = refusal.vendor.trim().toLowerCase();",
    "      const key = refusal.vendor;"],

  ["the-refusal-lookup-stops-folding-the-vendor-name", "src/refusal-store.ts",
    "  return cachedByVendor.get(vendor.trim().toLowerCase()) ?? [];",
    "  return cachedByVendor.get(vendor) ?? [];"],
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

const only = process.argv.slice(2);
const survivors = [];
const uncompiled = [];
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  if (only.length > 0 && !only.some((w) => name.includes(w))) continue;
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
const written = only.length > 0 ? MUTANTS.filter((m) => only.some((w) => m[0].includes(w))).length : MUTANTS.length;
const scored = written - notApplied.length - uncompiled.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${written} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
