import { describe, it } from "node:test";
import assert from "node:assert";

const {
  A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS,
  READING_ANSWERS_FOR_SOMETHING_ELSE,
  READING_SAYS_WHAT_WE_ALREADY_STORE,
  RESTATEMENT_REFUSALS,
  TIER_IS_NOT_ONE_WE_RECORD_AS_FREE,
  readingAnswersForTheListedTier,
  readingSaysTheListedTierIsGone,
  restatementRulings,
  ruleOnRestating,
  weHaveReadThePageSinceTheRecord,
  withheldTermsMeasure,
} = await import("../dist/restatement.js");
const { supersededTermsNotice, supersedingChange } = await import("../dist/superseded-description.js");
const { changesByVendor } = await import("../dist/superseded-census.js");
const { loadDealChanges, loadOffers } = await import("../dist/data.js");
const { utcDate } = await import("../dist/ranking.js");
const {
  applyRestatements,
  newestRestatementFor,
  restatementEntry,
  revertRestatement,
  termsTheWriteWouldPublish,
} = await import("../scripts/restate-superseded-terms.js");
const { BASELINE_MOVED, releaseReadingsWhoseBaselineMoved } = await import(
  "../scripts/change-corroboration.js"
);

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const TODAY = "2026-09-17";

function offer(over: Partial<Offer> = {}): Offer {
  return {
    vendor: "Example",
    category: "hosting",
    description: "Free tier: 100 GB of transfer a month.",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: [],
    verifiedDate: "2026-08-01",
    ...over,
  } as Offer;
}

function change(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Example",
    change_type: "limits_reduced",
    date: "2026-09-07",
    date_source: "vendor_page",
    summary: "The free tier moved to 50 GB.",
    previous_state: "Free tier: 100 GB of transfer a month.",
    current_state: "The free plan includes 50 GB of transfer a month.",
    impact: "medium",
    source_url: "https://example.com/pricing",
    category: "hosting",
    alternatives: [],
    recorded_date: "2026-09-07",
    ...over,
  } as DealChange;
}

const PAGURE = {
  offer: offer({
    vendor: "Pagure.io",
    tier: "Free",
    url: "https://pagure.io",
    description:
      "Pagure.io is a free and open source software code collaboration platform for FOSS-licensed projects, Git-based",
  }),
  change: change({
    vendor: "Pagure.io",
    change_type: "product_deprecated",
    date: "2026-09-15",
    recorded_date: "2026-09-15",
    tier: "Free",
    tier_direction: "narrowed",
    summary: "Pagure.io has been sunset and is now a read-only archive.",
    previous_state:
      "Pagure.io is a free and open source software code collaboration platform for FOSS-licensed projects, Git-based",
    current_state: "Pagure.io was sunset in 2026; this is a read-only snapshot.",
    source_url: "https://pagure.io",
  }),
};

const XAI = {
  offer: offer({
    vendor: "xAI",
    tier: "Free Credits",
    url: "https://docs.x.ai/developers/models",
    description:
      "Sign-up gives $25 in free API credits. Additional $150/month via data sharing program (opt-in, requires $5 minimum spend first).",
  }),
  change: change({
    vendor: "xAI",
    change_type: "pricing_model_change",
    date: "2026-09-02",
    recorded_date: "2026-09-02",
    tier_direction: "unchanged",
    summary: "Grok 4.6 now costs $2.00/M input tokens and $6.00/M output tokens.",
    previous_state:
      "Sign-up gives $25 in free API credits. Additional $150/month via data sharing program (opt-in, requires $5 minimum spend first).",
    current_state: "Grok 4.6: Input $2.00 / 1M tokens, Output $6.00 / 1M tokens",
    source_url: "https://docs.x.ai/developers/models",
  }),
};

const IPAPI = {
  offer: offer({
    vendor: "ipapi",
    tier: "Free",
    url: "https://ipapi.co/#pricing",
    description:
      "IP address geolocation API — free tier: 1,000 IP lookups/day (~30,000/month). Designed for testing & development only.",
  }),
  change: change({
    vendor: "ipapi",
    change_type: "pricing_restructured",
    date: "2026-09-07",
    recorded_date: "2026-09-07",
    summary: "The free tier still exists, but the description has been updated.",
    previous_state:
      "IP address geolocation API — free tier: 1,000 IP lookups/day (~30,000/month). Designed for testing & development only.",
    current_state:
      "The free tier offers up to 1000 lookups/day (approximately 30K/month) for testing and development.",
    source_url: "https://ipapi.co/#pricing",
  }),
};

describe("restating a withheld description from the reading the page already shows", () => {
  it("restates terms a record says are gone, where the record grades the edition itself", () => {
    const ruling = ruleOnRestating(PAGURE.offer, PAGURE.change, TODAY);
    assert.equal(ruling?.refusal, null);
    assert.equal(ruling?.restatement?.source_url, "https://pagure.io");
    assert.equal(ruling?.restatement?.reading_date, "2026-09-15");
    assert.equal(ruling?.restatement?.record_date, "2026-09-15");
    assert.equal(ruling?.reading.terms, "Pagure.io was sunset in 2026; this is a read-only snapshot.");
    assert.ok(readingSaysTheListedTierIsGone(PAGURE.change, PAGURE.change.current_state));
  });

  it("refuses a reading that prices something other than the tier the entry describes", () => {
    const ruling = ruleOnRestating(XAI.offer, XAI.change, TODAY);
    assert.ok(ruling?.refusal);
    assert.equal(ruling?.restatement, null);
    assert.equal(
      readingAnswersForTheListedTier({ ...XAI.change }, { tier: "Free" }, XAI.change.current_state),
      false,
    );
  });

  it("names both grounds on which a reading about a priced model is refused", () => {
    assert.equal(ruleOnRestating(XAI.offer, XAI.change, TODAY)?.refusal, TIER_IS_NOT_ONE_WE_RECORD_AS_FREE);
    const asAFreeTier = { ...XAI.offer, tier: "Free" };
    assert.equal(
      ruleOnRestating(asAFreeTier, XAI.change, TODAY)?.refusal,
      READING_ANSWERS_FOR_SOMETHING_ELSE,
    );
  });

  it("leaves a reader the same terms where the reading restates what the page already showed them", () => {
    const ruling = ruleOnRestating(IPAPI.offer, IPAPI.change, TODAY);
    assert.equal(ruling?.refusal, null);
    const notice = supersededTermsNotice(IPAPI.offer.vendor, IPAPI.change);
    assert.ok(notice.includes(IPAPI.change.current_state));
    assert.equal(ruling?.reading.terms, IPAPI.change.current_state);
  });

  it("refuses a reading that says word for word what the entry already says", () => {
    const sameAsStored = change({ current_state: "Free tier: 100 GB of transfer a month." });
    assert.equal(
      ruleOnRestating(offer(), sameAsStored, TODAY)?.refusal,
      READING_SAYS_WHAT_WE_ALREADY_STORE,
    );
  });

  it("refuses every reason it names and names every reason it refuses on", () => {
    assert.deepEqual(new Set(RESTATEMENT_REFUSALS).size, RESTATEMENT_REFUSALS.length);
    const measure = withheldTermsMeasure([]);
    assert.deepEqual(Object.keys(measure.offers_we_refuse_to_restate).sort(), [...RESTATEMENT_REFUSALS].sort());
  });
});

describe("a restatement is reversible, visible and does not overwrite a hand-written entry", () => {
  it("records the terms it replaced, so the entry can be put back in one step", () => {
    const ruling = ruleOnRestating(PAGURE.offer, PAGURE.change, TODAY)!;
    const data = { offers: [{ ...PAGURE.offer }] };
    const written = applyRestatements(data, [ruling], TODAY);
    assert.equal(written.length, 1);
    assert.equal(data.offers[0].description, PAGURE.change.current_state);
    assert.equal(data.offers[0].restated_from.record_date, "2026-09-15");
    assert.equal(written[0].previous_description, PAGURE.offer.description);

    const { reverted, left } = revertRestatement(data, written, "Pagure.io");
    assert.equal(reverted, true);
    assert.equal(data.offers[0].description, PAGURE.offer.description);
    assert.equal(data.offers[0].restated_from, undefined);
    assert.deepEqual(left, []);
  });

  it("leaves the date a reading last agreed with us exactly where it was", () => {
    const ruling = ruleOnRestating(IPAPI.offer, IPAPI.change, TODAY)!;
    const data = { offers: [{ ...IPAPI.offer, verifiedDate: "2026-08-01" }] };
    applyRestatements(data, [ruling], TODAY);
    assert.equal(data.offers[0].verifiedDate, "2026-08-01");
    assert.equal(data.offers[0].source_check, undefined);
  });

  it("does not call terms taken from a reading that disagreed with us a verification of ours", async () => {
    const { CONFIRMED_DATE_LABEL, RESTATED_DATE_LABEL, confirmationDate, publishedDateLabel, publishedDateValue } =
      await import("../dist/read-date.js");
    const stored = { vendor: "Netlify", url: "https://netlify.com/pricing", verifiedDate: "2026-08-26" };
    const restated = { ...stored, restated_from: { reading_date: "2026-09-07" } };
    assert.equal(publishedDateLabel(restated), RESTATED_DATE_LABEL);
    assert.notEqual(RESTATED_DATE_LABEL, CONFIRMED_DATE_LABEL);
    assert.equal(publishedDateValue(restated), "2026-09-07");
    assert.equal(confirmationDate(restated), null);
    assert.notEqual(publishedDateLabel(stored), RESTATED_DATE_LABEL);
  });

  it("does not write over an entry again from a record no newer than the one it came from", () => {
    const restated = { ...IPAPI.offer, restated_from: { record_date: "2026-09-07" } };
    assert.equal(
      ruleOnRestating(restated, IPAPI.change, TODAY)?.refusal,
      A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS,
    );
    const newer = { ...IPAPI.change, date: "2026-09-12", recorded_date: "2026-09-12" };
    assert.equal(ruleOnRestating(restated, newer, TODAY)?.refusal, null);
  });

  it("leaves the index and the record of the write agreeing after a round trip", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const dir = mkdtempSync(join(tmpdir(), "restate-"));
    const index = join(dir, "index.json");
    const store = join(dir, "restated.json");
    const log = join(dir, "changes.json");
    const before = { offers: [{ ...IPAPI.offer }] };
    writeFileSync(index, JSON.stringify(before, null, 2));
    writeFileSync(store, JSON.stringify({ restatements: [] }, null, 2));
    writeFileSync(log, JSON.stringify({ changes: [IPAPI.change] }, null, 2));
    const env = {
      ...process.env,
      AGENTDEALS_INDEX_PATH: index,
      AGENTDEALS_RESTATED_PATH: store,
      AGENTDEALS_CHANGES_PATH: log,
    };
    const run = (...args: string[]) =>
      execFileSync(process.execPath, ["scripts/restate-superseded-terms.js", ...args], { env, encoding: "utf-8" });

    run("--write");
    const written = JSON.parse(readFileSync(index, "utf-8"));
    assert.notEqual(written.offers[0].description, IPAPI.offer.description);
    assert.equal(
      written.offers[0].description,
      `IP address geolocation API — ${IPAPI.change.current_state}`,
    );
    const held = JSON.parse(readFileSync(store, "utf-8")).restatements;
    assert.equal(held.length, 1);
    assert.equal(held[0].description, written.offers[0].description);

    run("--revert", "ipapi");
    assert.deepEqual(JSON.parse(readFileSync(index, "utf-8")), before);
    assert.deepEqual(JSON.parse(readFileSync(store, "utf-8")).restatements, []);
  });

  it("releases a reading held against terms the write replaces, and holds the rest", () => {
    const heldBehindIpapi = {
      vendor: "ipapi",
      change_type: "limits_reduced",
      impact: "medium",
      summary: "The daily allowance moved.",
      previous_state: IPAPI.offer.description,
      source_url: IPAPI.offer.url,
      first_read_date: "2026-09-16",
    };
    const heldElsewhere = { ...heldBehindIpapi, vendor: "Example", source_url: "https://example.com/pricing" };
    const { resolutions, stillHeld } = releaseReadingsWhoseBaselineMoved(
      [heldBehindIpapi, heldElsewhere],
      termsTheWriteWouldPublish([ruleOnRestating(IPAPI.offer, IPAPI.change, TODAY)!]),
    );
    assert.deepEqual(resolutions.map((entry: { vendor: string }) => entry.vendor), ["ipapi"]);
    assert.equal(resolutions[0].outcome, BASELINE_MOVED);
    assert.deepEqual(stillHeld.map((entry: { vendor: string }) => entry.vendor), ["Example"]);
  });

  it("holds a reading the write leaves reading against the terms we still publish", () => {
    const refused = { ...IPAPI.offer, tier: "Paid" };
    const heldBehindIpapi = {
      vendor: "ipapi",
      change_type: "limits_reduced",
      impact: "medium",
      summary: "The daily allowance moved.",
      previous_state: IPAPI.offer.description,
      source_url: IPAPI.offer.url,
      first_read_date: "2026-09-16",
    };
    const ruling = ruleOnRestating(refused, IPAPI.change, TODAY)!;
    assert.ok(ruling.refusal);
    const { resolutions } = releaseReadingsWhoseBaselineMoved(
      [heldBehindIpapi],
      termsTheWriteWouldPublish([ruling]),
    );
    assert.deepEqual(resolutions, []);
  });

  it("leaves no reading held against terms the write replaced, on the store it wrote", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const dir = mkdtempSync(join(tmpdir(), "restate-release-"));
    const index = join(dir, "index.json");
    const store = join(dir, "restated.json");
    const log = join(dir, "changes.json");
    const corroboration = join(dir, "corroboration.json");
    const untouched = offer({ vendor: "Example", description: "Free tier: 100 GB of transfer a month." });
    const heldBehind = (vendor: string, url: string, previous: string) => ({
      vendor,
      change_type: "limits_reduced",
      impact: "medium",
      summary: "The allowance moved.",
      previous_state: previous,
      source_url: url,
      first_read_date: "2026-09-16",
    });
    writeFileSync(index, JSON.stringify({ offers: [{ ...IPAPI.offer }, untouched] }, null, 2));
    writeFileSync(store, JSON.stringify({ restatements: [] }, null, 2));
    writeFileSync(log, JSON.stringify({ changes: [IPAPI.change] }, null, 2));
    writeFileSync(
      corroboration,
      JSON.stringify(
        {
          held: [
            heldBehind("ipapi", IPAPI.offer.url!, IPAPI.offer.description),
            heldBehind("Example", untouched.url!, untouched.description),
          ],
          resolved: [],
        },
        null,
        2,
      ),
    );
    const env = {
      ...process.env,
      AGENTDEALS_INDEX_PATH: index,
      AGENTDEALS_RESTATED_PATH: store,
      AGENTDEALS_CHANGES_PATH: log,
      AGENTDEALS_CORROBORATION_PATH: corroboration,
    };
    const run = (...args: string[]) =>
      execFileSync(process.execPath, ["scripts/restate-superseded-terms.js", ...args], { env, encoding: "utf-8" });

    const reported = run();
    assert.match(reported, /released as baseline_moved/);
    assert.deepEqual(JSON.parse(readFileSync(corroboration, "utf-8")).resolved, []);

    run("--write");
    const after = JSON.parse(readFileSync(corroboration, "utf-8"));
    assert.deepEqual(after.held.map((entry: { vendor: string }) => entry.vendor), ["Example"]);
    assert.deepEqual(after.resolved.map((entry: { vendor: string }) => entry.vendor), ["ipapi"]);
    assert.equal(after.resolved[0].outcome, BASELINE_MOVED);
  });

  it("puts back the newest terms it wrote for a vendor", () => {
    const first = restatementEntry(ruleOnRestating(IPAPI.offer, IPAPI.change, "2026-09-10")!, "2026-09-10");
    const second = { ...first, restated_on: "2026-09-16", previous_description: "the one before last" };
    assert.equal(newestRestatementFor([first, second], "ipapi")?.restated_on, "2026-09-16");
  });
});

describe("what we publish about the terms we are withholding", () => {
  const offers = loadOffers() as Offer[];
  const byVendor = changesByVendor(loadDealChanges());
  const rulings = restatementRulings(
    offers,
    (o: Offer) => byVendor.get(o.vendor.toLowerCase()) ?? [],
    utcDate(),
  );

  it("rules on every offer that is withholding behind a sourced reading and on no other", () => {
    const withholding = offers.filter((o) => supersedingChange(o, byVendor.get(o.vendor.toLowerCase()) ?? []));
    assert.equal(rulings.length, withholding.length);
    assert.ok(rulings.every((ruling) => ruling.reading.url !== "" && ruling.reading.terms !== ""));
  });

  it("counts a restatement we may make and a refusal for each offer, never both and never neither", () => {
    const measure = withheldTermsMeasure(rulings);
    const refused = Object.values(measure.offers_we_refuse_to_restate).reduce((a, b) => a + b, 0);
    assert.equal(measure.offers_we_may_restate_from_their_reading + refused, rulings.length);
  });

  it("counts an entry as re-read since the record only where the read came after the reading", () => {
    const reRead = rulings.filter((ruling) => weHaveReadThePageSinceTheRecord(ruling.offer, ruling.reading));
    assert.equal(
      withheldTermsMeasure(rulings).offers_re_read_since_the_record_and_still_withheld,
      reRead.length,
    );
    assert.ok(reRead.every((ruling) => ruling.offer.source_check.checked > ruling.reading.date));
  });

  it("holds back a reading that answers for something else on more than one entry", () => {
    const measure = withheldTermsMeasure(rulings);
    assert.ok(measure.offers_we_refuse_to_restate[READING_ANSWERS_FOR_SOMETHING_ELSE] > 1);
    assert.ok(measure.offers_we_refuse_to_restate[TIER_IS_NOT_ONE_WE_RECORD_AS_FREE] > 1);
  });

  it("publishes no entry as verified whose terms we took from a reading", () => {
    const restated = offers.filter((o) => o.restated_from);
    assert.deepEqual(
      restated.filter((o) => rulings.some((ruling) => ruling.offer === o && !ruling.refusal)).map((o) => o.vendor),
      [],
    );
  });
});
