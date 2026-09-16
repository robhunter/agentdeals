#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lastAttemptedDate, quarantineRetryBudget } from "./reverify-rolling.js";
import { offerKey, readRefusals, refusalHolds } from "./change-refusals.js";
import { isQuarantined, readVerificationState } from "./verification-state.js";
import { pagesAwaitingCorroboration, readHeldReadings } from "./change-corroboration.js";
import { oneTurnOfTheQueue, readAnsweredWithNothing } from "./queue-order.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const read = (name) => JSON.parse(readFileSync(resolve(root, "data", name), "utf8"));

const LIMIT = Number(process.env.LIMIT ?? 75);
const RUNS = Number(process.env.RUNS ?? 120);
const DETECTION_WINDOW_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const offers = read("index.json").offers;
const changes = read("deal_changes.json").changes;
const state = readVerificationState();
const holds = refusalHolds(readRefusals(), offers);
const awaiting = pagesAwaitingCorroboration(readHeldReadings().held);

const isIndexHousekeeping = (c) => c.current_state === "Removed from index";
const isNoLongerInForce = (c) => Boolean(c.resolution?.state && c.resolution.state !== "stands");
const tracked = changes.filter((c) => !isIndexHousekeeping(c) && !isNoLongerInForce(c));
const EVENT_DATED = new Set(["vendor_page", "hand_written"]);
const dayDiff = (from, to) => Math.round((new Date(to) - new Date(from)) / MS_PER_DAY);

function liveQueue() {
  const queue = [];
  for (const offer of offers) {
    const key = offerKey(offer.vendor, offer.url);
    const record = state.get(key) ?? null;
    if (isQuarantined(record) || awaiting.has(key)) continue;
    const attempted = lastAttemptedDate(offer, holds.get(key), record);
    queue.push({
      key,
      vendor: offer.vendor,
      lastDrawnOnDay: attempted ? dayDiff(attempted, TODAY) * -1 : -9999,
      deferred: readAnsweredWithNothing(offer),
    });
  }
  return queue;
}

const TODAY = "2026-09-16";

function simulate(queue, { defer = false, boost = null } = {}) {
  const rows = queue.map((row) => ({ ...row }));
  const budget = LIMIT - quarantineRetryBudget(LIMIT);
  const turn = oneTurnOfTheQueue(rows.length, LIMIT);
  const drawnOn = new Map(rows.map((row) => [row.key, []]));
  let drawsOfADeferredRecord = 0;
  for (let day = 0; day < RUNS; day++) {
    const boosted = boost ? boost(day) : null;
    const key = (row) => row.lastDrawnOnDay
      + (defer && row.deferred ? turn : 0)
      - (boosted?.has(row.vendor) ? turn : 0);
    const order = rows.slice().sort((a, b) => key(a) - key(b));
    for (const row of order.slice(0, budget)) {
      row.lastDrawnOnDay = day;
      drawnOn.get(row.key).push(day);
      if (row.deferred) drawsOfADeferredRecord++;
    }
  }
  return { rows, drawnOn, turn, budget, drawsOfADeferredRecord, draws: RUNS * budget };
}

function intervals(drawnOn) {
  const byKey = new Map();
  for (const [key, days] of drawnOn) {
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
    byKey.set(key, gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : Infinity);
  }
  return byKey;
}

function ageProfile(rows) {
  const ages = rows.map((row) => RUNS - 1 - row.lastDrawnOnDay).sort((a, b) => a - b);
  const at = (q) => ages[Math.min(ages.length - 1, Math.floor(ages.length * q))];
  return { p50: at(0.5), p95: at(0.95), max: ages[ages.length - 1] };
}

const queue = liveQueue();
const before = simulate(queue, { defer: false });
const after = simulate(queue, { defer: true });

console.log(`Live queue: ${queue.length} records, ${queue.filter((r) => r.deferred).length} whose last reading `
  + `reached the page and found nothing it could price (${(queue.filter((r) => r.deferred).length / queue.length * 100).toFixed(1)}%).`);
console.log(`Simulated ${RUNS} runs at limit ${LIMIT}; ${before.budget} drawn from the queue a run after the `
  + `quarantine retry budget. One turn of the queue = ${after.turn} days.\n`);

console.log("AC-3 — the cost, in days since a record was last drawn, after the simulated rotation:");
for (const [label, sim] of [["by age alone", before], ["with the deferral", after]]) {
  const all = ageProfile(sim.rows);
  const drawn = ageProfile(sim.rows.filter((r) => !r.deferred));
  const held = ageProfile(sim.rows.filter((r) => r.deferred));
  console.log(`  ${label.padEnd(30)} whole queue p50 ${all.p50} p95 ${all.p95} max ${all.max}`
    + `   |  pages that can state terms p95 ${drawn.p95} max ${drawn.max}`
    + `   |  pages that cannot p95 ${held.p95} max ${held.max}`);
}

const beforeGaps = intervals(before.drawnOn);
const afterGaps = intervals(after.drawnOn);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const canState = queue.filter((r) => !r.deferred).map((r) => r.key);
const cannot = queue.filter((r) => r.deferred).map((r) => r.key);
console.log("\n  Mean days between one drawing of a record and the next:");
console.log(`    pages that can state terms: ${mean(canState.map((k) => beforeGaps.get(k))).toFixed(1)} → `
  + `${mean(canState.map((k) => afterGaps.get(k))).toFixed(1)}`);
console.log(`    pages that cannot:          ${mean(cannot.map((k) => beforeGaps.get(k))).toFixed(1)} → `
  + `${mean(cannot.map((k) => afterGaps.get(k))).toFixed(1)}`);

const eventDated = tracked.filter((c) => EVENT_DATED.has(c.date_source));
const byVendor = new Map();
for (const change of eventDated) {
  if (!byVendor.has(change.vendor)) byVendor.set(change.vendor, []);
  byVendor.get(change.vendor).push(change);
}
const pairs = [];
for (const [vendor, vendorChanges] of byVendor) {
  if (vendorChanges.length < 2) continue;
  const dates = vendorChanges.map((c) => c.date).sort();
  for (let i = 1; i < dates.length; i++) {
    pairs.push({ vendor, gap: dayDiff(dates[i - 1], dates[i]), second: dates[i] });
  }
}
const inIndex = new Set(offers.map((o) => o.vendor));
const held = new Map(queue.map((row) => [row.vendor, row]));

function readWithinWindowOf(sim, vendor, eventDay) {
  const rows = queue.filter((row) => row.vendor === vendor);
  if (rows.length === 0) return null;
  return rows.some((row) => (sim.drawnOn.get(row.key) ?? [])
    .some((day) => day >= eventDay && day <= eventDay + DETECTION_WINDOW_DAYS));
}

console.log(`  share of all drawings that went to a record whose last reading found nothing: `
  + `${(before.drawsOfADeferredRecord / before.draws * 100).toFixed(1)}% → `
  + `${(after.drawsOfADeferredRecord / after.draws * 100).toFixed(1)}%`);

console.log(`\nAC-2 — the counterfactual on the ${pairs.length} known repeat pairs, `
  + `read within ${DETECTION_WINDOW_DAYS} days of the second change:`);
const placeable = pairs.filter((p) => inIndex.has(p.vendor));
const RECENCY_N = Number(process.env.RECENCY_N ?? 90);
const recordedAgeOf = (c) => (c.recorded_date ? dayDiff(c.recorded_date, TODAY) : Infinity);
const alreadyRecent = new Set(tracked.filter((c) => recordedAgeOf(c) <= RECENCY_N).map((c) => c.vendor));
let beforeHits = 0;
let afterHits = 0;
let recencyHits = 0;
for (const pair of placeable) {
  const eventDay = Math.min(RUNS - DETECTION_WINDOW_DAYS - 1, Math.max(0, pair.gap));
  if (readWithinWindowOf(before, pair.vendor, eventDay)) beforeHits++;
  if (readWithinWindowOf(after, pair.vendor, eventDay)) afterHits++;
  const boosted = new Set([...alreadyRecent, pair.vendor]);
  const recency = simulate(queue, { boost: (day) => (day <= RECENCY_N ? boosted : alreadyRecent) });
  if (readWithinWindowOf(recency, pair.vendor, eventDay)) recencyHits++;
}
console.log(`  ${placeable.length} of ${pairs.length} pairs name a vendor this index holds a record for.`);
console.log(`  by age alone:                      ${beforeHits} of ${placeable.length}`);
console.log(`  with a vendor drawn ahead for ${RECENCY_N} days after a change is recorded for it: `
  + `${recencyHits} of ${placeable.length}`);
console.log(`  with a page that answered its last reading with nothing deferred a turn: `
  + `${afterHits} of ${placeable.length}`);
const deferredPairs = placeable.filter((p) => held.get(p.vendor)?.deferred);
console.log(`  ${deferredPairs.length} of those ${placeable.length} vendors cite a page that answered its last `
  + `reading with nothing, so re-reading it sooner could not have found the second change either.`);

console.log(`\nAC-4 — a change names a vendor; the queue is keyed on a vendor and a URL.`);
const multi = new Map();
for (const row of queue) multi.set(row.vendor, (multi.get(row.vendor) ?? 0) + 1);
const several = [...multi.entries()].filter(([, n]) => n > 1);
console.log(`  ${several.length} vendors hold more than one live record, ${several.reduce((a, [, n]) => a + n, 0)} `
  + `records between them, out of ${queue.length}. Keying the order on the record rather than the vendor would `
  + `move ${several.reduce((a, [, n]) => a + n, 0) - several.length} of them.`);

console.log(`\nThe signal the issue proposed, measured on our own log:`);
const recordedAge = (c) => (c.recorded_date ? dayDiff(c.recorded_date, TODAY) : Infinity);
for (const N of [30, 45, 60, 90, 120, 180]) {
  const recent = new Set(tracked.filter((c) => recordedAge(c) <= N).map((c) => c.vendor));
  const records = queue.filter((row) => recent.has(row.vendor)).length;
  console.log(`  N=${String(N).padStart(3)} days: ${recent.size} vendors, ${records} live records `
    + `(${(records / queue.length * 100).toFixed(1)}% of the queue) would be drawn ahead`);
}
const exposed = new Set(tracked.filter((c) => recordedAge(c) >= 15 && recordedAge(c) <= 30).map((c) => c.vendor));
const outcome = new Set(tracked.filter((c) => recordedAge(c) < 15).map((c) => c.vendor));
const rate = (rows) => {
  const hits = rows.filter((row) => outcome.has(row.vendor)).length;
  return { n: rows.length, hits, pct: rows.length > 0 ? (hits / rows.length) * 100 : 0 };
};
const withPrior = rate(queue.filter((row) => exposed.has(row.vendor)));
const without = rate(queue.filter((row) => !exposed.has(row.vendor)));
console.log(`  a change recorded 15-30 days ago: ${withPrior.hits} of ${withPrior.n} produced another in the `
  + `last 14 days (${withPrior.pct.toFixed(1)}%)`);
console.log(`  no such change:                   ${without.hits} of ${without.n} (${without.pct.toFixed(1)}%)`);
console.log(`  lift: ${(withPrior.pct / without.pct).toFixed(2)}x`);
