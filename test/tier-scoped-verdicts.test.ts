import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const {
  changeGradesTheListedTier,
  namesADifferentTier,
  readingGradesTheHostedEdition,
  VERDICTS_ABOUT_THE_EDITION_ITSELF,
} = await import("../dist/change-tier.js");
const { namesTheVendorsHostedEdition } = await import("../dist/superseding-reading.js");
const { tierRecordsASelfHostedEdition } = await import("../dist/free-tier-record.js");
const { supersedingChange } = await import("../dist/superseded-description.js");
const { changesRatingTheListedTier, publishedRisk } = await import("../dist/data.js");
const { narrowingSentence } = await import("../dist/vendor-verdict.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const changesByVendor = new Map<string, DealChange[]>();
for (const change of changes) {
  const key = change.vendor.toLowerCase();
  const held = changesByVendor.get(key);
  if (held) held.push(change);
  else changesByVendor.set(key, [change]);
}

const changesFor = (vendor: string): DealChange[] => changesByVendor.get(vendor.toLowerCase()) ?? [];

const A_SELF_HOSTED_OFFER = {
  vendor: "Dashcorp",
  category: "Monitoring",
  description:
    "Dashcorp OSS — the self-hosted dashboarding front end, free under AGPL-3.0. You run it yourself; " +
    "Dashcorp Cloud is the hosted product and is priced separately.",
  tier: "Free OSS",
  url: "https://dashcorp.example/oss/dashcorp/",
  tags: ["monitoring"],
  verifiedDate: "2026-09-01",
};

const A_READING_OF_THE_HOSTED_PRODUCT = {
  vendor: "Dashcorp",
  change_type: "pricing_restructured",
  date: "2026-09-09",
  date_source: "discovered",
  summary: "The free tier now includes 10k metrics, 50GB logs and 3 users.",
  previous_state: A_SELF_HOSTED_OFFER.description,
  current_state: "Dashcorp Cloud includes a free tier with 10k metrics, 50GB logs and 3 users.",
  impact: "medium",
  source_url: A_SELF_HOSTED_OFFER.url,
  category: "Monitoring",
  alternatives: [],
};

const A_READING_OF_THE_SELF_HOSTED_EDITION = {
  ...A_READING_OF_THE_HOSTED_PRODUCT,
  summary: "The self-hosted edition is now capped at 1,000 monthly active users.",
  current_state: "Self-hosted: free, capped at 1,000 monthly active users. Community support.",
};

const THE_SAME_PAGE_LISTED_AS_A_HOSTED_TIER = { ...A_SELF_HOSTED_OFFER, tier: "Free" };

describe("#1526 a record names the tier it read, and only that tier's verdict follows from it", () => {
  it("decides nothing when the record names no tier", () => {
    for (const named of [undefined, null, "", "   "]) {
      assert.strictEqual(
        namesADifferentTier({ ...A_READING_OF_THE_HOSTED_PRODUCT, tier: named }, "Free OSS"),
        false,
        `tier ${JSON.stringify(named)} must leave the verdict where it was`,
      );
    }
  });

  it("reads the named tier through whitespace and case", () => {
    for (const named of ["Free OSS", "free oss", "  Free   OSS "]) {
      assert.strictEqual(
        namesADifferentTier({ ...A_READING_OF_THE_HOSTED_PRODUCT, tier: named }, "Free OSS"),
        false,
        `tier ${JSON.stringify(named)} names the listed tier`,
      );
    }
  });

  it("holds the record off a tier it does not name", () => {
    const named = { ...A_READING_OF_THE_HOSTED_PRODUCT, tier: "Dashcorp Cloud Free" };
    assert.strictEqual(namesADifferentTier(named, "Free OSS"), true);
    assert.strictEqual(changeGradesTheListedTier(named, A_SELF_HOSTED_OFFER), false);
    assert.strictEqual(namesADifferentTier(named, "Dashcorp Cloud Free"), false);
  });

  it("leaves every record stored today deciding exactly what it decided before", () => {
    let pairs = 0;
    for (const offer of offers) {
      for (const change of changesFor(offer.vendor)) {
        pairs++;
        assert.strictEqual(
          namesADifferentTier(change, offer.tier),
          false,
          `${change.vendor} ${change.change_type} ${change.date} would stop grading ${offer.tier}`,
        );
      }
    }
    assertPopulationFloor(pairs, 300, "offer/record pairs replayed through the tier test");
  });
});

describe("#1526 a reading of the vendor's hosted product does not grade its self-hosted edition", () => {
  it("recognises the hosted product by the vendor's own name", () => {
    assert.strictEqual(namesTheVendorsHostedEdition("Dashcorp Cloud includes a free tier.", "Dashcorp"), true);
    assert.strictEqual(namesTheVendorsHostedEdition("Dashcorp Hosted starts at $49.", "Dashcorp"), true);
    assert.strictEqual(namesTheVendorsHostedEdition("Dashcorp SaaS starts at $49.", "Dashcorp"), true);
  });

  it("does not read a bare mention of the vendor as its hosted product", () => {
    assert.strictEqual(namesTheVendorsHostedEdition("Dashcorp is now $49/month.", "Dashcorp"), false);
    assert.strictEqual(namesTheVendorsHostedEdition("Cloud plans start at $9/mo.", "Dashcorp"), false);
  });

  it("reads a vendor name literally, punctuation and all", () => {
    assert.strictEqual(namesTheVendorsHostedEdition("OCR.Space Cloud is $5/month.", "OCR.Space"), true);
    assert.strictEqual(namesTheVendorsHostedEdition("OCRxSpace Cloud is $5/month.", "OCR.Space"), false);
  });

  it("names which tier labels record a self-hosted edition", () => {
    for (const tier of ["Free OSS", "Open Source", "Community (Self-hosted)", "OSS License", "Self-Hosted"]) {
      assert.strictEqual(tierRecordsASelfHostedEdition(tier), true, `${tier} records a self-hosted edition`);
    }
    for (const tier of ["Free", "Starter", "Community", "Always Free", "Developer"]) {
      assert.strictEqual(tierRecordsASelfHostedEdition(tier), false, `${tier} does not name one`);
    }
  });

  it("holds the reading off the self-hosted edition and lets it grade a hosted listing", () => {
    assert.strictEqual(
      readingGradesTheHostedEdition(A_READING_OF_THE_HOSTED_PRODUCT, A_SELF_HOSTED_OFFER),
      true,
    );
    assert.strictEqual(
      readingGradesTheHostedEdition(A_READING_OF_THE_HOSTED_PRODUCT, THE_SAME_PAGE_LISTED_AS_A_HOSTED_TIER),
      false,
    );
  });

  it("lets a reading of the self-hosted edition itself grade it", () => {
    assert.strictEqual(
      readingGradesTheHostedEdition(A_READING_OF_THE_SELF_HOSTED_EDITION, A_SELF_HOSTED_OFFER),
      false,
    );
    assert.strictEqual(
      changeGradesTheListedTier(A_READING_OF_THE_SELF_HOSTED_EDITION, A_SELF_HOSTED_OFFER),
      true,
    );
  });

  it("lets a record that ends the edition itself grade it, whatever the reading names", () => {
    for (const change_type of VERDICTS_ABOUT_THE_EDITION_ITSELF) {
      assert.strictEqual(
        readingGradesTheHostedEdition({ ...A_READING_OF_THE_HOSTED_PRODUCT, change_type }, A_SELF_HOSTED_OFFER),
        false,
        `${change_type} is a verdict on the edition itself`,
      );
    }
  });
});

describe("#1526 the withholding and the rating read the same record the same way", () => {
  it("publishes the self-hosted terms and withholds them from a listing of the hosted tier", () => {
    assert.strictEqual(supersedingChange(A_SELF_HOSTED_OFFER, [A_READING_OF_THE_HOSTED_PRODUCT]), null);
    assert.strictEqual(
      supersedingChange(THE_SAME_PAGE_LISTED_AS_A_HOSTED_TIER, [A_READING_OF_THE_HOSTED_PRODUCT]),
      A_READING_OF_THE_HOSTED_PRODUCT,
    );
  });

  it("rates the self-hosted edition off the same record the withholding refused", () => {
    assert.deepStrictEqual(
      changesRatingTheListedTier(A_SELF_HOSTED_OFFER, [A_READING_OF_THE_HOSTED_PRODUCT as DealChange]),
      [],
    );
    const held = publishedRisk(
      A_SELF_HOSTED_OFFER as Offer,
      [A_READING_OF_THE_HOSTED_PRODUCT as DealChange],
      "2026-09-10",
      Date.parse("2026-09-10T12:00:00Z"),
    );
    assert.strictEqual(held.history_level, "stable");
    assert.strictEqual(held.cause, null);

    const rated = publishedRisk(
      THE_SAME_PAGE_LISTED_AS_A_HOSTED_TIER as Offer,
      [A_READING_OF_THE_HOSTED_PRODUCT as DealChange],
      "2026-09-10",
      Date.parse("2026-09-10T12:00:00Z"),
    );
    assert.strictEqual(rated.history_level, "caution");
    assert.strictEqual(rated.cause, A_READING_OF_THE_HOSTED_PRODUCT);
  });

  it("says the terms narrowed only where the record graded the tier being rated", () => {
    const held = [A_READING_OF_THE_HOSTED_PRODUCT];
    assert.match(
      narrowingSentence(held, THE_SAME_PAGE_LISTED_AS_A_HOSTED_TIER),
      /One recorded pricing restructure narrowed the terms/,
    );
    assert.strictEqual(
      narrowingSentence(held, A_SELF_HOSTED_OFFER),
      "The one change we have recorded did not narrow the terms.",
    );
  });

  it("withholds no offer's terms on a record that may not grade its tier", () => {
    for (const offer of offers) {
      const withholding = supersedingChange(offer, changesFor(offer.vendor));
      if (!withholding) continue;
      assert.strictEqual(
        changeGradesTheListedTier(withholding, offer),
        true,
        `${offer.vendor} (${offer.tier}) withholds on ${withholding.change_type} ${withholding.date}`,
      );
    }
  });

  it("rates no offer off a record that may not grade its tier", () => {
    const servedOn = "2026-09-10";
    const nowMs = Date.parse(`${servedOn}T12:00:00Z`);
    for (const offer of offers) {
      const cause = publishedRisk(offer, changesFor(offer.vendor), servedOn, nowMs).cause;
      if (!cause) continue;
      assert.strictEqual(
        changeGradesTheListedTier(cause, offer),
        true,
        `${offer.vendor} (${offer.tier}) is rated off ${cause.change_type} ${cause.date}`,
      );
    }
  });
});
