import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pickOldestEntries, quarantineRetryBudget } from "./reverify-rolling.js";
import { readVerificationState } from "./verification-state.js";
import { offerKey } from "./change-refusals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const LIMIT = Number(process.env.LIMIT || 75);
const NOW = new Date(process.env.RUN_DATE || "2026-09-14T06:00:00Z");
const SIZES = [0, 4, 8, 16, 24];

const data = JSON.parse(readFileSync(resolve(REPO, "data", "index.json"), "utf8"));
const offers = data.offers ?? data;
const state = readVerificationState();

const freshestFirst = [...offers]
  .filter((offer) => offer?.vendor && offer?.url)
  .sort((a, b) => String(b.verifiedDate ?? "").localeCompare(String(a.verifiedDate ?? "")));

const heldSet = (n) => new Set(freshestFirst.slice(0, n).map((o) => offerKey(o.vendor, o.url)));

const rows = [];
const drawnKeys = new Map();
for (const size of SIZES) {
  const awaiting = heldSet(size);
  const result = pickOldestEntries(offers, LIMIT, NOW, {
    verificationState: state,
    awaitingCorroboration: awaiting,
  });
  const keys = result.picked.map(({ offer }) => offerKey(offer.vendor, offer.url));
  const nonHeld = keys.filter((k) => !awaiting.has(k));
  drawnKeys.set(size, nonHeld);
  rows.push({
    held: size,
    picked: result.picked.length,
    secondReadings: result.pickedForASecondReading,
    freshDrawn: nonHeld.length,
    retriedFromQuarantine: result.retriedFromQuarantine,
    retryBudget: quarantineRetryBudget(LIMIT),
    oldestRemaining: result.oldestRemaining,
  });
}

const baseline = new Set(drawnKeys.get(0));
console.log(`limit=${LIMIT}  offers=${offers.length}  run date=${NOW.toISOString().slice(0, 10)}`);
console.log("");
console.log("held | picked | 2nd readings | fresh drawn | displaced vs held=0 | retried | oldestRemaining");
for (const row of rows) {
  const drawn = drawnKeys.get(row.held);
  const displaced = [...baseline].filter((k) => !drawn.includes(k)).length;
  console.log(
    `${String(row.held).padStart(4)} | ${String(row.picked).padStart(6)} | ${String(row.secondReadings).padStart(12)} | ` +
      `${String(row.freshDrawn).padStart(11)} | ${String(displaced).padStart(19)} | ${String(row.retriedFromQuarantine).padStart(7)} | ${row.oldestRemaining}`,
  );
}

console.log("");
const identical = SIZES.every((size) => {
  const drawn = drawnKeys.get(size);
  return drawn.length === baseline.size && drawn.every((k) => baseline.has(k));
});
console.log(identical
  ? "The fresh draw is the same set at every held size."
  : "The fresh draw changes with the held size — each held page displaces a fresh one.");

const eight = drawnKeys.get(0).filter((k) => !drawnKeys.get(8).includes(k));
if (eight.length > 0) {
  console.log("");
  console.log(`Displaced at held=8 (${eight.length}):`);
  for (const key of eight) {
    const offer = offers.find((o) => offerKey(o.vendor, o.url) === key);
    const record = state.get(key);
    console.log(
      `  ${offer.vendor} — verifiedDate ${offer.verifiedDate ?? "(none)"}, last attempt ${record?.last_attempt_at ?? "(none)"}`,
    );
  }
}
