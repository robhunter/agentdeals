import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/read-had-no-standing-to-contradict.test.ts",
  "test/what-the-last-read-found.test.ts",
];

const MUTANTS = [
  ["the-page-with-no-price-signal-contradicts-again", "src/change-refusal.ts",
    "  return VOIDING_REASONS.has(refusal.reason);",
    `  return VOIDING_REASONS.has(refusal.reason) && refusal.reason !== "no_price_signal";`],

  ["the-page-that-states-no-terms-contradicts-again", "src/change-refusal.ts",
    "  return VOIDING_REASONS.has(refusal.reason);",
    `  return VOIDING_REASONS.has(refusal.reason) && refusal.reason !== "states_no_terms";`],

  ["the-removal-read-off-a-domain-root-contradicts-again", "src/change-refusal.ts",
    "  return VOIDING_REASONS.has(refusal.reason);",
    `  return VOIDING_REASONS.has(refusal.reason) && refusal.reason !== "removal_read_from_root";`],

  ["every-refusal-voids-the-read-that-raised-it", "src/change-refusal.ts",
    "  return VOIDING_REASONS.has(refusal.reason);",
    "  return true;"],

  ["a-voided-read-outranks-one-that-measured-the-figures", "src/change-refusal.ts",
    `  const measured = mostRecent(sameRead.filter(refusalMeasuredNoDifference));
  if (measured) return { settlement: "named_no_figure_that_moved", refusal: measured };
`,
    ""],

  ["a-voided-read-outranks-one-that-restated-our-terms", "src/change-refusal.ts",
    `  const confirming = mostRecent(sameRead.filter(refusalConfirmsTheStoredTerms));
  if (confirming) return { settlement: "restated_the_terms_we_publish", refusal: confirming };
`,
    ""],

  ["one-settling-refusal-speaks-for-a-day-that-holds-another", "src/change-refusal.ts",
    "  if (sameRead.some(r => !refusalSettledTheRead(r))) return null;\n",
    ""],

  ["a-refusal-from-any-earlier-day-voids-the-read", "src/change-refusal.ts",
    "  const sameRead = refusals.filter(r => r.refused_date === read);",
    "  const sameRead = refusals.filter(r => r.refused_date <= read);"],

  ["a-suppression-no-register-classifies", "src/change-refusal.ts",
    `  "same_transition_graded_differently",\n`,
    ""],

  ["a-voiding-reason-also-left-standing", "src/change-refusal.ts",
    `  "removal_read_from_redirect",`,
    `  "removal_read_from_redirect",\n  "no_baseline",`],

  ["a-page-with-no-price-signal-publishes-the-difference", "src/read-date.ts",
    "  no_price_signal: WHAT_THE_LAST_READ_FOUND.states_no_price,",
    "  no_price_signal: WHAT_THE_LAST_READ_FOUND.changed,"],

  ["the-domain-root-clause-reads-the-wrong-reason", "src/read-date.ts",
    `  removal_read_from_root: "reached a domain root that states nothing about the terms we hold",`,
    `  removal_read_from_root: "found the page did not mention this offer, which is not evidence it ended",`],

  ["the-domain-root-clause-answers-about-our-own-records", "src/read-date.ts",
    `  removal_read_from_root: "reached a domain root that states nothing about the terms we hold",`,
    `  removal_read_from_root: "found no earlier figure of ours for the page to have narrowed",`],

  ["the-domain-root-clause-drops-what-it-read", "src/read-date.ts",
    `  removal_read_from_root: "reached a domain root that states nothing about the terms we hold",`,
    `  removal_read_from_root: "reached a page that states nothing about the terms we hold",`],

  ["a-voided-read-answers-from-the-settlement-table", "src/read-date.ts",
    `  return settled.settlement === READ_VOIDED_BY_ITS_OWN_REFUSAL
    ? WHAT_A_VOIDED_READ_FOUND[settled.refusal.reason as VoidingRefusalReason]
    : WHAT_A_SETTLED_READ_FOUND[settled.settlement];`,
    `  return WHAT_A_SETTLED_READ_FOUND[settled.settlement as SettlementStatedTheSameWayForEveryReason];`],

  ["a-rewritten-reading-keeps-the-difference-it-found", "src/read-date.ts",
    "  return { ...reading, found: whatASettledReadFound(settled) };",
    "  return { ...reading, found: reading.found };"],

  ["the-listing-count-takes-in-every-row", "src/serve.ts",
    "function statesTermsWeCannotConfirm(offer: Offer): boolean {\n  return supersedingChangeFor(offer) === null && !nothingWeHoldContradicts(offer);",
    "function statesTermsWeCannotConfirm(offer: Offer): boolean {\n  return supersedingChangeFor(offer) === null;"],
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
