import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { classifyTier } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const FIXTURE = join(REPO, "test", "tier-vocabulary.json");

const index = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf8")) as { offers: Offer[] };
const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as string[];

function tiersReachingTheFreeDefault(): string[] {
  const found = new Set<string>();
  for (const offer of index.offers) {
    if (classifyTier(offer.tier).class === "free") found.add(offer.tier);
  }
  return [...found].sort();
}

describe("tier vocabulary", () => {
  it("holds every tier string that ranks as an ongoing free tier without matching a rule", () => {
    const reaching = tiersReachingTheFreeDefault();
    const unpinned = reaching.filter((t) => !pinned.includes(t));
    assert.deepStrictEqual(
      unpinned,
      [],
      `data/index.json holds tier strings that no rule in classifyTier matches, so they rank as an ongoing free tier: ` +
        `${unpinned.map((t) => JSON.stringify(t)).join(", ")}. ` +
        `Add each to test/tier-vocabulary.json to record that it is one, or give classifyTier a rule that says what it is.`,
    );
  });

  it("drops a tier string from the fixture when no record carries it any more", () => {
    const reaching = tiersReachingTheFreeDefault();
    const stale = pinned.filter((t) => !reaching.includes(t));
    assert.deepStrictEqual(
      stale,
      [],
      `test/tier-vocabulary.json pins tier strings that no longer reach the free default: ` +
        `${stale.map((t) => JSON.stringify(t)).join(", ")}. ` +
        `Either a record changed tier or classifyTier gained a rule for it; remove them from the fixture.`,
    );
  });

  it("is sorted and free of duplicates so a data change produces a readable diff", () => {
    assert.deepStrictEqual(pinned, [...new Set(pinned)].sort());
  });

  it("covers a majority of the catalog, which is why the default cannot be left to fail open", () => {
    const carried = index.offers.filter((o) => pinned.includes(o.tier)).length;
    assert.ok(
      carried > index.offers.length / 2,
      `expected the pinned vocabulary to cover most records, found ${carried} of ${index.offers.length}`,
    );
  });
});
