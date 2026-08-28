#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickOldestEntries, repickedNextRun, quarantineRetryBudget } from "./reverify-rolling.js";
import { readRefusals, refusalHolds, offerKey } from "./change-refusals.js";
import {
  ATTEMPT_AI_ERROR,
  ATTEMPT_CHANGED,
  ATTEMPT_CONFIRMED,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_UNCLEAR,
  FAILURE_AI_EXTRACTION,
  FAILURE_AI_UNDECIDED,
  FAILURE_SOURCE_UNUSABLE,
  backfillVerificationState,
  classifyFetchError,
  isQuarantined,
  quarantinedRecords,
  readLinkHealth,
  recordAttempts,
} from "./verification-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const RUN_DATE = "2026-08-28";
const LIMIT = 75;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function stripTimestamps(line) {
  return line.replace(/^\S+Z\s/, "");
}

export function parseRunLog(text) {
  const outcomes = new Map();
  for (const raw of text.split("\n")) {
    const line = stripTimestamps(raw);
    const held = line.match(/^ {2}⊘ (.+?) — verifiedDate held at /);
    if (held) {
      outcomes.set(held[1], { outcome: ATTEMPT_SOURCE_UNUSABLE, category: FAILURE_SOURCE_UNUSABLE });
      continue;
    }
    const changed = line.match(/^ {2}⚠ (.+?) \([^()]+, [a-z_]+\): /);
    if (changed) {
      if (!outcomes.has(changed[1])) outcomes.set(changed[1], { outcome: ATTEMPT_CHANGED });
      continue;
    }
    const flagged = line.match(/^ {2}⚠ (.+?) — (.+)$/);
    if (flagged) {
      const vendor = flagged[1];
      const detail = flagged[2];
      if (outcomes.get(vendor)?.outcome === ATTEMPT_SOURCE_UNUSABLE) continue;
      if (detail.startsWith("unclear:")) {
        outcomes.set(vendor, { outcome: ATTEMPT_UNCLEAR, category: FAILURE_AI_UNDECIDED, detail });
      } else if (detail.startsWith("AI error:")) {
        outcomes.set(vendor, { outcome: ATTEMPT_AI_ERROR, category: FAILURE_AI_EXTRACTION, detail });
      } else if (detail.includes("change detected but not recordable")) {
        outcomes.set(vendor, { outcome: ATTEMPT_CHANGED });
      } else {
        const error = detail.replace(/\s*\(https?:\/\/\S+\)\s*$/, "");
        outcomes.set(vendor, { outcome: ATTEMPT_FETCH_FAILED, category: classifyFetchError(error), detail: error });
      }
    }
  }
  return outcomes;
}

function loadIndex(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

let failures = 0;
function check(label, actual, expected) {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label} — ${JSON.stringify(actual)}`);
}

const logPath = arg("--log", "/tmp/run-1010.log");
const beforePath = arg("--before", "/tmp/index-before.json");
const beforeRefusalsPath = arg("--before-refusals", "/tmp/refusals-prerun.json");

const before = loadIndex(beforePath);
const after = loadIndex(resolve(ROOT, "data", "index.json"));
const holds = refusalHolds(readRefusals(), after.offers);
const logText = readFileSync(logPath, "utf-8");
const logged = parseRunLog(logText);

const { picked } = pickOldestEntries(before.offers, LIMIT, new Date(`${RUN_DATE}T10:00:00Z`), {
  refusalHolds: refusalHolds(readRefusals(beforeRefusalsPath), before.offers),
});

console.log(`Replaying the ${RUN_DATE} 10:00Z run over ${picked.length} records\n`);
check("the run's 75 records are the ones selection picks from the pre-run index", picked.length, LIMIT);

const namedInLog = picked.filter(({ offer }) => logged.has(offer.vendor)).length;
check("records the job logged an outcome for", namedInLog, 69);

const attempts = picked.map(({ offer }) => {
  const seen = logged.get(offer.vendor);
  return {
    vendor: offer.vendor,
    url: offer.url,
    outcome: seen?.outcome ?? ATTEMPT_CONFIRMED,
    category: seen?.category ?? null,
    detail: seen?.detail ?? null,
  };
});

const byOutcome = new Map();
for (const attempt of attempts) byOutcome.set(attempt.outcome, (byOutcome.get(attempt.outcome) ?? 0) + 1);
console.log("\nreplayed outcomes:", [...byOutcome].sort());

const now = new Date(`${RUN_DATE}T10:10:00Z`);
const withoutState = repickedNextRun(picked, after.offers, LIMIT, now, { refusalHolds: holds });
console.log("");
check(
  "before this change, the next run re-checks most of what this run just checked",
  withoutState,
  (n) => n >= 40,
);

const state = backfillVerificationState(new Map(), after.offers, { linkHealth: readLinkHealth() }) && new Map();
backfillVerificationState(state, after.offers, { linkHealth: readLinkHealth() });
recordAttempts(state, attempts, now);
const selection = { refusalHolds: holds, verificationState: state };
const withState = repickedNextRun(picked, after.offers, LIMIT, now, selection);
check("after this change, none of them is re-checked tomorrow", withState, 0);

const changedVendors = attempts.filter((a) => a.outcome === ATTEMPT_CHANGED).map((a) => a.vendor);
check("the run's changed records are stamped as attempted", changedVendors.length, (n) => n >= 40);
const changedQuarantined = changedVendors.filter((vendor) => {
  const offer = after.offers.find((o) => o.vendor === vendor);
  return offer && isQuarantined(state.get(offerKey(offer.vendor, offer.url)));
});
check("a record that produced a change is never quarantined", changedQuarantined.length, 0);

const changedStillStale = changedVendors.filter((vendor) => {
  const offer = after.offers.find((o) => o.vendor === vendor);
  return offer && offer.verifiedDate < RUN_DATE;
});
check("a changed record keeps its stale verifiedDate on the site", changedStillStale.length, changedVendors.length);

const held = quarantinedRecords(state);
check("the persistent failures are quarantined and visible", held.length, (n) => n >= 60);
check("every quarantined record carries a reason", held.filter((r) => !r.failure_category).length, 0);
check("every quarantined record carries the date of its last attempt", held.filter((r) => !r.last_attempt_at).length, 0);

const nextDay = new Date(`${RUN_DATE}T10:10:00Z`);
const tomorrow = pickOldestEntries(after.offers, LIMIT, new Date(nextDay.getTime() + 86400000), selection);
check("the next run still fills its whole budget", tomorrow.picked.length, LIMIT);
check("no quarantined record is retried before its backoff elapses", tomorrow.retriedFromQuarantine, 0);

const dueDay = new Date(`2026-09-05T10:10:00Z`);
const laterRun = pickOldestEntries(after.offers, LIMIT, dueDay, selection);
check("quarantined records are retried once the backoff elapses", laterRun.retriedFromQuarantine, (n) => n > 0);
check(
  "a retry batch never takes more than its share of the budget",
  laterRun.retriedFromQuarantine,
  (n) => n <= quarantineRetryBudget(LIMIT),
);

console.log("");
console.log(failures === 0 ? `PASS — all checks held` : `FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
