import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_CHECK_OUTCOMES,
  LEVEL_WITHHOLDING_OUTCOMES,
  freePriceConfirmedSentence,
  freePriceOnlySentence,
  recordPublishesAQuantity,
  sourceStatesAFreePrice,
  unconfirmedTermsClause,
} from "../dist/source-check.js";
import { termsNotVerifiedMetaSentence, unconfirmedTermsFrom } from "../dist/vendor-verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");

const { priceSignals } = await import("../scripts/change-gate.js");
const { classifySource, holdsVerifiedDate, statesAPriceOfZero, SOURCE_CHECK_FREE_PRICE, SOURCE_CHECK_NO_AMOUNT } =
  await import("../scripts/vendor-naming.js");
const { attemptForSourceCheck, pageStatesNoPrice, ANSWERED_OUTCOMES } =
  await import("../scripts/verification-state.js");

const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
const offers: any[] = index.offers ?? [];

const quotedPhrase = (offer: any): string | null => {
  const match = /(?:says|states its price in words as) "([^"]*)"/.exec(offer.source_check?.detail ?? "");
  return match ? match[1] : null;
};

const OFFER = {
  vendor: "Widgetson",
  category: "Object Storage",
  tier: "Free",
  description: "10 GB storage",
  url: "https://widgetson.example/pricing",
};

const nav = `${OFFER.vendor} Docs Blog Careers Support Community Login Sign up `.repeat(12);
const pageSaying = (claim: string) => ({ ok: true, text: `${nav} ${OFFER.vendor} pricing. ${claim} Talk to our team about what you need.` });
const gradeOf = (page: any) => classifySource(OFFER, page, priceSignals(page.text));

const PAGES_STATING_A_FREE_PRICE = [
  "Free forever.",
  "Our free plan covers it.",
  "There is a free tier.",
  "Use the free API.",
  "Download the free version.",
  "Free plans for everyone.",
];

const PAGES_WITHHOLDING_A_PLAN_PRICE = [
  "Enterprise plan available.",
  "Pro plans available.",
  "Pricing starts at what your team needs.",
  "Premium tiers available.",
  "Ask about our business plan.",
];

const CONTROL_VENDORS_WHOSE_PAGE_NAMES_ONLY_A_PRICED_PLAN = [
  "ElasticMQ", "Zoho Meeting", "Huly", "Webex", "Loco", "mailsac.com", "bitnami.com",
  "Solo", "pantheon.io", "asana.com", "YepCode", "SimplePDF.eu",
  "Volume Shader BM", "XKit", "Google Meet", "Renovate", "NordPass", "Clever Bootstrap Program",
];

describe("a price stated in words", () => {
  it("grades a page that states a free price apart from one that names a plan and withholds its price", () => {
    for (const claim of PAGES_STATING_A_FREE_PRICE) {
      assert.strictEqual(gradeOf(pageSaying(claim)).outcome, SOURCE_CHECK_FREE_PRICE, claim);
    }
    for (const claim of PAGES_WITHHOLDING_A_PLAN_PRICE) {
      assert.strictEqual(gradeOf(pageSaying(claim)).outcome, SOURCE_CHECK_NO_AMOUNT, claim);
    }
  });

  it("quotes the phrase the page stated", () => {
    const graded = gradeOf(pageSaying("Free forever."));
    assert.match(graded.detail, /states its price in words as "Free forever"/);
    assert.doesNotMatch(graded.detail, /states no amount/);
  });

  it("prefers a figure on the page to a price stated in words", () => {
    assert.strictEqual(gradeOf(pageSaying("Free forever. Pro is $20/month.")).outcome, "ok");
  });

  it("reads a trial as neither a price of zero nor an amount", () => {
    assert.strictEqual(statesAPriceOfZero("free trial"), false);
    assert.strictEqual(statesAPriceOfZero("$0"), false);
    assert.strictEqual(statesAPriceOfZero("free for 14 days"), false);
    assert.strictEqual(gradeOf(pageSaying("Start your free trial.")).outcome, "states_no_terms");
  });

  it("is an outcome we publish, and one that keeps the rating and the verified date", () => {
    assert.ok(SOURCE_CHECK_OUTCOMES.includes(SOURCE_CHECK_FREE_PRICE));
    assert.strictEqual(LEVEL_WITHHOLDING_OUTCOMES.includes(SOURCE_CHECK_FREE_PRICE), false);
    assert.strictEqual(holdsVerifiedDate(SOURCE_CHECK_FREE_PRICE), false);
  });

  it("records an answered attempt that does not say the page states no price", () => {
    assert.ok(ANSWERED_OUTCOMES.has(attemptForSourceCheck(SOURCE_CHECK_FREE_PRICE)));
    assert.strictEqual(pageStatesNoPrice(SOURCE_CHECK_FREE_PRICE), false);
    assert.strictEqual(pageStatesNoPrice(SOURCE_CHECK_NO_AMOUNT), true);
  });
});

describe("what we publish over a price stated in words", () => {
  const evidenceFor = (publishesAQuantity: boolean) => ({
    vendor: OFFER.vendor,
    levelWithheld: null,
    unconfirmableSince: "",
    refusedRead: null,
    sourceCheck: SOURCE_CHECK_FREE_PRICE,
    sourceChecked: "2026-09-14",
    linkCheckedOn: null,
    publishesAQuantity,
  });

  it("confirms the price and withholds the allowance where we publish a quantity of our own", () => {
    const unconfirmed = unconfirmedTermsFrom(evidenceFor(true));
    assert.ok(unconfirmed);
    assert.strictEqual(unconfirmed.sentence, freePriceConfirmedSentence(OFFER.vendor));
    assert.match(unconfirmed.sentence, /confirms the price/);
    assert.match(unconfirmed.sentence, /come from our own record/);
  });

  it("confirms outright where we publish no quantity of our own", () => {
    assert.strictEqual(unconfirmedTermsFrom(evidenceFor(false)), null);
  });

  it("stops heading the page Not verified over a page that states the price", () => {
    const input = {
      vendor: OFFER.vendor,
      level: null,
      historyLevel: "stable",
      cause: null,
      changes: [],
      levelWithheld: null,
      unconfirmableSince: "",
      sourceCheck: SOURCE_CHECK_FREE_PRICE,
      sourceChecked: "2026-09-14",
      termsConfirmedOn: "2026-09-14",
      publishesAQuantity: true,
    };
    assert.strictEqual(termsNotVerifiedMetaSentence(input as any), null);
    assert.match(
      termsNotVerifiedMetaSentence({ ...input, sourceCheck: SOURCE_CHECK_NO_AMOUNT } as any) ?? "",
      /^Not verified/,
    );
  });

  it("names the surviving case only, in the clause each outcome publishes", () => {
    assert.match(unconfirmedTermsClause(SOURCE_CHECK_NO_AMOUNT), /names a plan but states no amount/);
    assert.doesNotMatch(unconfirmedTermsClause(SOURCE_CHECK_NO_AMOUNT), /free/i);
    assert.match(unconfirmedTermsClause(SOURCE_CHECK_FREE_PRICE), /states that it is free/);
  });

  it("says something different where we publish a quantity and where we do not", () => {
    assert.notStrictEqual(freePriceConfirmedSentence(OFFER.vendor), freePriceOnlySentence(OFFER.vendor));
    assert.strictEqual(recordPublishesAQuantity("10 GB storage"), true);
    assert.strictEqual(recordPublishesAQuantity("Free CDN for open-source projects"), false);
  });
});

describe("every record we hold, graded by what its read quoted", () => {
  it("puts a quoted free price on one side of the line and a withheld plan price on the other", () => {
    const misgraded = { statedFreeButRefused: [] as string[], withheldButConfirmed: [] as string[] };
    let statesAFreePrice = 0;
    let statesNoAmount = 0;
    for (const offer of offers) {
      const outcome = offer.source_check?.outcome;
      if (outcome !== SOURCE_CHECK_FREE_PRICE && outcome !== SOURCE_CHECK_NO_AMOUNT) continue;
      const phrase = quotedPhrase(offer);
      assert.ok(phrase !== null, `${offer.vendor} records no phrase in its detail`);
      if (outcome === SOURCE_CHECK_FREE_PRICE) statesAFreePrice++;
      else statesNoAmount++;
      if (statesAPriceOfZero(phrase) && outcome === SOURCE_CHECK_NO_AMOUNT) {
        misgraded.statedFreeButRefused.push(`${offer.vendor} ("${phrase}")`);
      }
      if (!statesAPriceOfZero(phrase) && outcome === SOURCE_CHECK_FREE_PRICE) {
        misgraded.withheldButConfirmed.push(`${offer.vendor} ("${phrase}")`);
      }
    }
    const census = `${statesAFreePrice} graded ${SOURCE_CHECK_FREE_PRICE}, ${statesNoAmount} graded ${SOURCE_CHECK_NO_AMOUNT}`;
    assert.deepStrictEqual(
      misgraded,
      { statedFreeButRefused: [], withheldButConfirmed: [] },
      `${census}; each listed record's quoted phrase disagrees with the outcome it carries`,
    );
    assert.ok(statesAFreePrice > 0, census);
    assert.ok(statesNoAmount > 0, census);
  });

  it("holds every vendor whose page names a priced plan and no free one on the withheld side", () => {
    const gradeOfVendor = new Map(offers.map((o) => [o.vendor, o.source_check?.outcome]));
    const onTheLine = CONTROL_VENDORS_WHOSE_PAGE_NAMES_ONLY_A_PRICED_PLAN.filter((v) =>
      gradeOfVendor.get(v) === SOURCE_CHECK_NO_AMOUNT || gradeOfVendor.get(v) === SOURCE_CHECK_FREE_PRICE);
    assert.ok(onTheLine.length > 0, "no control is graded on either side of the line any more, so this proves nothing");
    const crossed = onTheLine.filter((v) => gradeOfVendor.get(v) === SOURCE_CHECK_FREE_PRICE);
    assert.deepStrictEqual(crossed, [], `${crossed.length} of ${onTheLine.length} crossed to the side that states a free price`);
  });

  it("publishes a free price we can source on every record it grades", () => {
    const graded = offers.filter(sourceStatesAFreePrice);
    assert.ok(graded.length >= 60, `${graded.length} records graded ${SOURCE_CHECK_FREE_PRICE}`);
    for (const offer of graded) {
      assert.ok(statesAPriceOfZero(quotedPhrase(offer)), `${offer.vendor}: ${offer.source_check.detail}`);
      assert.doesNotMatch(offer.source_check.detail, /states no amount/, offer.vendor);
    }
  });
});
