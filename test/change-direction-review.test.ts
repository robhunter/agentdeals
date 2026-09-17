import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, type Population } from "./population-floor.ts";

const { readingDescribesNoNarrowing, narrowsTheStoredTerms } = await import("../dist/change-direction.js");
const { changeGradesTheListedTier, changeRatesTheListedTier } = await import("../dist/change-tier.js");
const {
  applyReviewedDirections,
  readDirectionReview,
  loadDirectionReview,
  reviewKey,
} = await import("../dist/change-direction-review.js");
const {
  supersedingChange,
  storedTermsAreSuperseded,
  quotesTheStoredTermsAsPrevious,
  readingPricesNothingButATrial,
} = await import("../dist/superseded-description.js");
const { isNoLongerInForce } = await import("../dist/change-resolution.js");
const { supersededCensus } = await import("../dist/superseded-census.js");
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

const DISCOVER_A_LIMIT = [
  "addy.io", "AppFit", "BugBug", "FreeIPAPI", "GitBook", "Nango",
  "Permit.io", "Postman", "Pullflow", "transfernow", "Whitespace",
];

const recordsTheDiscoveryRuleWasWrittenAgainst = (): Population => ({
  size: DISCOVER_A_LIMIT.length,
  read: "records the discovery rule was written against",
});

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

  it("rates nothing where the direction refutes the type, and goes on withholding the terms it names as previous", () => {
    for (const direction of ["unchanged", "widened"]) {
      const refuted = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: direction } as DealChange;
      assert.strictEqual(readingDescribesNoNarrowing(refuted), true, direction);
      assert.strictEqual(changeRatesTheListedTier(refuted, AN_OFFER), false, direction);
      assert.deepStrictEqual(changesRatingTheListedTier(AN_OFFER, [refuted]), [], direction);
      assert.strictEqual(storedTermsAreSuperseded(AN_OFFER, [refuted]), true, direction);
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
      assert.strictEqual(publishedRisk(AN_OFFER, [increase], "2026-09-16").risk_cause, null, direction);
    }
  });

  it("#1721 withholds the stored terms a record names as the previous ones whichever way it read them", () => {
    for (const direction of [undefined, "narrowed", "unchanged", "widened"]) {
      const increase = {
        ...A_RECORD_TYPED_AS_A_REDUCTION,
        change_type: "limits_increased",
        tier_direction: direction,
      } as DealChange;
      assert.strictEqual(storedTermsAreSuperseded(AN_OFFER, [increase]), true, String(direction));
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

  it("states a direction on no record its review does not name", () => {
    const reviewed = new Set(review.directions.map((entry) => reviewKey(entry)));
    const overlaid = applyReviewedDirections(stored);
    assert.strictEqual(overlaid.length, stored.length, "the overlay changed the size of the log");
    let stated = 0;
    for (const [at, change] of overlaid.entries()) {
      const before = stored[at]!.tier_direction ?? null;
      const after = change.tier_direction ?? null;
      if (after === before) continue;
      stated++;
      assert.ok(
        reviewed.has(reviewKey(change)),
        `${change.vendor} ${change.date} is given ${after} by a review that does not name it`,
      );
    }
    assert.strictEqual(
      stated,
      review.directions.length,
      "the overlay does not reach every record its review names",
    );
  });

  it("keeps a direction the record was written with, which no review names", () => {
    const fromTheDetector = { ...A_RECORD_TYPED_AS_A_REDUCTION, tier_direction: "widened" } as DealChange;
    assert.strictEqual(applyReviewedDirections([fromTheDetector], [])[0]!.tier_direction, "widened");

    const overlaid = applyReviewedDirections(stored);
    for (const [at, change] of overlaid.entries()) {
      const written = stored[at]!.tier_direction ?? null;
      if (written === null) continue;
      assert.strictEqual(change.tier_direction, written, `${change.vendor} ${change.date}`);
    }
  });
});

describe("#1528 a record typed as a reduction whose own review reads no narrowing", () => {
  const publishesItsStoredTerms = (vendor: string) => {
    const offer = offerFor(vendor);
    return !storedTermsAreSuperseded(offer, changesFor(vendor));
  };

  const ratedBy = (vendor: string) => {
    const offer = offerFor(vendor);
    return publishedRisk(offer, changesFor(vendor), "2026-09-11", Date.parse("2026-09-11T12:00:00Z"));
  };

  const vendorsWhoseOwnTwoStatesStateNoNarrowing = (): string[] => {
    const named = [...new Set(liveChanges.filter(readingDescribesNoNarrowing).map(c => c.vendor))];
    return named.filter((vendor) => {
      const own = changesFor(vendor);
      const anotherRecordNarrows = own.some(
        (c) => narrowsTheStoredTerms(c.change_type) && !readingDescribesNoNarrowing(c),
      );
      return !anotherRecordNarrows && offers.some((o) => o.vendor.toLowerCase() === vendor.toLowerCase());
    });
  };

  it("rates no vendor whose own two states state no narrowing, and still withholds the terms those records name as previous", () => {
    const subjects = vendorsWhoseOwnTwoStatesStateNoNarrowing();
    assert.ok(
      subjects.length > 0,
      "no catalogued vendor holds a record typed as a reduction whose review reads no narrowing, so this has no subject",
    );
    const publishing: string[] = [];
    const rated: string[] = [];
    for (const vendor of subjects) {
      const offer = offerFor(vendor);
      const namesOurTermsAsPrevious = changesFor(vendor).some(
        (change) =>
          !isNoLongerInForce(change) &&
          quotesTheStoredTermsAsPrevious(change, offer.description) &&
          changeGradesTheListedTier(change, offer) &&
          !readingPricesNothingButATrial(change, offer),
      );
      if (namesOurTermsAsPrevious && publishesItsStoredTerms(vendor)) publishing.push(vendor);
      const risk = ratedBy(vendor);
      if (risk.risk_level === "caution" || risk.risk_level === "risky") rated.push(`${vendor} reads ${risk.risk_level}`);
    }
    assert.deepStrictEqual(
      rated.slice(0, 20),
      [],
      `vendors rated down by a record their own review reads as no narrowing:\n${rated.slice(0, 20).join("\n")}`,
    );
    assert.deepStrictEqual(
      publishing.slice(0, 20),
      [],
      `vendors publishing stored terms an in-force record of ours names as the previous ones:\n${publishing.slice(0, 20).join("\n")}`,
    );
  });

  it("leaves a genuine narrowing withholding and rated", () => {
    const offer = offerFor("Netlify");
    assert.strictEqual(storedTermsAreSuperseded(offer, changesFor("Netlify")), true);
    assert.ok(supersedingChange(offer, changesFor("Netlify")));
  });

  it("leaves the records that discover a limit exactly where they were", () => {
    const discovered = DISCOVER_A_LIMIT;
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
    assertCoversPopulation(checked, recordsTheDiscoveryRuleWasWrittenAgainst(), "records that discover a limit, replayed");
  });
});

describe("#1744 the direction a record is given cannot decide whether we publish our stored terms", () => {
  const censusOf = (changes: DealChange[]) => supersededCensus(offers, changes, "2026-09-17");

  it("measures one population whether the review is overlaid or not", () => {
    const reviewed = loadDirectionReview().directions;
    assert.ok(reviewed.length > 0, "the review states no direction, so this has no subject");
    assert.deepStrictEqual(censusOf(applyReviewedDirections(stored)), censusOf(stored));
  });

  it("withholds no less where every record is read as no narrowing", () => {
    const withoutADirection = censusOf(stored.map((change) => ({ ...change, tier_direction: undefined })));
    for (const direction of ["unchanged", "widened"]) {
      const forced = stored.map((change) => ({ ...change, tier_direction: direction }) as DealChange);
      assert.deepStrictEqual(censusOf(forced), withoutADirection, direction);
    }
  });

  it("takes no page out of withholding whichever direction every record is given", () => {
    const withoutADirection = censusOf(stored.map((change) => ({ ...change, tier_direction: undefined })));
    for (const direction of TIER_DIRECTIONS) {
      const forced = stored.map((change) => ({ ...change, tier_direction: direction }) as DealChange);
      const measured = censusOf(forced);
      for (const [name, floor] of Object.entries(withoutADirection)) {
        assert.ok(
          measured[name as keyof typeof measured] >= floor,
          `${direction} took ${name} from ${floor} to ${measured[name as keyof typeof measured]}`,
        );
      }
    }
  });

  it("counts the population the vendor pages render, which is what the budget caps", async () => {
    const { measureBudgets } = await import("../scripts/ratchet-quality-budgets.js");
    const measured = measureBudgets("2026-09-17");
    const served = censusOf(liveChanges);
    assert.strictEqual(measured.records_with_superseded_terms, served.records_with_superseded_terms);
    assert.strictEqual(
      measured.vendor_pages_withholding_superseded_terms,
      served.vendor_pages_withholding_superseded_terms,
    );
    assert.strictEqual(
      measured.ungated_pages_withholding_superseded_terms,
      served.ungated_pages_withholding_superseded_terms,
    );
  });
});
