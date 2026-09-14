import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { holdsVerifiedDate } from "./vendor-naming.js";
import { ANSWERED_OUTCOMES, ATTEMPT_CONFIRMED, attemptForSourceCheck } from "./verification-state.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.AGENTDEALS_VERIFICATION_STATE_PATH || path.join(REPO, "data", "verification_state.json");
const INDEX = process.env.AGENTDEALS_INDEX_PATH || path.join(REPO, "data", "index.json");
const STORE_IN_GIT = "data/verification_state.json";

const key = (vendor, url) => `${vendor}|${url}`;

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}

function everyCommittedStore() {
  const shas = git(["log", "--format=%H", "--reverse", "--", STORE_IN_GIT]).trim().split("\n").filter(Boolean);
  return shas.map((sha) => {
    const parsed = JSON.parse(git(["show", `${sha}:${STORE_IN_GIT}`]));
    return { sha, records: Array.isArray(parsed?.records) ? parsed.records : [] };
  });
}

export function confirmationsTheStoreObserved(snapshots) {
  const dates = new Map();
  for (const { records } of snapshots) {
    for (const record of records) {
      if (record?.last_outcome !== ATTEMPT_CONFIRMED) continue;
      const stamped = record.last_success ?? record.last_attempt_at ?? null;
      if (!record?.vendor || !record?.url || !stamped) continue;
      const k = key(record.vendor, record.url);
      if (!dates.has(k)) dates.set(k, new Set());
      dates.get(k).add(stamped);
    }
  }
  return dates;
}

export function confirmationTheSourceCheckRefused(offer, record) {
  const check = offer?.source_check;
  if (!record || !check || record.last_outcome !== ATTEMPT_CONFIRMED) return null;
  if (!holdsVerifiedDate(check.outcome)) return null;
  if (!record.last_attempt_at || record.last_attempt_at !== check.checked) return null;
  if (record.last_success !== record.last_attempt_at) return null;
  return { on: record.last_attempt_at, outcome: check.outcome, regradedTo: attemptForSourceCheck(check.outcome) };
}

export function confirmationsTheRunRefusedToStamp(offers, byKey) {
  const found = [];
  for (const offer of offers) {
    const record = byKey.get(key(offer.vendor, offer.url));
    const refused = confirmationTheSourceCheckRefused(offer, record);
    if (refused) found.push({ offer, record, ...refused });
  }
  return found;
}

export function confirmationHeldBefore(observed, k, on) {
  const earlier = [...(observed.get(k) ?? [])].filter((date) => date < on).sort();
  return earlier.length > 0 ? earlier[earlier.length - 1] : null;
}

function main() {
  const write = process.argv.includes("--write");
  const store = JSON.parse(fs.readFileSync(STATE, "utf-8"));
  const offers = JSON.parse(fs.readFileSync(INDEX, "utf-8")).offers;
  const byKey = new Map(store.records.map((r) => [key(r.vendor, r.url), r]));
  const observed = confirmationsTheStoreObserved(everyCommittedStore());

  const refused = confirmationsTheRunRefusedToStamp(offers, byKey);
  const regradable = refused.filter((r) => ANSWERED_OUTCOMES.has(r.regradedTo));
  const left = refused.filter((r) => !ANSWERED_OUTCOMES.has(r.regradedTo));

  console.log(`catalogue offers: ${offers.length}, store records: ${store.records.length}`);
  console.log(`records the store confirmed on the same run that held verifiedDate: ${refused.length}`);
  const byOutcome = new Map();
  for (const r of refused) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  for (const [outcome, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) console.log(`  ${outcome}: ${n}`);
  console.log(`  the fixed writer would record a read for: ${regradable.length}`);
  console.log(`  it would record a failed attempt for, left alone: ${left.length}`);

  for (const r of regradable) {
    const before = confirmationHeldBefore(observed, key(r.offer.vendor, r.offer.url), r.on);
    r.fallsBackTo = before;
    console.log(
      `    ${r.offer.vendor}: confirmed ${r.on} → ${r.regradedTo}, last_success → ${before ?? "null"}`
      + ` (verifiedDate ${r.offer.verifiedDate}, untouched)`
    );
  }
  console.log(`  of those, holding an earlier confirmation the store observed: ${regradable.filter((r) => r.fallsBackTo).length}`);

  if (!write) {
    console.log("\nnothing written — pass --write to regrade them as the source check graded the read");
    return;
  }

  for (const r of regradable) {
    r.record.last_outcome = r.regradedTo;
    r.record.last_success = r.fallsBackTo;
  }
  fs.writeFileSync(STATE, `${JSON.stringify(store, null, 2)}\n`);
  const after = confirmationsTheRunRefusedToStamp(offers, byKey);
  console.log(`\nwritten. records the store confirms against a refused stamp: ${after.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
