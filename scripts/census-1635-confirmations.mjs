import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.AGENTDEALS_VERIFICATION_STATE_PATH || path.join(REPO, "data", "verification_state.json");
const INDEX = process.env.AGENTDEALS_INDEX_PATH || path.join(REPO, "data", "index.json");
const STORE_IN_GIT = "data/verification_state.json";
const ANSWERED = new Set(["confirmed", "changed", "link_ok", "states_no_price"]);
const STAGGER_DAYS = 3;

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

export function observedByTheStore(snapshots) {
  const confirmations = new Map();
  const reads = new Map();
  for (const { records } of snapshots) {
    for (const record of records) {
      if (!record?.vendor || !record?.url) continue;
      const k = key(record.vendor, record.url);
      const stamped = record.last_attempt_at ?? null;
      if (!stamped) continue;
      if (!ANSWERED.has(record.last_outcome)) continue;
      if (!reads.has(k)) reads.set(k, new Set());
      reads.get(k).add(stamped);
      if (record.last_outcome !== "confirmed") continue;
      if (!confirmations.has(k)) confirmations.set(k, new Set());
      confirmations.get(k).add(record.last_success ?? stamped);
    }
  }
  return { confirmations, reads };
}

export function unsourcedStamps(records, observed) {
  const unsourced = [];
  for (const record of records) {
    const k = key(record.vendor, record.url);
    const success = record.last_success ?? null;
    const read = record.last_read_at ?? null;
    const staleSuccess = success && !observed.confirmations.get(k)?.has(success);
    const staleRead = read && !observed.reads.get(k)?.has(read);
    if (staleSuccess || staleRead) {
      unsourced.push({ record, clearSuccess: Boolean(staleSuccess), clearRead: Boolean(staleRead) });
    }
  }
  return unsourced;
}

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function confirmationCensus(offers, byKey) {
  const states = { sourced: [], none: [], storeIsNewer: [], noRecord: [] };
  for (const offer of offers) {
    const record = byKey.get(key(offer.vendor, offer.url));
    if (!record) {
      states.noRecord.push(offer.vendor);
      continue;
    }
    const success = record.last_success ?? null;
    if (!success) {
      states.none.push({ vendor: offer.vendor, published: offer.verifiedDate, outcome: record.last_outcome });
      continue;
    }
    if (daysBetween(offer.verifiedDate, success) > STAGGER_DAYS) {
      states.storeIsNewer.push({ vendor: offer.vendor, published: offer.verifiedDate, success, behind: daysBetween(offer.verifiedDate, success) });
      continue;
    }
    states.sourced.push({ vendor: offer.vendor, published: offer.verifiedDate, success });
  }
  return states;
}

function main() {
  const write = process.argv.includes("--write");
  const snapshots = everyCommittedStore();
  const observed = observedByTheStore(snapshots);
  const store = JSON.parse(fs.readFileSync(STATE, "utf-8"));
  const offers = JSON.parse(fs.readFileSync(INDEX, "utf-8")).offers;
  const byKey = new Map(store.records.map((r) => [key(r.vendor, r.url), r]));

  const before = confirmationCensus(offers, byKey);
  const unsourced = unsourcedStamps(store.records, observed);

  console.log(`store snapshots read from git: ${snapshots.length}`);
  console.log(`keys the store ever confirmed: ${observed.confirmations.size}`);
  console.log(`records holding a last_success: ${store.records.filter((r) => r.last_success).length}`);
  console.log(`records holding a last_read_at: ${store.records.filter((r) => r.last_read_at).length}`);
  console.log("");
  console.log(`catalogue offers: ${offers.length}`);
  console.log(`  confirmation the store can source : ${before.sourced.length}`);
  console.log(`  no confirmation held              : ${before.none.length}`);
  console.log(`  store confirmed later than we say : ${before.storeIsNewer.length}`);
  console.log(`  no store record at all            : ${before.noRecord.length}`);
  console.log("");
  console.log(`records whose stamp the store never observed: ${unsourced.length}`);
  console.log(`  last_success to clear: ${unsourced.filter((u) => u.clearSuccess).length}`);
  console.log(`  last_read_at to clear: ${unsourced.filter((u) => u.clearRead).length}`);
  const sameAsPublished = unsourced.filter((u) => {
    const offer = offers.find((o) => key(o.vendor, o.url) === key(u.record.vendor, u.record.url));
    return u.clearSuccess && offer && offer.verifiedDate === u.record.last_success;
  });
  console.log(`  last_success equal to the date we publish: ${sameAsPublished.length}`);
  for (const u of unsourced.slice(0, 5)) {
    console.log(`    ${u.record.vendor} success=${u.record.last_success} read=${u.record.last_read_at ?? "null"} outcome=${u.record.last_outcome}`);
  }

  if (!write) {
    console.log("\nnothing written — pass --write to clear the stamps the store never observed");
    return;
  }

  for (const { record, clearSuccess, clearRead } of unsourced) {
    if (clearSuccess) record.last_success = null;
    if (clearRead) record.last_read_at = null;
  }
  fs.writeFileSync(STATE, `${JSON.stringify(store, null, 2)}\n`);
  const after = confirmationCensus(offers, byKey);
  console.log("");
  console.log(`written. catalogue offers now:`);
  console.log(`  confirmation the store can source : ${after.sourced.length}`);
  console.log(`  no confirmation held              : ${after.none.length}`);
  console.log(`  store confirmed later than we say : ${after.storeIsNewer.length}`);
  console.log(`  no store record at all            : ${after.noRecord.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
