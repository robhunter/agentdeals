import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  buildRefusalEntry,
  mergeRefusals,
  readRefusals,
  recordRefusals,
  refusalHolds,
  refusalKey,
  offerKey,
  refusalsPath,
} = await import("../scripts/change-refusals.js");

const { pickOldestEntries, lastAttemptedDate } = await import("../scripts/reverify-rolling.js");

const NOW = new Date("2026-08-28T09:00:00Z");

const WEAVIATE_OFFER = {
  vendor: "Weaviate",
  url: "https://weaviate.io/pricing",
  category: "Databases",
  description: "Cloud: 14-day free sandbox with full access. Paid cloud from $45/mo (Flex)",
  verifiedDate: "2026-07-05",
};

const WEAVIATE_REFUSED = {
  candidate: {
    vendor: "Weaviate",
    change_type: "limits_reduced",
    summary: "The free tier now has specific limits.",
    previous_state: WEAVIATE_OFFER.description,
    current_state: "100,000 objects, 1 GB memory, 10 GB disk.",
    source_url: WEAVIATE_OFFER.url,
    category: "Databases",
  },
  reason: "unquantified_limit",
  detail: "the current state names no quantity for anything the stored state measured",
};

function scratchFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), "refusals-")), "change_refusals.json");
}

describe("a refusal outlives the run that made it", () => {
  it("keeps every field a reader needs to check the refusal without re-running the job", () => {
    const entry = buildRefusalEntry(WEAVIATE_REFUSED, { now: NOW });
    assert.deepStrictEqual(entry, {
      vendor: "Weaviate",
      change_type: "limits_reduced",
      reason: "unquantified_limit",
      detail: "the current state names no quantity for anything the stored state measured",
      summary: "The free tier now has specific limits.",
      previous_state: WEAVIATE_OFFER.description,
      current_state: "100,000 objects, 1 GB memory, 10 GB disk.",
      source_url: "https://weaviate.io/pricing",
      category: "Databases",
      refused_date: "2026-08-28",
    });
  });

  it("writes the refusal to disk where the next run can read it", () => {
    const file = scratchFile();
    recordRefusals([WEAVIATE_REFUSED], { path: file, now: NOW });
    const written = readRefusals(file);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].vendor, "Weaviate");
    assert.strictEqual(written[0].refused_date, "2026-08-28");
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("writes nothing at all on a dry run", () => {
    const file = scratchFile();
    const result = recordRefusals([WEAVIATE_REFUSED], { path: file, now: NOW, dryRun: true });
    assert.strictEqual(result.written.length, 1);
    assert.strictEqual(existsSync(file), false);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("replaces the earlier refusal rather than growing a duplicate for it", () => {
    const file = scratchFile();
    recordRefusals([WEAVIATE_REFUSED], { path: file, now: NOW });
    recordRefusals([WEAVIATE_REFUSED], { path: file, now: new Date("2026-09-04T09:00:00Z") });
    const written = readRefusals(file);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].refused_date, "2026-09-04");
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("keeps a second refusal of the same record under a different reason", () => {
    const other = { ...WEAVIATE_REFUSED, reason: "confirmed_unchanged" };
    const merged = mergeRefusals(
      [buildRefusalEntry(WEAVIATE_REFUSED, { now: NOW })],
      [buildRefusalEntry(other, { now: NOW })]
    );
    assert.strictEqual(merged.length, 2);
    assert.deepStrictEqual(
      merged.map((r: any) => r.reason).sort(),
      ["confirmed_unchanged", "unquantified_limit"]
    );
  });

  it("names the record and the reason in the key it stores under", () => {
    assert.strictEqual(
      refusalKey(buildRefusalEntry(WEAVIATE_REFUSED, { now: NOW })),
      "Weaviate|https://weaviate.io/pricing|unquantified_limit"
    );
  });

  it("stores the record a refusal collided with when there was one", () => {
    const collidedWith = "Weaviate|limits_increased|2026-08-28|https://weaviate.io/pricing";
    const entry = buildRefusalEntry(
      { ...WEAVIATE_REFUSED, reason: "same_transition_graded_differently", collidedWith },
      { now: NOW }
    );
    assert.strictEqual(entry.collided_with, collidedWith);
    assert.strictEqual(entry.change_type, "limits_reduced");
    assert.strictEqual(entry.previous_state, WEAVIATE_OFFER.description);
  });

  it("adds no collision field to a refusal that did not collide with anything", () => {
    const entry = buildRefusalEntry(WEAVIATE_REFUSED, { now: NOW });
    assert.ok(!("collided_with" in entry), "a gate refusal carries a collision key");
  });

  it("reads no refusals from a file that is not there yet", () => {
    assert.deepStrictEqual(readRefusals(path.join(tmpdir(), "no-such-refusals.json")), []);
  });

  it("reads no refusals from a file holding something else", () => {
    const file = scratchFile();
    writeFileSync(file, "not json at all");
    assert.deepStrictEqual(readRefusals(file), []);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("writes to the path the environment names", () => {
    const previous = process.env.AGENTDEALS_REFUSALS_PATH;
    process.env.AGENTDEALS_REFUSALS_PATH = "/tmp/named-by-the-environment.json";
    assert.strictEqual(refusalsPath(), "/tmp/named-by-the-environment.json");
    if (previous === undefined) delete process.env.AGENTDEALS_REFUSALS_PATH;
    else process.env.AGENTDEALS_REFUSALS_PATH = previous;
  });
});

describe("a refused record does not come straight back to the head of the queue", () => {
  const refused = [buildRefusalEntry(WEAVIATE_REFUSED, { now: NOW })];

  it("holds the record at the date it was refused", () => {
    const holds = refusalHolds(refused, [WEAVIATE_OFFER]);
    assert.strictEqual(holds.get(offerKey("Weaviate", "https://weaviate.io/pricing")), "2026-08-28");
  });

  it("reads the refusal date as the last time we looked at the record", () => {
    assert.strictEqual(lastAttemptedDate(WEAVIATE_OFFER), "2026-07-05");
    assert.strictEqual(lastAttemptedDate(WEAVIATE_OFFER, "2026-08-28"), "2026-08-28");
  });

  it("sends the refused record behind entries verified more recently", () => {
    const offers = [
      WEAVIATE_OFFER,
      { vendor: "Second", url: "https://second.example", description: "b", verifiedDate: "2026-07-06" },
      { vendor: "Third", url: "https://third.example", description: "c", verifiedDate: "2026-07-07" },
    ];
    const before = pickOldestEntries(offers, 1, NOW);
    assert.strictEqual(before.picked[0].offer.vendor, "Weaviate");

    const after = pickOldestEntries(offers, 1, NOW, {
      refusalHolds: refusalHolds(refused, offers),
    });
    assert.strictEqual(after.picked[0].offer.vendor, "Second");
  });

  it("stops holding a record whose description has since been corrected", () => {
    const corrected = { ...WEAVIATE_OFFER, description: "Cloud: permanent free tier — 100,000 objects" };
    assert.strictEqual(refusalHolds(refused, [corrected]).size, 0);
  });

  it("holds nothing for a refusal naming a record the index no longer carries", () => {
    assert.strictEqual(refusalHolds(refused, []).size, 0);
  });

  it("holds a record at the most recent of two refusals", () => {
    const later = buildRefusalEntry(
      { ...WEAVIATE_REFUSED, reason: "confirmed_unchanged" },
      { now: new Date("2026-09-04T09:00:00Z") }
    );
    const holds = refusalHolds([...refused, later], [WEAVIATE_OFFER]);
    assert.strictEqual(holds.get(offerKey("Weaviate", "https://weaviate.io/pricing")), "2026-09-04");
  });
});
