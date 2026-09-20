import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = ["test/staleness-keys-on-the-reading.test.ts"];

const MUTANTS = [
  ["a-confirming-reading-stops-clearing-the-demerit", "src/ranking.ts",
    "  if (reading?.confirmed) return null;",
    "  if (false) return null;"],

  ["a-confirmation-inside-the-window-stops-standing", "src/ranking.ts",
    "  if (reading && !reading.read_the_page && insideTheStalenessWindow(reading.last_success, date)) return null;",
    ""],

  ["a-confirmation-stands-however-old-it-is", "src/ranking.ts",
    "  if (reading && !reading.read_the_page && insideTheStalenessWindow(reading.last_success, date)) return null;",
    "  if (reading && !reading.read_the_page && reading.last_success) return null;"],

  ["a-reading-that-could-not-confirm-waits-for-the-catalogue-date", "src/ranking.ts",
    `  if (reading && !reading.settles) {
    const attempts = attemptsOf(reading);
    if (attempts) return { basis: "could_not_read", attempts };
    return { basis: "could_not_confirm", reading };
  }`,
    ""],

  ["a-reading-that-disagreed-is-demoted-at-once", "src/ranking.ts",
    "  if (reading && !reading.settles) {",
    "  if (reading) {"],

  ["the-window-stops-bounding-which-reading-counts", "src/ranking.ts",
    "  return age >= 0 && age <= STALE_VERIFICATION_DAYS;",
    "  return true;"],

  ["a-reading-dated-in-the-future-counts", "src/ranking.ts",
    "  return age >= 0 && age <= STALE_VERIFICATION_DAYS;",
    "  return age <= STALE_VERIFICATION_DAYS;"],

  ["the-day-count-branch-answers-for-every-record", "src/ranking.ts",
    "  if (age <= STALE_VERIFICATION_DAYS) return null;",
    "  if (age < 0) return null;"],

  ["failed-attempts-stop-being-counted", "src/ranking.ts",
    "  if (reading.consecutive_failures < 1) return null;",
    "  return null;"],

  ["every-reading-counts-as-a-failed-attempt", "src/ranking.ts",
    "  if (reading.consecutive_failures < 1) return null;",
    "  if (false) return null;"],

  ["the-attempt-is-dated-from-another-page-of-the-same-vendor", "src/ranking.ts",
    "    last_attempt: reading.date,",
    "    last_attempt: reading.last_success ?? reading.date,"],

  ["the-reason-stops-naming-the-reading-date", "src/ranking.ts",
    "      `Our last read of the vendor's pricing page, on ${reading.date}, ${reading.found ?? A_READING_THAT_DID_NOT_CONFIRM}. ` +",
    "      `Our last read of the vendor's pricing page ${reading.found ?? A_READING_THAT_DID_NOT_CONFIRM}. ` +"],

  ["the-failed-attempts-lose-their-singular", "src/ranking.ts",
    `  const counted = attempts.consecutive_failures === 1 ? "attempt has" : "attempts have";`,
    `  const counted = "attempts have";`],

  ["the-criteria-row-stops-publishing-the-count", "src/ranking.ts",
    "  return row.census ? `${row.trigger} ${row.census(offers, date, ledger, lastReading)}` : row.trigger;",
    "  return row.trigger;"],

  ["the-criteria-count-drops-the-readings-it-cannot-confirm", "src/ranking.ts",
    `  const held = doubts.filter((d): d is VerificationDoubt => d !== null);`,
    `  const held = doubts.filter((d): d is VerificationDoubt => d !== null && d.basis !== "could_not_confirm");`],

  ["the-reason-stops-saying-what-the-reading-found", "src/read-date.ts",
    "    found: WHAT_THE_LAST_READ_FOUND[outcome] ?? null,",
    "    found: null,"],

  ["every-outcome-reads-as-a-confirmation", "src/read-date.ts",
    "    confirmed: outcome === OUTCOME_THAT_CONFIRMED,",
    "    confirmed: true,"],

  ["no-outcome-reads-as-a-confirmation", "src/read-date.ts",
    "    confirmed: outcome === OUTCOME_THAT_CONFIRMED,",
    "    confirmed: false,"],

  ["a-disagreement-settles-nothing", "src/read-date.ts",
    "    settles: CAN_SETTLE.has(outcome),",
    "    settles: false,"],

  ["every-reading-settles-the-record", "src/read-date.ts",
    "    settles: CAN_SETTLE.has(outcome),",
    "    settles: true,"],

  ["every-attempt-counts-as-having-read-the-page", "src/read-date.ts",
    "    read_the_page: outcomeReadThePage(outcome),",
    "    read_the_page: true,"],

  ["a-record-with-no-ledger-entry-holds-no-reading", "src/read-date.ts",
    "  if (!record || !date || !outcome) return readingFromSourceCheck(offer);",
    "  if (!record || !date || !outcome) return null;"],
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
