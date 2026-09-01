import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Offer = import("../src/types.ts").Offer;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const FIXTURE = join(REPO, "test", "eligibility-vocabulary.json");

const index = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf8")) as { offers: Offer[] };
const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as string[];

function typesCarriedByTheData(): string[] {
  const found = new Set<string>();
  for (const offer of index.offers) {
    if (offer.eligibility) found.add(offer.eligibility.type);
  }
  return [...found].sort();
}

describe("eligibility vocabulary", () => {
  it("holds every eligibility type a record carries", () => {
    const carried = typesCarriedByTheData();
    const unpinned = carried.filter((t) => !pinned.includes(t));
    assert.deepStrictEqual(
      unpinned,
      [],
      `data/index.json carries eligibility types that test/eligibility-vocabulary.json does not list: ` +
        `${unpinned.map((t) => JSON.stringify(t)).join(", ")}. ` +
        `Every consumer of this field declares its own copy of the list, so a new value has to be added to each of them.`,
    );
  });

  it("drops an eligibility type from the fixture when no record carries it any more", () => {
    const carried = typesCarriedByTheData();
    const stale = pinned.filter((t) => !carried.includes(t));
    assert.deepStrictEqual(
      stale,
      [],
      `test/eligibility-vocabulary.json lists eligibility types no record carries: ` +
        `${stale.map((t) => JSON.stringify(t)).join(", ")}.`,
    );
  });

  it("is sorted and free of duplicates so a data change produces a readable diff", () => {
    assert.deepStrictEqual(pinned, [...new Set(pinned)].sort());
  });

  it("accounts for every record that carries an eligibility object", () => {
    const gated = index.offers.filter((o) => o.eligibility);
    const accounted = gated.filter((o) => pinned.includes(o.eligibility!.type)).length;
    assert.strictEqual(
      accounted,
      gated.length,
      `${gated.length - accounted} of ${gated.length} gated records carry a type outside the fixture`,
    );
  });
});
