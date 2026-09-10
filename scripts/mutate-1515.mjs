import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/no-price-on-the-page-is-a-reading.test.ts",
  "test/reverify-rolling.test.ts",
  "test/verification-state.test.ts",
  "test/verification-quarantine-surface.test.ts",
  "test/vendor-naming.test.ts",
];

const ROLLING = "scripts/reverify-rolling.js";
const STATE = "scripts/verification-state.js";
const NAMING = "scripts/vendor-naming.js";

const MUTANTS = [
  ["a-silent-page-is-a-failed-read-again", STATE,
    `export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_CONFIRMED,
  ATTEMPT_CHANGED,
  ATTEMPT_LINK_OK,
  ATTEMPT_STATES_NO_PRICE,
]);`,
    `export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_CONFIRMED,
  ATTEMPT_CHANGED,
  ATTEMPT_LINK_OK,
]);`],
  ["only-the-page-with-no-free-tier-phrase-is-silent", STATE,
    `  [SOURCE_CHECK_NO_TERMS, ATTEMPT_STATES_NO_PRICE],
  [SOURCE_CHECK_NO_AMOUNT, ATTEMPT_STATES_NO_PRICE],`,
    `  [SOURCE_CHECK_NO_TERMS, ATTEMPT_STATES_NO_PRICE],
  [SOURCE_CHECK_NO_AMOUNT, ATTEMPT_LINK_OK],`],
  ["a-page-that-names-somebody-else-counts-as-silence", STATE,
    `  [SOURCE_CHECK_NOT_NAMED, ATTEMPT_SOURCE_UNUSABLE],`,
    `  [SOURCE_CHECK_NOT_NAMED, ATTEMPT_STATES_NO_PRICE],`],
  ["a-page-we-could-not-fetch-counts-as-silence", STATE,
    `  [SOURCE_CHECK_UNREADABLE, ATTEMPT_FETCH_FAILED],`,
    `  [SOURCE_CHECK_UNREADABLE, ATTEMPT_STATES_NO_PRICE],`],
  ["a-pass-that-recorded-nothing-still-clears-a-failure", STATE,
    `  if (!check?.checked || !checkRecordedAFinding(check)) return null;`,
    `  if (!check?.checked) return null;`],
  ["an-older-reading-clears-a-failure", STATE,
    `  if (record?.last_attempt_at && check.checked <= record.last_attempt_at) return null;`,
    `  if (record?.last_attempt_at && check.checked < record.last_attempt_at) return null;`],
  ["a-later-reading-that-failed-clears-the-failure-too", STATE,
    `    if (!reading || !ANSWERED_OUTCOMES.has(reading.outcome)) continue;`,
    `    if (!reading) continue;`],
  ["clearing-runs-over-records-whose-last-read-answered", STATE,
    `    if (!record || !lastReadFailed(record)) continue;`,
    `    if (!record) continue;`],
  ["the-forecast-counts-the-attempt-rather-than-the-reading", STATE,
    `    const latest = attemptForSourceCheck(offer?.source_check?.outcome) ?? record.last_outcome;`,
    `    const latest = record.last_outcome;`],
  ["the-free-tier-phrase-decides-the-attempt-again", ROLLING,
    `    const readAPageAboutThisOffer = sourceOk || statesNoPrice;`,
    `    const readAPageAboutThisOffer = sourceOk;`],
  ["a-silent-page-the-model-could-not-read-is-undecided-again", ROLLING,
    `    } else if (statesNoPrice) {
      recorder.note(offer, ATTEMPT_STATES_NO_PRICE, check.detail);
    } else {`,
    `    } else if (false) {
      recorder.note(offer, ATTEMPT_STATES_NO_PRICE, check.detail);
    } else {`],
  ["url-mode-calls-a-silent-page-unusable-again", ROLLING,
    `        if (statesNoPrice) recorder.note(offer, ATTEMPT_STATES_NO_PRICE, check.detail);
        else recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);`,
    `        recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);`],
  ["a-naming-layer-reads-as-a-finding", NAMING,
    `  return !NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING.includes(detail);`,
    `  return true;`],
  ["an-empty-detail-reads-as-a-finding", NAMING,
    `  if (detail === "") return false;`,
    `  if (detail === "") return true;`],
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
