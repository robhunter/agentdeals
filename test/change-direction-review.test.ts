import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { readingDescribesNoNarrowing, narrowsTheStoredTerms } = await import("../dist/change-direction.js");
const { changeGradesTheListedTier, changeRatesTheListedTier } = await import("../dist/change-tier.js");
const {
  applyReviewedDirections,
  readDirectionReview,
  loadDirectionReview,
  reviewKey,
} = await import("../dist/change-direction-review.js");
const { supersedingChange, storedTermsAreSuperseded } = await import("../dist/superseded-description.js");
const { changesRatingTheListedTier, publishedRisk, loadDealChanges, loadOffers } = await import("../dist/data.js");
const { buildChangeEntry, TIER_DIRECTIONS } = await import("../scripts/change-log.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const stored: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const offers: Offer[] = loadOffers();
const liveChanges: DealChange[] = loadDealChanges();

const liveByVendor = new Map<string, DealChange[]>();
for (const change of liveChanges) {
  const key = change.vendor.toLowerCase();
  const held = liveByVendor.get(key);
  if (held) held.push(change);
  else liveByVendor.set(key, [change]);
}

const changesFor = (vendor: string): DealChange[] => liveByVendor.get(vendor.toLowerCase()) ?? [];
const offerFor = (vendor: string): Offer => {
  const found = offers.find((o) => o.vendor.toLowerCase() === vendor.toLowerCase());
  assert.ok(found, `${vendor} has left the catalogue — pick another subject for this test`);
  return found!;
};

const AN_OFFER = {
  vendor: "Dashcorp",
  category: "Monitoring",
  description: "500 build minutes per month, 50k test executions, 3 users.",
  tier: "Free",
  url: "https://dashcorp.example/pricing",
  tags: ["monitoring"],
  verifiedDate: "2026-09-01",
};

const A_RECORD_TYPED_AS_A_REDUCTION = {
  vendor: "Dashcorp",
  change_type: "limits_reduced",
  date: "2026-09-05",
  date_source: "discovered",
  summary: "The free plan now offers 2,000 build minutes and 250k test executions, up from 500 and 50k.",
  previous_state: AN_OFFER.description,
  current_state: "2,000 build minutes per month, 250k test executions, 3 users.",
  impact: "medium",
  source_url: AN_OFFER.url,
  category: "Monitoring",
  alternatives: [],
} as unknown as DealChange;

describe("#1528 a record's stored direction is read before its change_type", () => {
  it("leaves a record carrying no direction deciding exactly what it decided before", () => {
    assert.strictEqual(readingDescribesNoNarrowing(A_RECORD_TYPED_AS_A_REDUCTION), false);
    assert.strictEqual(changeRatesTheListedTier(A_RECORD_TYPED_AS_A_REDUCTION, AN_OFFER), true);
    assert.strictEqual(storedTermsAreSuperseded(AN_OFFER, [A_RECORD_TYPED_AS_A_REDUCTION]), true);
  });

  it("leaves a record whose direction agrees with its type deciding what it decided before", () => {
    const narrowed = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "narrowed" } as DealChange;
    assert.strictEqual(readingDescribesNoNarrowing(narrowed), false);
    assert.strictEqual(changeRatesTheListedTier(narrowed, AN_OFFER), true);
    assert.strictEqual(storedTermsAreSuperseded(AN_OFFER, [narrowed]), true);
  });

  it("publishes the stored terms and rates nothing where the direction refutes the type", () => {
    for (const direction of ["unchanged", "widened"]) {
      const refuted = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: direction } as DealChange;
      assert.strictEqual(readingDescribesNoNarrowing(refuted), true, direction);
      assert.strictEqual(changeRatesTheListedTier(refuted, AN_OFFER), false, direction);
      assert.strictEqual(storedTermsAreSuperseded(AN_OFFER, [refuted]), false, direction);
      assert.deepStrictEqual(changesRatingTheListedTier(AN_OFFER, [refuted]), [], direction);
    }
  });

  it("keeps the record itself, which only the verdict was dropped from", () => {
    const refuted = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "widened" } as DealChange;
    assert.strictEqual(changeGradesTheListedTier(refuted, AN_OFFER), true);
  });

  it("can only withdraw a verdict, never raise one", () => {
    assert.strictEqual(narrowsTheStoredTerms("limits_increased"), false);
    for (const direction of ["narrowed", "unchanged", "widened"]) {
      const increase = {
        ...A_RECORD_TYPED_AS_A_REDUCTION,
        change_type: "limits_increased",
        tier_direction: direction,
      } as DealChange;
      assert.strictEqual(readingDescribesNoNarrowing(increase), false, direction);
      assert.strictEqual(changeRatesTheListedTier(increase, AN_OFFER), true, direction);
      assert.strictEqual(storedTermsAreSuperseded(AN_OFFER, [increase]), false, direction);
    }
  });

  it("reads no direction out of a value outside the vocabulary", () => {
    for (const direction of ["", "no", "NARROWED", "improved", null, undefined]) {
      const odd = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: direction } as unknown as DealChange;
      assert.strictEqual(readingDescribesNoNarrowing(odd), false, JSON.stringify(direction));
    }
  });
});

describe("#1528 the detector states the direction with both sets of terms in hand", () => {
  it("stores the direction the reader gives", () => {
    for (const direction of TIER_DIRECTIONS) {
      const { entry } = buildChangeEntry(
        AN_OFFER,
        {
          status: "changed",
          summary: "Something moved.",
          change_type: "limits_reduced",
          current_state: "2,000 build minutes per month.",
          tier_direction: direction,
        },
        { now: new Date("2026-09-11T00:00:00Z") },
      );
      assert.strictEqual(entry.tier_direction, direction);
    }
  });

  it("stores no direction where the reader gives none or gives one we do not recognise", () => {
    for (const direction of [undefined, "", "better", 3, null]) {
      const { entry } = buildChangeEntry(
        AN_OFFER,
        {
          status: "changed",
          summary: "Something moved.",
          change_type: "limits_reduced",
          current_state: "2,000 build minutes per month.",
          tier_direction: direction,
        },
        { now: new Date("2026-09-11T00:00:00Z") },
      );
      assert.ok(!("tier_direction" in entry), JSON.stringify(direction));
    }
  });

  it("asks the reader the question in the prompt it sends", async () => {
    const source = readFileSync(path.join(REPO, "scripts", "verify-freshness.js"), "utf-8");
    assert.ok(source.includes("narrowed|unchanged|widened"), "the prompt must offer the three answers");
    assert.ok(
      source.includes("not from the change_type you picked"),
      "the prompt must ask for the direction from the terms rather than from the label",
    );
  });
});

describe("#1528 the review of the records already written", () => {
  const review = loadDirectionReview();
  const storedByKey = new Map(stored.map((change) => [reviewKey(change), change]));

  it("names a record we hold, for every entry", () => {
    for (const entry of review.directions) {
      assert.ok(
        storedByKey.has(reviewKey(entry)),
        `${entry.vendor} ${entry.change_type} ${entry.date} names no record we hold`,
      );
    }
    assert.ok(review.directions.length > 0, "the review names no record at all");
  });

  it("states one of the three directions, with a finding, for every entry", () => {
    for (const entry of review.directions) {
      assert.ok(TIER_DIRECTIONS.includes(entry.tier_direction), `${entry.vendor}: ${entry.tier_direction}`);
      assert.ok(entry.finding.trim().length > 0, `${entry.vendor} carries no finding`);
    }
  });

  it("cannot reach a record written after the review, which is what keeps it a backlog", () => {
    for (const entry of review.directions) {
      const change = storedByKey.get(reviewKey(entry))!;
      const recorded = change.recorded_date ?? change.date;
      assert.ok(
        recorded <= review.reviewed,
        `${entry.vendor} was recorded ${recorded}, after the review of ${review.reviewed}`,
      );
    }
  });

  it("does not review a record that states its own direction", () => {
    for (const entry of review.directions) {
      const change = storedByKey.get(reviewKey(entry))!;
      assert.strictEqual(
        change.tier_direction ?? null,
        null,
        `${entry.vendor} states its own direction and does not need reviewing`,
      );
    }
  });

  it("gives way to a record that states its own direction", () => {
    const stating = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "narrowed" } as DealChange;
    const applied = applyReviewedDirections(
      [stating],
      [{ ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "widened", finding: "" } as never],
    );
    assert.strictEqual(applied[0]!.tier_direction, "narrowed");
  });

  it("carries no judgement across to another record of the same vendor", () => {
    const entry = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "widened", finding: "" };
    const anotherDate = { ...A_RECORD_TYPED_AS_A_REDUCTION, date: "2026-09-08" } as DealChange;
    const anotherSource = {
      ...A_RECORD_TYPED_AS_A_REDUCTION,
      source_url: "https://dashcorp.example/plans",
    } as DealChange;
    const applied = applyReviewedDirections(
      [A_RECORD_TYPED_AS_A_REDUCTION, anotherDate, anotherSource],
      [entry as never],
    );
    assert.strictEqual(applied[0]!.tier_direction, "widened");
    assert.strictEqual(applied[1]!.tier_direction ?? null, null);
    assert.strictEqual(applied[2]!.tier_direction ?? null, null);
  });

  it("reads nothing out of a file that is absent or malformed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "directions-"));
    const missing = path.join(dir, "absent.json");
    assert.deepStrictEqual(readDirectionReview(missing).directions, []);

    const malformed = path.join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json");
    assert.deepStrictEqual(readDirectionReview(malformed).directions, []);

    const wrongShape = path.join(dir, "wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ directions: "none" }));
    assert.deepStrictEqual(readDirectionReview(wrongShape).directions, []);

    const outsideVocabulary = path.join(dir, "outside.json");
    writeFileSync(
      outsideVocabulary,
      JSON.stringify({ reviewed: "2026-09-10", review: "", directions: [{ ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "better" }] }),
    );
    assert.deepStrictEqual(readDirectionReview(outsideVocabulary).directions, []);
  });

  it("reaches every record it reviews once the catalogue is loaded", () => {
    const live = new Map(liveChanges.map((change) => [reviewKey(change), change]));
    for (const entry of review.directions) {
      assert.strictEqual(
        live.get(reviewKey(entry))?.tier_direction,
        entry.tier_direction,
        `${entry.vendor} does not carry its reviewed direction at load`,
      );
    }
  });

  it("leaves every record it does not review carrying no direction", () => {
    const reviewed = new Set(review.directions.map((entry) => reviewKey(entry)));
    let unreviewed = 0;
    for (const change of liveChanges) {
      if (reviewed.has(reviewKey(change))) continue;
      unreviewed++;
      assert.strictEqual(
        change.tier_direction ?? null,
        null,
        `${change.vendor} ${change.date} carries a direction from nowhere`,
      );
    }
    assert.strictEqual(
      unreviewed + review.directions.length,
      liveChanges.length,
      "the sweep does not cover every record the catalogue loaded",
    );
  });
});

describe("#1528 the vendor pages the census named", () => {
  const publishesItsStoredTerms = (vendor: string) => {
    const offer = offerFor(vendor);
    return !storedTermsAreSuperseded(offer, changesFor(vendor));
  };

  const ratedBy = (vendor: string) => {
    const offer = offerFor(vendor);
    return publishedRisk(offer, changesFor(vendor), "2026-09-11", Date.parse("2026-09-11T12:00:00Z"));
  };

  it("publishes the terms of the five the issue names, and rates none of them from these records", () => {
    for (const vendor of ["Buildkite", "PromoProxy", "Vercel", "Railway", "Figma"]) {
      assert.ok(publishesItsStoredTerms(vendor), `${vendor} still withholds its stored terms`);
      const risk = ratedBy(vendor);
      assert.notStrictEqual(risk.risk_level, "caution", `${vendor} still reads caution`);
      assert.notStrictEqual(risk.risk_level, "risky", `${vendor} still reads risky`);
    }
  });

  it("publishes the terms of the seven whose own two states state no narrowing", () => {
    for (const vendor of [
      "Grafana Cloud", "geocodify.com", "LastPass", "veriphone",
      "paperspace", "readthedocs.org", "Oracle Cloud",
    ]) {
      assert.ok(publishesItsStoredTerms(vendor), `${vendor} still withholds its stored terms`);
      const risk = ratedBy(vendor);
      assert.notStrictEqual(risk.risk_level, "caution", `${vendor} still reads caution`);
      assert.notStrictEqual(risk.risk_level, "risky", `${vendor} still reads risky`);
    }
  });

  it("leaves a genuine narrowing withholding and rated", () => {
    const offer = offerFor("Netlify");
    assert.strictEqual(storedTermsAreSuperseded(offer, changesFor("Netlify")), true);
    assert.ok(supersedingChange(offer, changesFor("Netlify")));
  });

  it("leaves the records that discover a limit exactly where they were", () => {
    const discovered = [
      "addy.io", "AppFit", "BugBug", "FreeIPAPI", "GitBook", "Nango",
      "Permit.io", "Postman", "Pullflow", "transfernow", "Whitespace",
    ];
    let checked = 0;
    for (const vendor of discovered) {
      const offer = offers.find((o) => o.vendor.toLowerCase() === vendor.toLowerCase());
      if (!offer) continue;
      checked++;
      assert.strictEqual(
        storedTermsAreSuperseded(offer, changesFor(vendor)),
        true,
        `${vendor} stopped withholding, which this rule was not meant to reach`,
      );
    }
    assertPopulationFloor(checked, 8, "records that discover a limit, replayed");
  });
});
