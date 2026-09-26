import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { restatementsTheIndexNeverTook } from "./restate-superseded-terms.js";
import { BASELINE_MOVED, keyOfReading, readingKey, serializeStore } from "./change-corroboration.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const ledgerPath = `${root}/data/restated_terms.json`;
const corroborationPath = `${root}/data/change_corroboration.json`;
const ledgerDoc = JSON.parse(readFileSync(ledgerPath, "utf-8"));
const offers = JSON.parse(readFileSync(`${root}/data/index.json`, "utf-8")).offers;
const corroboration = JSON.parse(readFileSync(corroborationPath, "utf-8"));

const ledger = ledgerDoc.restatements;
const key = (e) => `${e.vendor.toLowerCase()}|${e.url}`;
const offerByKey = new Map(offers.map((o) => [key(o), o]));

const neverTook = new Set(restatementsTheIndexNeverTook(ledger, offers));
const drop = new Set(neverTook);
const groups = new Map();
for (const entry of ledger.filter((e) => !e.reverted_on)) {
  const reading = `${key(entry)}|${entry.reading_date}|${entry.description}`;
  if (!groups.has(reading)) groups.set(reading, []);
  groups.get(reading).push(entry);
}
for (const entries of groups.values()) {
  if (entries.length < 2) continue;
  const offer = offerByKey.get(key(entries[0]));
  const taken = entries.find((e) => offer?.restated_from?.restated_on === e.restated_on);
  for (const entry of entries) if (entry !== taken) drop.add(entry);
}

const daysADroppedRestatementRan = new Map();
for (const entry of drop) {
  const readingOf = readingKey(entry.vendor, entry.url);
  const days = daysADroppedRestatementRan.get(readingOf) ?? new Set();
  days.add(entry.restated_on);
  daysADroppedRestatementRan.set(readingOf, days);
}
const resolvedOnADroppedDay = (r) => daysADroppedRestatementRan.get(keyOfReading(r))?.has(r.resolved_date) ?? false;

const releasedByADroppedRestatement = corroboration.resolved.filter(
  (r) => r.outcome === BASELINE_MOVED && resolvedOnADroppedDay(r),
);
const heldBeforeTheRunThatReleasedIt = releasedByADroppedRestatement.filter((r) => r.first_read_date !== r.resolved_date);
if (heldBeforeTheRunThatReleasedIt.length > 0) {
  console.error("These readings were held before the run that released them, so dropping the release would lose a reading held across runs:");
  for (const r of heldBeforeTheRunThatReleasedIt) console.error(`  ${r.vendor} first read ${r.first_read_date}, released ${r.resolved_date}`);
  process.exit(1);
}

console.log("Dropped from the ledger:");
for (const entry of drop) console.log(`  ${entry.vendor} ${entry.restated_on}${neverTook.has(entry) ? " (the index never took it)" : " (the same reading written again)"}`);
console.log("Released readings dropped (first read and released by a run whose restatement is dropped):");
for (const r of releasedByADroppedRestatement) console.log(`  ${r.vendor} first read ${r.first_read_date}, released ${r.resolved_date}`);
const resolvedAnotherWayOnADroppedDay = corroboration.resolved.filter(
  (r) => r.outcome !== BASELINE_MOVED && resolvedOnADroppedDay(r),
);
console.log("Left alone, resolved another way on a dropped day:");
for (const r of resolvedAnotherWayOnADroppedDay) console.log(`  ${r.vendor} ${r.outcome}, first read ${r.first_read_date}, resolved ${r.resolved_date}`);

if (write) {
  ledgerDoc.restatements = ledger.filter((e) => !drop.has(e));
  writeFileSync(ledgerPath, `${JSON.stringify(ledgerDoc, null, 2)}\n`);
  corroboration.resolved = corroboration.resolved.filter((r) => !releasedByADroppedRestatement.includes(r));
  writeFileSync(corroborationPath, serializeStore(corroboration));
  console.log("Written.");
}
