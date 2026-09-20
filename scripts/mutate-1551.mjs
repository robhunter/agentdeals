import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = ["test/listing-reads-the-store.test.ts"];

const MUTANTS = [
  ["the-lede-stops-reading-the-verification-store", "src/serve.ts",
    "  return unconfirmedTermsFor(offer) === null && readContradictingTheTermsFor(offer) === null;",
    "  return unconfirmedTermsFor(offer) === null;"],

  ["the-lede-calls-every-record-contradicted", "src/serve.ts",
    "  return unconfirmedTermsFor(offer) === null && readContradictingTheTermsFor(offer) === null;",
    "  return false;"],

  ["the-listing-row-stops-stating-the-read", "src/serve.ts",
    "  const reading = readContradictingTheTermsFor(offer);\n  if (!reading) return \"\";\n  return `<span class=\"listing-read-contradicts\"",
    "  const reading = readContradictingTheTermsFor(offer);\n  if (reading) return \"\";\n  return `<span class=\"listing-read-contradicts\""],

  ["an-ended-offer-is-flagged-over-terms-it-no-longer-publishes", "src/serve.ts",
    "  return offerEnded(offer)\n    || supersedingChangeFor(offer) !== null\n    || unconfirmedTermsFor(offer) !== null;",
    "  return supersedingChangeFor(offer) !== null || unconfirmedTermsFor(offer) !== null;"],

  ["a-row-that-already-speaks-gets-a-second-reason", "src/serve.ts",
    "  return offerEnded(offer)\n    || supersedingChangeFor(offer) !== null\n    || unconfirmedTermsFor(offer) !== null;",
    "  return offerEnded(offer);"],

  ["a-superseded-row-gets-a-second-reason", "src/serve.ts",
    "  return offerEnded(offer)\n    || supersedingChangeFor(offer) !== null\n    || unconfirmedTermsFor(offer) !== null;",
    "  return offerEnded(offer) || unconfirmedTermsFor(offer) !== null;"],

  ["nothing-already-speaks-for-itself", "src/serve.ts",
    "  return alreadySpeaksForItself(offer) ? null : readThatContradictsOurTerms(offer);",
    "  return readThatContradictsOurTerms(offer);"],

  ["every-outcome-counts-as-a-contradiction", "src/read-date.ts",
    "  if (!reading || reading.outcome !== OUTCOME_CONTRADICTING_WHAT_WE_STORE) return null;\n  return somethingLaterSettledTheRead(reading, after) ? null : reading;",
    "  if (!reading) return null;\n  return somethingLaterSettledTheRead(reading, after) ? null : reading;"],

  ["nothing-later-can-settle-a-contradicting-read", "src/read-date.ts",
    "  return somethingLaterSettledTheRead(reading, after) ? null : reading;",
    "  return reading;"],

  ["everything-later-settles-a-contradicting-read", "src/read-date.ts",
    "  return somethingLaterSettledTheRead(reading, after) ? null : reading;",
    "  return null;"],

  ["a-refusal-stops-settling-the-read", "src/read-date.ts",
    "  return howWeSettledTheRead(after.refusals, reading.date) !== null\n    || restatementSettles(reading, after.restatedFrom)\n    || confirmationSettles(reading, after.confirmedOn);",
    "  return restatementSettles(reading, after.restatedFrom)\n    || confirmationSettles(reading, after.confirmedOn);"],

  ["a-restatement-stops-settling-the-read", "src/read-date.ts",
    "  return howWeSettledTheRead(after.refusals, reading.date) !== null\n    || restatementSettles(reading, after.restatedFrom)\n    || confirmationSettles(reading, after.confirmedOn);",
    "  return howWeSettledTheRead(after.refusals, reading.date) !== null\n    || confirmationSettles(reading, after.confirmedOn);"],

  ["a-confirmation-stops-settling-the-read", "src/read-date.ts",
    "  return howWeSettledTheRead(after.refusals, reading.date) !== null\n    || restatementSettles(reading, after.restatedFrom)\n    || confirmationSettles(reading, after.confirmedOn);",
    "  return howWeSettledTheRead(after.refusals, reading.date) !== null\n    || restatementSettles(reading, after.restatedFrom);"],

  ["a-restatement-from-before-the-read-settles-it", "src/read-date.ts",
    "  return restatedFrom !== null && restatedFrom >= reading.date;",
    "  return restatedFrom !== null;"],

  ["a-restatement-from-that-same-read-stops-settling-it", "src/read-date.ts",
    "  return restatedFrom !== null && restatedFrom >= reading.date;",
    "  return restatedFrom !== null && restatedFrom > reading.date;"],

  ["a-confirmation-the-same-read-disagreed-with-settles-it", "src/read-date.ts",
    "  return confirmedOn !== null && confirmedOn > reading.date;",
    "  return confirmedOn !== null && confirmedOn >= reading.date;"],

  ["any-confirmation-ever-held-settles-the-read", "src/read-date.ts",
    "  return confirmedOn !== null && confirmedOn > reading.date;",
    "  return confirmedOn !== null;"],

  ["the-notice-stops-naming-the-day-of-the-read", "src/read-date.ts",
    "  return `Our read on ${reading.date} ${WHAT_THE_LAST_READ_FOUND[OUTCOME_CONTRADICTING_WHAT_WE_STORE]},`",
    "  return `Our last read ${WHAT_THE_LAST_READ_FOUND[OUTCOME_CONTRADICTING_WHAT_WE_STORE]},`"],

  ["the-notice-stops-saying-what-the-read-found", "src/read-date.ts",
    "  return `Our read on ${reading.date} ${WHAT_THE_LAST_READ_FOUND[OUTCOME_CONTRADICTING_WHAT_WE_STORE]},`",
    "  return `Our read on ${reading.date} could not be reconciled,`"],

  ["the-ranked-table-stops-marking-a-contradicting-read", "src/serve.ts",
    "  if (!unconfirmed || !offer.stability) return terms + contradictedTermsMarkerHtml(offer);",
    "  if (!unconfirmed || !offer.stability) return terms;"],

  ["the-count-stops-covering-the-rows-it-newly-flags", "src/serve.ts",
    "  return supersedingChangeFor(offer) === null && !nothingWeHoldContradicts(offer);",
    "  return supersedingChangeFor(offer) === null && unconfirmedTermsFor(offer) !== null;"],
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
