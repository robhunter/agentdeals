import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/refused-change-not-stable.test.ts",
  "test/vendor-verdict.test.ts",
  "test/badge-withholding.test.ts",
  "test/meta-description-withholding.test.ts",
];

const MUTANTS = [
  ["no-read-is-ever-named-as-one-since-the-refusal", "src/change-refusal.ts",
    "  return lastReadOn > refusal.refused_date ? lastReadOn : null;",
    "  return null;"],

  ["every-read-is-named-as-one-since-the-refusal", "src/change-refusal.ts",
    "  return lastReadOn > refusal.refused_date ? lastReadOn : null;",
    "  return lastReadOn;"],

  ["the-refusals-own-day-counts-as-a-read-since-it", "src/change-refusal.ts",
    "  return lastReadOn > refusal.refused_date ? lastReadOn : null;",
    "  return lastReadOn >= refusal.refused_date ? lastReadOn : null;"],

  ["a-read-before-the-refusal-counts-as-one-since-it", "src/change-refusal.ts",
    "  return lastReadOn > refusal.refused_date ? lastReadOn : null;",
    "  return lastReadOn < refusal.refused_date ? lastReadOn : null;"],

  ["a-later-read-clears-the-withholding", "src/change-refusal.ts",
    "      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn),\n    ),\n  );\n  return held === null ? null : { ...held, read_again_on: readAgainAfterTheRefusal(held, lastReadOn) };",
    "      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn)\n        && !(lastReadOn > r.refused_date),\n    ),\n  );\n  return held === null ? null : { ...held, read_again_on: readAgainAfterTheRefusal(held, lastReadOn) };"],

  ["the-verdict-clause-ignores-the-read-it-holds", "src/vendor-verdict.ts",
    "export function refusedReadWithholdingClause(because: RefusedReadWithholding): string {\n  if (because.readAgainOn) {",
    "export function refusedReadWithholdingClause(because: RefusedReadWithholding): string {\n  if (because.readAgainOn && because.refusedOn.length < 0) {"],

  ["the-verdict-sentence-ignores-the-read-it-holds", "src/vendor-verdict.ts",
    "): string {\n  if (because.readAgainOn) {\n    return because.reason === \"change_measured_no_difference\"\n      ? measuredNoDifferenceThenReadAgainSentence(subject, because.refusedOn, because.readAgainOn)",
    "): string {\n  if (because.readAgainOn && because.refusedOn.length < 0) {\n    return because.reason === \"change_measured_no_difference\"\n      ? measuredNoDifferenceThenReadAgainSentence(subject, because.refusedOn, because.readAgainOn)"],

  ["the-meta-clause-ignores-the-read-it-holds", "src/vendor-verdict.ts",
    "export function refusedReadWithholdingMetaClause(because: RefusedReadWithholding): string {\n  if (because.readAgainOn) {",
    "export function refusedReadWithholdingMetaClause(because: RefusedReadWithholding): string {\n  if (because.readAgainOn && because.refusedOn.length < 0) {"],

  ["a-named-read-loses-the-register-of-its-refusal", "src/vendor-verdict.ts",
    "      ? measuredNoDifferenceThenReadAgainSentence(subject, because.refusedOn, because.readAgainOn)\n      : unreconciledReadThenReadAgainSentence(subject, because.refusedOn, because.readAgainOn);",
    "      ? unreconciledReadThenReadAgainSentence(subject, because.refusedOn, because.readAgainOn)\n      : unreconciledReadThenReadAgainSentence(subject, because.refusedOn, because.readAgainOn);"],

  ["the-withholding-carries-no-read-off-the-refusal", "src/vendor-verdict.ts",
    "      reason: \"change_measured_no_difference\",\n      refusedOn: refusal.refused_date,\n      readAgainOn: refusal.read_again_on,",
    "      reason: \"change_measured_no_difference\",\n      refusedOn: refusal.refused_date,\n      readAgainOn: null,"],

  ["the-unreconciled-withholding-carries-no-read-off-the-refusal", "src/vendor-verdict.ts",
    "      reason: \"read_not_reconciled\",\n      refusedOn: refusal.refused_date,\n      readAgainOn: refusal.read_again_on,",
    "      reason: \"read_not_reconciled\",\n      refusedOn: refusal.refused_date,\n      readAgainOn: null,"],

  ["the-catalogue-reads-the-catalogue-date-as-our-last-read", "src/data.ts",
    "    lastReadOn: lastReadDate(offer),",
    "    lastReadOn: offer.verifiedDate,"],

  ["the-vendor-page-reads-the-catalogue-date-as-our-last-read", "src/vendor-verdict-input.ts",
    "      lastReadOn: enriched.last_read_date,",
    "      lastReadOn: primary.verifiedDate,"],

  ["the-meta-clause-names-a-read-that-is-the-refusal", "src/vendor-verdict.ts",
    "      ? measuredNoDifferenceThenReadAgainMetaClause(because.refusedOn, because.readAgainOn)\n      : unreconciledReadThenReadAgainMetaClause(because.refusedOn, because.readAgainOn);",
    "      ? measuredNoDifferenceThenReadAgainMetaClause(because.refusedOn, because.refusedOn)\n      : unreconciledReadThenReadAgainMetaClause(because.refusedOn, because.refusedOn);"],

  ["the-named-read-is-the-day-we-refused", "src/change-refusal.ts",
    "  return lastReadOn > refusal.refused_date ? lastReadOn : null;",
    "  return lastReadOn > refusal.refused_date ? refusal.refused_date : null;"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const occurrences = original.split(from).length - 1;
  if (occurrences !== 1) {
    console.log(`SKIP  ${name} — ${occurrences} matches in ${file}, so it scores nothing`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
