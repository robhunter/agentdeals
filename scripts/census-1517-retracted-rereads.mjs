#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChangeEntry, selectNewChanges, baselineKey, SUPPRESSED_SAME_TRANSITION_REGRADED } from "./change-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stored = JSON.parse(readFileSync(resolve(__dirname, "..", "data", "deal_changes.json"), "utf-8")).changes;
const offers = JSON.parse(readFileSync(resolve(__dirname, "..", "data", "index.json"), "utf-8")).offers;

const READING = {
  status: "changed",
  change_type: "limits_reduced",
  summary: "a reading of the page",
  current_state: "terms read off the page today",
  impact: "medium",
};

const withdrawn = stored.filter((change) => change.resolution?.state === "retracted");
const byKey = new Map();
for (const change of stored) {
  const key = baselineKey(change);
  if (key && !byKey.has(key)) byKey.set(key, change);
}

const suppressed = [];
const letThrough = [];

for (const change of withdrawn) {
  const offer = offers.find((o) => o.vendor === change.vendor);
  if (!offer) {
    letThrough.push({ change, why: "the catalogue no longer holds a record for this vendor" });
    continue;
  }
  const candidate = buildChangeEntry(offer, READING, { now: new Date() }).entry;
  const result = selectNewChanges(stored, [candidate], { windowDays: 0 });
  if (result.fresh.length > 0) {
    const why = [];
    if (offer.url !== change.source_url) why.push(`we now cite ${offer.url}, the withdrawn record cited ${change.source_url || "no page"}`);
    if (offer.description !== change.previous_state) why.push("the catalogue no longer holds the terms the withdrawal restored");
    letThrough.push({ change, why: why.join("; ") || "no earlier record covers these terms" });
    continue;
  }
  const collidedWith = result.suppressed[0].collidedWith;
  const against = stored.find((c) => c.vendor === change.vendor && collidedWith?.includes(c.change_type) && collidedWith?.includes(c.date));
  suppressed.push({
    change,
    reason: result.suppressed[0].reason,
    collidedWith,
    againstAWithdrawnRecord: against?.resolution?.state === "retracted",
  });
}

console.log(`Records carrying resolution.state retracted: ${withdrawn.length}`);
console.log(`Re-read today, the rule refuses a new record for: ${suppressed.length}`);
console.log(`Re-read today, the rule lets a new record through for: ${letThrough.length}`);
console.log("");
console.log("Refused:");
for (const { change, reason, collidedWith, againstAWithdrawnRecord } of suppressed) {
  const held = againstAWithdrawnRecord ? "against the withdrawn record itself" : "against a later record we stand behind";
  console.log(`  ${change.vendor.padEnd(22)} ${reason} ${held} — ${collidedWith}`);
}
console.log("");
console.log("Let through:");
for (const { change, why } of letThrough) {
  console.log(`  ${change.vendor.padEnd(22)} ${why}`);
}

const regradings = suppressed.filter((s) => s.reason === SUPPRESSED_SAME_TRANSITION_REGRADED).length;
console.log("");
console.log(`Of the refusals, refused as a re-grading of terms already recorded: ${regradings}`);
