import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const { runAiMode } = await import("./reverify-rolling.js");

const scratch = mkdtempSync(path.join(tmpdir(), "e2e-1203-"));
const changesPath = path.join(scratch, "deal_changes.json");
const refusalsPath = path.join(scratch, "change_refusals.json");
writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");

const OFFER = {
  vendor: "Examplebase",
  category: "Databases",
  tier: "Free",
  description: "500 MB storage and 2 GB egress per month, free forever",
  url: "https://examplebase.dev/pricing",
};

const PAGE =
  "Examplebase pricing. Free plan: 250 MB storage and 1 GB egress per month. " +
  "Pro plan $19/month with 10 GB storage. Prices in USD.";

const grade = (change_type, summary) => async () => ({
  status: "changed",
  change_type,
  summary,
  current_state: "Free plan: 250 MB storage and 1 GB egress per month.",
  impact: "medium",
});

const run = (verifyFn) =>
  runAiMode([{ index: 0, offer: OFFER }], { offers: [{ ...OFFER }] }, false, new Date("2026-08-31T09:00:00Z"), {
    fetchFn: async () => ({ ok: true, text: PAGE }),
    verifyFn,
    confirmFn: async () => ({ verdict: "yes", reason: null }),
    rateLimitMs: 0,
    changesPath,
    refusalsPath,
  });

const first = await run(grade("limits_reduced", "Storage cut from 500 MB to 250 MB and egress from 2 GB to 1 GB."));
assert.strictEqual(first.recorded.length, 1, "the first reading should be recorded");
assert.strictEqual(first.recorded[0].change_type, "limits_reduced");

const second = await run(grade("limits_increased", "Storage is now 250 MB and egress 1 GB on the free plan."));
assert.strictEqual(second.recorded.length, 0, "a re-read graded differently should not be recorded");
assert.strictEqual(second.suppressed.length, 1);
assert.strictEqual(second.suppressed[0].reason, "same_transition_graded_differently");

const stored = JSON.parse(readFileSync(changesPath, "utf-8")).changes;
assert.strictEqual(stored.length, 1, `one transition should hold one record, found ${stored.length}`);
assert.strictEqual(stored[0].change_type, "limits_reduced");

const refusals = JSON.parse(readFileSync(refusalsPath, "utf-8")).refusals;
const collision = refusals.find((r) => r.reason === "same_transition_graded_differently");
assert.ok(collision, "the collision should be written to the refusal log");
assert.strictEqual(collision.change_type, "limits_increased");
assert.strictEqual(collision.collided_with, ["Examplebase", "limits_reduced", "2026-08-31", OFFER.url].join("|"));
assert.strictEqual(collision.previous_state, OFFER.description);

const third = await run(grade("limits_reduced", "Storage cut from 500 MB to 250 MB and egress from 2 GB to 1 GB."));
assert.strictEqual(third.suppressed[0].reason, "already_recorded", "an identical re-read keeps its own reason");

console.log("recorded:", stored.length, "record —", stored[0].change_type);
console.log("refused :", collision.reason, "->", collision.collided_with);
console.log("e2e-1203 OK");
