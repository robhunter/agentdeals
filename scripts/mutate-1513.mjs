import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/reverify-rolling.test.ts",
  "test/change-refusals.test.ts",
  "test/verification-state.test.ts",
  "test/verification-quarantine-surface.test.ts",
];

const ROLLING = "scripts/reverify-rolling.js";
const STATE = "scripts/verification-state.js";

const MUTANTS = [
  ["the-check-counts-only-when-it-failed", ROLLING,
    `  const dates = [
    offer?.verifiedDate,
    offer?.source_check?.checked,`,
    `  const dates = [
    offer?.verifiedDate,
    holdsVerifiedDate(offer?.source_check?.outcome) ? offer?.source_check?.checked : null,`],
  ["the-check-never-counts", ROLLING,
    `    offer?.source_check?.checked,
    refusedOn,`,
    `    refusedOn,`],
  ["same-age-order-ignores-whether-the-read-answered", ROLLING,
    `  const byAge = (a, b) => a.ts - b.ts || Number(b.readFailed) - Number(a.readFailed);`,
    `  const byAge = (a, b) => a.ts - b.ts;`],
  ["an-answered-read-goes-first-among-equals", ROLLING,
    `  const byAge = (a, b) => a.ts - b.ts || Number(b.readFailed) - Number(a.readFailed);`,
    `  const byAge = (a, b) => a.ts - b.ts || Number(a.readFailed) - Number(b.readFailed);`],
  ["the-read-outcome-outranks-the-date", ROLLING,
    `  const byAge = (a, b) => a.ts - b.ts || Number(b.readFailed) - Number(a.readFailed);`,
    `  const byAge = (a, b) => Number(b.readFailed) - Number(a.readFailed) || a.ts - b.ts;`],
  ["the-batch-count-ignores-the-read-outcome", ROLLING,
    `    pickedAfterAFailedRead: drawn.filter((entry) => entry.readFailed).length,`,
    `    pickedAfterAFailedRead: drawn.length,`],
  ["every-record-reads-as-a-failed-read", STATE,
    `  return Boolean(record) && !ANSWERED_OUTCOMES.has(record.last_outcome);`,
    `  return Boolean(record);`],
  ["a-record-nobody-has-read-reads-as-a-failed-read", STATE,
    `  return Boolean(record) && !ANSWERED_OUTCOMES.has(record.last_outcome);`,
    `  return !ANSWERED_OUTCOMES.has(record?.last_outcome);`],
  ["a-page-we-could-not-use-counts-as-answered", STATE,
    `export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_CONFIRMED,`,
    `export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_CONFIRMED,`],
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
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const green = run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
