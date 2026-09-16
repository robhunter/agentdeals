import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/reverify-rolling.test.ts", "test/change-refusals.test.ts"];

const MUTANTS = [
  ["the-queue-goes-back-to-sorting-on-age-alone", "scripts/reverify-rolling.js",
    "  const drawAge = (entry) => entry.ts + (entry.deferred ? deferralMs(turnDays) : 0);",
    "  const drawAge = (entry) => entry.ts;"],

  ["a-page-we-could-not-reach-is-deferred-too", "scripts/queue-order.js",
    "export const OUTCOMES_A_READING_ANSWERED_WITH_NOTHING = [\n  SOURCE_CHECK_NOT_NAMED,\n  SOURCE_CHECK_NOT_THE_PRODUCT,\n  SOURCE_CHECK_NO_TERMS,\n];",
    'export const OUTCOMES_A_READING_ANSWERED_WITH_NOTHING = [\n  SOURCE_CHECK_NOT_NAMED,\n  SOURCE_CHECK_NOT_THE_PRODUCT,\n  SOURCE_CHECK_NO_TERMS,\n  "unreadable",\n];'],

  ["the-deferral-becomes-a-tier-that-never-expires", "scripts/queue-order.js",
    "export function deferralMs(turnDays) {\n  return Math.max(0, turnDays) * MS_PER_DAY;\n}",
    "export function deferralMs(turnDays) {\n  return Math.max(0, turnDays) * MS_PER_DAY * 10000;\n}"],

  ["the-turn-is-a-stored-number-instead-of-one-it-derives", "scripts/queue-order.js",
    "export function oneTurnOfTheQueue(queueLength, limit) {\n  if (!Number.isFinite(limit) || limit <= 0) return 0;\n  return Math.ceil(Math.max(0, queueLength) / limit);\n}",
    "export function oneTurnOfTheQueue(queueLength, limit) {\n  if (!Number.isFinite(limit) || limit <= 0) return 0;\n  return 20;\n}"],

  ["the-turn-is-taken-from-the-catalogue-rather-than-the-live-queue", "scripts/reverify-rolling.js",
    "  const liveQueueLength = entries.filter(\n    (entry) => !isQuarantined(entry.record) && !entry.awaitingCorroboration\n  ).length;",
    "  const liveQueueLength = entries.length;"],

  ["the-deferral-reorders-the-quarantine-retries-as-well", "scripts/reverify-rolling.js",
    "  const dueRetries = entries\n    .filter((entry) => isQuarantined(entry.record) && quarantineRetryDue(entry.record, today))\n    .sort(byAge);",
    "  const dueRetries = entries\n    .filter((entry) => isQuarantined(entry.record) && quarantineRetryDue(entry.record, today))\n    .sort(byDrawAge);"],

  ["a-deferred-record-is-drawn-ahead-rather-than-behind", "scripts/reverify-rolling.js",
    "  const drawAge = (entry) => entry.ts + (entry.deferred ? deferralMs(turnDays) : 0);",
    "  const drawAge = (entry) => entry.ts - (entry.deferred ? deferralMs(turnDays) : 0);"],

  ["the-run-stops-saying-how-many-it-deferred", "scripts/queue-order.js",
    "    `Deferred a turn because the page answered their last reading with nothing: ${deferred} of ${queueLength}`,",
    "    `Drawn from the queue: ${queueLength}`,"],

  ["the-rule-stops-excepting-a-page-we-never-reached", "scripts/queue-order.js",
    '+ "run\'s limit. A reading that never reached the page is not deferred: that record has not been read at all, "\n    + "and it keeps the place the queue already gives it. The deferral expires by arithmetic rather than by a "',
    '+ "run\'s limit. The deferral expires by arithmetic rather than by a "'],

  ["the-deferral-is-decided-by-the-publishing-predicate-again", "scripts/queue-order.js",
    "export function readAnsweredWithNothing(offer) {\n  return ANSWERED_WITH_NOTHING.has(offer?.source_check?.outcome);\n}",
    'export function readAnsweredWithNothing(offer) {\n  return ANSWERED_WITH_NOTHING.has(offer?.source_check?.outcome)\n    || offer?.source_check?.outcome === "unreadable";\n}'],

  ["a-record-nobody-has-checked-is-deferred", "scripts/queue-order.js",
    "export function readAnsweredWithNothing(offer) {\n  return ANSWERED_WITH_NOTHING.has(offer?.source_check?.outcome);\n}",
    "export function readAnsweredWithNothing(offer) {\n  return !offer?.source_check || ANSWERED_WITH_NOTHING.has(offer.source_check.outcome);\n}"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, TZ: "UTC" } });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`REFUSED  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const green = run("npx", ["tsx", "--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}
const killed = MUTANTS.length - survivors.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (skipped.length > 0) console.log("REFUSED — target string moved, so these scored nothing:", skipped.join(", "));
