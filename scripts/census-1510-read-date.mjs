#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWERED_OUTCOMES } from "./verification-state.js";
import { offerKey } from "./change-refusals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const idx = JSON.parse(readFileSync(resolve(root, "data/index.json"), "utf-8"));
const state = JSON.parse(readFileSync(resolve(root, "data/verification_state.json"), "utf-8"));
const byKey = new Map(state.records.map((r) => [offerKey(r.vendor, r.url), r]));

const days = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const rows = idx.offers.map((offer) => {
  const record = byKey.get(offerKey(offer.vendor, offer.url)) ?? null;
  const answered = record && ANSWERED_OUTCOMES.has(record.last_outcome)
    ? record.last_attempt_at
    : null;
  const readDate = [offer.verifiedDate, answered].filter(Boolean).sort().pop();
  return { offer, record, answered, readDate, gap: days(offer.verifiedDate, readDate) };
});

const withGap = rows.filter((r) => r.gap > 0).sort((a, b) => b.gap - a.gap);
console.log("offers:", rows.length);
console.log("no state record:", rows.filter((r) => !r.record).length);
console.log("read date later than verifiedDate:", withGap.length);
console.log("read date == verifiedDate:", rows.filter((r) => r.gap === 0).length);
console.log("read date EARLIER than verifiedDate (must be 0):", rows.filter((r) => r.gap < 0).length);
console.log("median gap of the differing set:", withGap.length ? withGap[Math.floor(withGap.length / 2)].gap : null);
console.log("largest gap:", withGap.length ? withGap[0].gap : null);

const byOutcome = {};
for (const r of withGap) byOutcome[r.record.last_outcome] = (byOutcome[r.record.last_outcome] ?? 0) + 1;
console.log("differing set by last_outcome:", byOutcome);

console.log("\ntop 8 gaps:");
for (const r of withGap.slice(0, 8)) {
  console.log(
    `  ${String(r.gap).padStart(4)}d  ${r.offer.vendor} — verified ${r.offer.verifiedDate}, read ${r.readDate} (${r.record.last_outcome})  ${r.offer.url}`
  );
}

const failed = rows.filter((r) => r.record && !ANSWERED_OUTCOMES.has(r.record.last_outcome));
const byFailure = {};
for (const r of failed) byFailure[r.record.last_outcome] = (byFailure[r.record.last_outcome] ?? 0) + 1;
console.log("\nrecords whose last attempt failed:", failed.length, byFailure);
console.log(
  "  of those, read date later than verifiedDate (would be a regression risk):",
  failed.filter((r) => r.gap > 0).length
);
console.log(
  "  of those, last attempt later than the read date we publish:",
  failed.filter((r) => r.record.last_attempt_at > r.readDate).length
);

const segment = rows.find((r) => /segment/i.test(r.offer.vendor));
if (segment) {
  console.log("\nsegment:", JSON.stringify({ verifiedDate: segment.offer.verifiedDate, readDate: segment.readDate, outcome: segment.record?.last_outcome, last_attempt_at: segment.record?.last_attempt_at }));
}
