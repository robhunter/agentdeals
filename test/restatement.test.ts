import { describe, it } from "node:test";
import assert from "node:assert";

const {
  A_LATER_READ_CONFIRMED_THE_TERMS_WE_STORE,
  A_RECORD_NO_NEWER_ALREADY_RESTATED_THIS,
  READING_ANSWERS_FOR_SOMETHING_ELSE,
  READING_DESCRIBES_THE_PAGE_NOT_THE_TERMS,
  READING_DROPS_THE_CAP_ON_WHO_MAY_USE_IT,
  READINGS_HELD_BACK_BY_NAME,
  READING_SAYS_WHAT_WE_ALREADY_STORE,
  READING_STATES_NO_FIGURE_WHERE_OUR_TERMS_DO,
  RESTATEMENT_REFUSALS,
  THIS_READING_IS_HELD_BACK_BY_NAME,
  TIER_IS_NOT_ONE_WE_RECORD_AS_FREE,
  readingAnswersForTheListedTier,
  readingDropsTheCapOnWhoMayUseIt,
  readingSaysTheListedTierIsGone,
  readingStatesNoFigureWhereOurTermsDo,
  restatementRulings,
  ruleOnRestating,
  theHoldOnThisReading,
  weHaveReadThePageSinceTheRecord,
  withheldTermsMeasure,
} = await import("../dist/restatement.js");
const { describesThePageRatherThanTheTerms } = await import("../dist/superseding-reading.js");
const { supersededTermsNotice, supersedingChange } = await import("../dist/superseded-description.js");
const { changesByVendor } = await import("../dist/superseded-census.js");
const { loadDealChanges, loadOffers } = await import("../dist/data.js");
const { loadVerificationState } = await import("../dist/verification-state.js");
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

const BURNERMAIL = {
  offer: offer({
    vendor: "Burnermail",
    tier: "Free",
    url: "https://burnermail.io/",
    description: "Free 5 Burner Email Addresses, 1 Mailbox, 7-day Mailbox History",
  }),
  change: change({
    vendor: "Burnermail",
    change_type: "free_tier_removed",
    date: "2026-08-28",
    recorded_date: "2026-08-28",
    previous_state: "Free 5 Burner Email Addresses, 1 Mailbox, 7-day Mailbox History",
    current_state:
      "The page encourages users to sign up and use burner addresses, but does not detail any free tier offerings. It states \"Why We're Removing Burner Mail's Free Plan Read more →\".",
    source_url: "https://burnermail.io/",
  }),
};

const GITHUB_ACTIONS = {
  offer: offer({
    vendor: "GitHub Actions",
    tier: "Free",
    url: "https://docs.github.com/en/billing/managing-billing-for-github-actions",
    description:
      "Free CI/CD for public repos (unlimited minutes). Private repos: 2,000 min/mo GitHub-hosted runners, 500 MB artifact storage, 10 GB cache/repo.",
  }),
  change: change({
    vendor: "GitHub Actions",
    change_type: "pricing_restructured",
    date: "2026-09-02",
    recorded_date: "2026-09-02",
    previous_state:
      "Free CI/CD for public repos (unlimited minutes). Private repos: 2,000 min/mo GitHub-hosted runners, 500 MB artifact storage, 10 GB cache/repo.",
    current_state:
      "GitHub Actions usage is free for self-hosted runners and public repositories. For private repositories, each account receives a quota of free minutes, artifact storage, and cache storage.",
    source_url: "https://docs.github.com/en/billing/managing-billing-for-github-actions",
  }),
};

const POSTMAN = {
  offer: offer({
    vendor: "Postman",
    tier: "Free",
    url: "https://www.postman.com/pricing/",
    description:
      "Free for single user only (since March 2026). Unlimited collections, environments, mock servers, basic monitoring. Team collaboration removed — requires Team plan ($19/user/mo).",
  }),
  change: change({
    vendor: "Postman",
    change_type: "limits_reduced",
    date: "2026-09-02",
    recorded_date: "2026-09-02",
    previous_state:
      "Free for single user only (since March 2026). Unlimited collections, environments, mock servers, basic monitoring. Team collaboration removed — requires Team plan ($19/user/mo).",
    current_state:
      "The Free plan costs $0 per month and includes 50 AI credits, an API client, core tools, specs & mock servers, native Git, Collection Runner & Performance Testing runs, manual Flows, and 1,000 API monitoring requests per month.",
    source_url: "https://www.postman.com/pricing/",
  }),
};

const TOMORROW_IO =
  "Tomorrow.io offers a free tier with access to 60+ data layers, 5-Day Forecast, Weather Timelines, Core Weather Data Layers, and 1 automatically monitored Location.";

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

  it("refuses a reading that reports on the page instead of stating the terms", () => {
    assert.equal(
      ruleOnRestating(BURNERMAIL.offer, BURNERMAIL.change, TODAY)?.refusal,
      READING_DESCRIBES_THE_PAGE_NOT_THE_TERMS,
    );
    assert.ok(describesThePageRatherThanTheTerms(BURNERMAIL.change.current_state));
  });

  it("restates a reading that names the vendor rather than the page it was read from", () => {
    assert.equal(describesThePageRatherThanTheTerms(PAGURE.change.current_state), false);
    assert.equal(describesThePageRatherThanTheTerms(TOMORROW_IO), false);
    assert.equal(ruleOnRestating(PAGURE.offer, PAGURE.change, TODAY)?.refusal, null);
  });

  it("refuses a reading that states no figure where the terms it would replace do", () => {
    assert.equal(
      ruleOnRestating(GITHUB_ACTIONS.offer, GITHUB_ACTIONS.change, TODAY)?.refusal,
      READING_STATES_NO_FIGURE_WHERE_OUR_TERMS_DO,
    );
    assert.ok(
      readingStatesNoFigureWhereOurTermsDo(
        GITHUB_ACTIONS.offer.description,
        GITHUB_ACTIONS.change.current_state,
      ),
    );
  });

  it("restates a figureless reading where the terms it replaces state no figure either", () => {
    assert.equal(
      readingStatesNoFigureWhereOurTermsDo(PAGURE.offer.description, PAGURE.change.current_state),
      false,
    );
  });

  it("refuses a reading that drops how many people may use the free tier", () => {
    assert.equal(
      ruleOnRestating(POSTMAN.offer, POSTMAN.change, TODAY)?.refusal,
      READING_DROPS_THE_CAP_ON_WHO_MAY_USE_IT,
    );
  });

  it("restates a reading that states its own count of who may use the free tier", () => {
    const threeInstead = "There is a Basic plan that is free and includes the first 3 users.";
    assert.equal(readingDropsTheCapOnWhoMayUseIt(POSTMAN.offer.description, threeInstead), false);
    assert.ok(readingDropsTheCapOnWhoMayUseIt(POSTMAN.offer.description, POSTMAN.change.current_state));
  });

  it("lets a restatement drop a caveat that does not decide the tier", () => {
    const noCard = offer({
      description: "Uptime monitoring for 5 servers at a 60-second interval. No credit card required.",
    });
    const reading = "The Hobby plan is free forever and monitors 10 servers at a 30-second interval.";
    assert.equal(readingDropsTheCapOnWhoMayUseIt(noCard.description, reading), false);
    assert.equal(readingStatesNoFigureWhereOurTermsDo(noCard.description, reading), false);
  });

  it("refuses every reason it names and names every reason it refuses on", () => {
    assert.deepEqual(new Set(RESTATEMENT_REFUSALS).size, RESTATEMENT_REFUSALS.length);
    const measure = withheldTermsMeasure([]);
    assert.deepEqual(Object.keys(measure.offers_we_refuse_to_restate).sort(), [...RESTATEMENT_REFUSALS].sort());
  });

  it("holds back the reading a hold names, and only while the vendor keeps reading that way", () => {
    const hold = READINGS_HELD_BACK_BY_NAME[0]!;
    const held = {
      offer: offer({ vendor: hold.vendor, description: `Terms stating ${hold.we_go_on_storing}.` }),
      change: change({
        vendor: hold.vendor,
        previous_state: `Terms stating ${hold.we_go_on_storing}.`,
        current_state: `${hold.reading_opens} Free plan, 5 GB.`,
      }),
    };
    assert.equal(
      ruleOnRestating(held.offer, held.change, TODAY)?.refusal,
      THIS_READING_IS_HELD_BACK_BY_NAME,
    );

    const readAgain = { ...held.change, current_state: "The Free plan gives you 5 GB of storage." };
    assert.equal(theHoldOnThisReading(held.offer, readAgain.current_state), null);
    assert.equal(ruleOnRestating(held.offer, readAgain, TODAY)?.refusal, null);
  });

  it("holds back no vendor a hold does not name", () => {
    assert.equal(theHoldOnThisReading(PAGURE.offer, PAGURE.change.current_state), null);
    for (const hold of READINGS_HELD_BACK_BY_NAME) {
      assert.match(hold.the_rule_that_should_reach_it, /^https:\/\/github\.com\/robhunter\/agentdeals\/issues\/\d+$/);
      assert.ok(hold.we_go_on_storing.length > 0, hold.vendor);
    }
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
    const { CONFIRMED_DATE_LABEL, UNCONFIRMED_DATE_LABEL, confirmationDate, publishedDateLabel, publishedDateValue } =
      await import("../dist/read-date.js");
    const stored = { vendor: "Netlify", url: "https://netlify.com/pricing", verifiedDate: "2026-08-26" };
    const restated = { ...stored, restated_from: { reading_date: "2026-09-07" } };
    assert.equal(publishedDateLabel(restated), UNCONFIRMED_DATE_LABEL);
    assert.notEqual(UNCONFIRMED_DATE_LABEL, CONFIRMED_DATE_LABEL);
    assert.equal(confirmationDate(restated), null);
  });

  it("adds the reading's date to what the record already publishes rather than standing in for it", async () => {
    const { RESTATED_DATE_LABEL, UNCONFIRMED_DATE_LABEL, publishedDateLine, restatedReadingLine, restatedReadingDate } =
      await import("../dist/read-date.js");
    const stored = { vendor: "Netlify", url: "https://netlify.com/pricing", verifiedDate: "2026-08-26" };
    const restated = { ...stored, restated_from: { reading_date: "2026-09-07" } };
    assert.equal(publishedDateLine(restated), `**${UNCONFIRMED_DATE_LABEL}:** 2026-08-26`);
    assert.equal(publishedDateLine(restated), publishedDateLine(stored));
    assert.equal(restatedReadingLine(restated), `**${RESTATED_DATE_LABEL}:** 2026-09-07`);
    assert.equal(restatedReadingDate(restated), "2026-09-07");
    assert.equal(restatedReadingLine(stored), null);
    assert.equal(restatedReadingDate(stored), null);
  });

  it("keeps our terms where a read since the reading found them still accurate", () => {
    const readingDate = IPAPI.change.date;
    const confirmedSince = [...loadVerificationState().values()]
      .filter((r) => r.last_success !== null && r.last_success > readingDate)
      .sort((a, b) => a.last_success!.localeCompare(b.last_success!))[0];
    assert.ok(
      confirmedSince,
      `no record in the store was confirmed after ${readingDate}, so this control proves nothing`,
    );
    const ours = { ...IPAPI.offer, vendor: confirmedSince.vendor, url: confirmedSince.url };
    assert.equal(
      ruleOnRestating(ours, IPAPI.change, TODAY)?.refusal,
      A_LATER_READ_CONFIRMED_THE_TERMS_WE_STORE,
    );
    assert.equal(ruleOnRestating(IPAPI.offer, IPAPI.change, TODAY)?.refusal, null);
  });

  it("does not tell a reader a read disagreed with the terms that read is the source of", async () => {
    const { WHAT_THE_LAST_READ_FOUND, noConfirmationNote } = await import("../dist/read-date.js");
    const disagreed = WHAT_THE_LAST_READ_FOUND.changed;
    const ours = noConfirmationNote("2026-09-09", "2026-08-26", "changed");
    assert.ok(ours.includes(disagreed), "a record whose terms are our own keeps the note it had");

    const sameRead = noConfirmationNote("2026-09-07", "2026-08-26", "changed", "2026-09-07");
    assert.ok(!sameRead.includes(disagreed));
    assert.match(sameRead, /on 2026-09-07, is where the terms above come from/);

    const readAgainSince = noConfirmationNote("2026-09-09", "2026-08-26", "changed", "2026-08-28");
    assert.ok(!readAgainSince.includes(disagreed));
    assert.match(readAgainSince, /come from our read of 2026-08-28/);
    assert.match(readAgainSince, /on 2026-09-09, without confirming them/);

    const noReadSince = noConfirmationNote("2026-08-26", "2026-08-26", "changed", "2026-08-28");
    assert.ok(!noReadSince.includes(disagreed));
    assert.ok(!noReadSince.includes("we have read the page since"), "no read is later than the one we restated from");
  });

  it("restates where the newest read reached the page and did not confirm what we store", () => {
    const readingDate = IPAPI.change.date;
    const readWithoutConfirming = [...loadVerificationState().values()]
      .filter((r) => r.last_attempt_at !== null && r.last_attempt_at > readingDate)
      .filter((r) => r.last_success === null || r.last_success <= readingDate)[0];
    assert.ok(
      readWithoutConfirming,
      `no record in the store was read after ${readingDate} without confirming, so this control proves nothing`,
    );
    const ours = { ...IPAPI.offer, vendor: readWithoutConfirming.vendor, url: readWithoutConfirming.url };
    assert.equal(ruleOnRestating(ours, IPAPI.change, TODAY)?.refusal, null);
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

  it("reaches the record each hold was written against, and goes on storing what it names", () => {
    for (const hold of READINGS_HELD_BACK_BY_NAME) {
      const ruling = rulings.find(
        (r: any) => r.offer.vendor.toLowerCase() === hold.vendor.toLowerCase(),
      );
      assert.ok(
        ruling,
        `${hold.vendor} is no longer withholding behind a reading, so this hold has nothing to hold — drop it and note ${hold.the_rule_that_should_reach_it}`,
      );
      assert.equal(
        ruling.refusal,
        THIS_READING_IS_HELD_BACK_BY_NAME,
        `${hold.vendor} reads ${ruling.reading.terms.slice(0, 80)}`,
      );
      assert.ok(
        ruling.offer.description.includes(hold.we_go_on_storing),
        `${hold.vendor} no longer stores ${hold.we_go_on_storing}: ${ruling.offer.description}`,
      );
    }
  });

  it("holds nothing by name that a rule of ours already reaches", () => {
    const measure = withheldTermsMeasure(rulings);
    assert.equal(
      measure.offers_we_refuse_to_restate[THIS_READING_IS_HELD_BACK_BY_NAME],
      READINGS_HELD_BACK_BY_NAME.length,
    );
    const heldByName = rulings.filter(
      (r: any) => r.refusal === THIS_READING_IS_HELD_BACK_BY_NAME,
    );
    assert.deepEqual(
      heldByName.map((r: any) => r.offer.vendor).sort(),
      READINGS_HELD_BACK_BY_NAME.map((hold) => hold.vendor).sort(),
    );
  });

  it("stores no reading that reports on the page, loses a figure, or drops who may use the tier", () => {
    const accepted = rulings.filter((ruling: { refusal: string | null }) => !ruling.refusal);
    const failing = (test: (ruling: any) => boolean) =>
      accepted.filter(test).map((ruling: any) => ruling.offer.vendor);
    assert.deepEqual(failing((r) => describesThePageRatherThanTheTerms(r.reading.terms)), []);
    assert.deepEqual(
      failing((r) => readingStatesNoFigureWhereOurTermsDo(r.offer.description, r.reading.terms)),
      [],
    );
    assert.deepEqual(
      failing((r) => readingDropsTheCapOnWhoMayUseIt(r.offer.description, r.reading.terms)),
      [],
    );
  });

  it("publishes no entry as verified whose terms we took from a reading", () => {
    const restated = offers.filter((o) => o.restated_from);
    assert.deepEqual(
      restated.filter((o) => rulings.some((ruling) => ruling.offer === o && !ruling.refusal)).map((o) => o.vendor),
      [],
    );
  });
});
