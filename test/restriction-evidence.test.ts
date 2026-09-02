import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-restriction-")),
  "change_refusals.json"
);

const {
  describesChange,
  restrictionEvidence,
  correctsOurOwnRecord,
  reportsNoNarrowing,
  reportsSomethingStillFree,
  unitAliases,
  RECLASSIFIED_AS_CORRECTION,
  REJECT_STATES_NO_NARROWING,
  REJECT_NO_TERMS_TO_NARROW,
  REJECT_MEASURES_NO_CHANGE,
} = await import("../scripts/change-gate.js");

const { definedEquivalences } = await import("../scripts/unit-aliases.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GEOCODIO_PRICING_PAGE =
  "Geocodio pricing. Pay as you go, no monthly commitment. Annual plans get two months free plus " +
  "discounts on top-up credits. 1 address or coordinate lookup = 1 credit. Each additional data " +
  "append = 1 credit. First 2,500 credits used per day are free.";

const TESTINGBOT = {
  vendor: "testingbot.com",
  change_type: "restriction",
  date: "2026-08-28",
  date_source: "discovered",
  summary:
    "The free tier is still offered. The description is less specific. The current page only mentions a " +
    "'free plan' and a 'free trial of paid features' without explicitly linking it to open-source projects.",
  previous_state:
    "Selenium Browser and Device Testing, [free for Open Source](https://testingbot.com/open-source)",
  current_state:
    "TestingBot offers a free plan and a free trial of paid features. No credit card is required to start.",
  impact: "medium",
  source_url: "https://testingbot.com/",
};

const DEBUGMAIL = {
  vendor: "debugmail.io",
  change_type: "restriction",
  date: "2026-08-28",
  date_source: "discovered",
  summary:
    "The free tier is now limited to OSS projects. A Silver plan is available for free for OSS projects, " +
    "but other users have a 2 week trial then $2 per user per month.",
  previous_state: "Easy to use testing mail server for developers",
  current_state:
    "We provide a free Silver plan for OSS projects. Free Silver Gold Projects 1 10 Unlimited Team Members " +
    "2 20 Unlimited Pricing $0 2 weeks trial period then $2 per user per month $5 per user per month",
  impact: "high",
  source_url: "https://debugmail.io/",
};

const TICKGIT = {
  vendor: "tickgit.com",
  change_type: "restriction",
  date: "2026-08-28",
  date_source: "discovered",
  summary:
    "The free tier is now limited to public repositories. Private repositories require a $3/month " +
    "subscription with a 3-day free trial.",
  previous_state:
    "Surfaces `TODO` comments (and other markers) to identify areas of code worth returning to for improvement.",
  current_state:
    "Free for Public Repositories 🎉 No login required. $3/month for Private Repositories 💵 3 day free trial.",
  impact: "high",
  source_url: "https://www.tickgit.com/",
};

const GEOCODIO = {
  vendor: "Geocodio",
  change_type: "restriction",
  date: "2026-08-28",
  date_source: "discovered",
  summary: "The free tier now offers 2,500 lookups *daily*. Is limited to US, Canada, and Mexico.",
  previous_state:
    "Geocoding and reverse geocoding API for US and Canada — free tier: 2,500 lookups/day. Includes " +
    "address parsing, congressional districts, timezone, and census data fields",
  current_state:
    "Pay-as-you-go accounts get the first 2,500 credits per day for free. US, Canada, and Mexico only.",
  impact: "medium",
  source_url: "https://www.geocod.io/pricing/",
};

const NEO4J = {
  vendor: "Neo4j AuraDB",
  change_type: "restriction",
  date: "2026-03-22",
  date_source: "hand_written",
  summary:
    "Data correction — previous entry incorrectly reduced limits to 50K nodes/175K relationships. Actual " +
    "free tier is 200,000 nodes and 400,000 relationships per Neo4j AuraDB FAQ",
  previous_state: "50,000 nodes, 175,000 relationships (incorrectly listed)",
  current_state: "200,000 nodes, 400,000 relationships (restored to correct values)",
  impact: "low",
  source_url: "https://neo4j.com/cloud/platform/aura-graph-database/faq/",
};

const DIGITALOCEAN_CORRECTION = {
  vendor: "DigitalOcean",
  change_type: "restriction",
  date: "2026-03-21",
  date_source: "hand_written",
  summary:
    "Managed databases are not part of the free tier. Pricing starts at $15/month. Previous listing " +
    "incorrectly included '1 basic cluster' as a free tier benefit",
  previous_state:
    "Listed as: Free static sites (up to 3), functions (90K GiB-seconds/mo), and managed databases (1 basic cluster)",
  current_state:
    "Free static sites (up to 3) and functions (90K GiB-seconds/mo). Managed databases start at $15/mo, not free",
  impact: "medium",
  source_url: "https://www.digitalocean.com/pricing",
};

const NETLIFY = {
  vendor: "Netlify",
  change_type: "restriction",
  date: "2026-03-01",
  date_source: "hand_written",
  summary:
    "Every repo committer is now charged as a full Pro seat ($19/mo) when using Netlify CMS or Identity " +
    "with a private repo. Previously only users who logged into the Netlify dashboard counted as seats",
  previous_state: "Only Netlify dashboard users counted as billable seats",
  current_state:
    "All repo committers to connected private repos count as Pro seats ($19/mo each) when using CMS or Identity features",
  impact: "high",
  source_url: "https://www.netlify.com/pricing/",
};

const PINGMETER = {
  vendor: "Pingmeter.com",
  change_type: "restriction",
  date: "2026-08-28",
  date_source: "discovered",
  summary:
    "The free tier now has restrictions: limited to accounts with 1 category and less than 5 uptime " +
    "monitors. SMS/voice notification, scheduling and recovery actions are excluded from the free tier.",
  previous_state:
    "5 uptime monitors with 10-minute interval. Monitor SSH, HTTP, HTTPS, and any custom TCP ports.",
  current_state:
    "Free account is limited to accounts with 1 category and less than 5 uptime monitors. It exclude pro " +
    "features such as sms/voice notification, scheduling and recovery actions.",
  impact: "medium",
  source_url: "https://pingmeter.com/",
};

describe("a page that defines two names for one unit", () => {
  it("reads the equation the pricing page writes out", () => {
    assert.deepStrictEqual(definedEquivalences(GEOCODIO_PRICING_PAGE), [
      { left: "address or coordinate lookup", right: "credit", form: "equation" },
    ]);
  });

  it("reads an abbreviation the page expands", () => {
    const pairs = definedEquivalences("Billing is per monthly tracked user (MTU). 100 MTUs are included.");
    assert.deepStrictEqual(pairs, [
      { left: "monthly tracked user", right: "MTU", form: "abbreviation" },
    ]);
  });

  it("reads an expansion the page puts after the abbreviation", () => {
    const pairs = definedEquivalences("Your plan includes 100 MTU (monthly tracked users) per month.");
    assert.deepStrictEqual(pairs, [
      { left: "monthly tracked users", right: "MTU", form: "abbreviation" },
    ]);
  });

  it("refuses a parenthesis whose letters the phrase does not spell", () => {
    assert.deepStrictEqual(definedEquivalences("All prices shown in dollars (USD) per month."), []);
    assert.deepStrictEqual(definedEquivalences("The free plan (currently) includes 5 seats."), []);
  });

  it("makes the two words interchangeable in both directions", () => {
    const aliases = unitAliases(GEOCODIO_PRICING_PAGE);
    assert.ok(aliases.get("lookup")?.has("credit"), "lookup resolves to credit");
    assert.ok(aliases.get("credit")?.has("lookup"), "credit resolves to lookup");
    assert.strictEqual(unitAliases(undefined).size, 0);
  });
});

describe("a restriction has to establish that something narrowed", () => {
  it("refuses a record whose own summary reports the free tier still standing", () => {
    assert.strictEqual(reportsNoNarrowing(TESTINGBOT.summary), true);
    const verdict = restrictionEvidence(TESTINGBOT);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_STATES_NO_NARROWING);
  });

  it("keeps a record whose summary reports a free tier still open and a term that moved", () => {
    const stillFreeButSmaller = {
      ...NETLIFY,
      vendor: "Somewhere",
      date_source: "discovered",
      summary: "The free tier is still offered. Storage on it dropped from 10 GB to 1 GB.",
      previous_state: "Free plan: 10 GB storage",
      current_state: "Free plan: 1 GB storage",
    };
    assert.strictEqual(reportsSomethingStillFree(stillFreeButSmaller.summary), true);
    assert.strictEqual(reportsNoNarrowing(stillFreeButSmaller.summary), false);
    assert.strictEqual(restrictionEvidence(stillFreeButSmaller).ok, true);
  });

  it("refuses a record measured against a stored description that states no terms", () => {
    for (const record of [DEBUGMAIL, TICKGIT]) {
      const verdict = restrictionEvidence(record);
      assert.strictEqual(verdict.ok, false, `${record.vendor} is refused`);
      assert.strictEqual(verdict.reason, REJECT_NO_TERMS_TO_NARROW);
      assert.match(verdict.detail, new RegExp(record.previous_state.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("does not second-guess a baseline a person wrote by hand", () => {
    assert.strictEqual(restrictionEvidence(NETLIFY).ok, true);
    const asDiscovered = { ...NETLIFY, date_source: "discovered" };
    assert.strictEqual(restrictionEvidence(asDiscovered).reason, REJECT_NO_TERMS_TO_NARROW);
  });

  it("refuses a record whose allowance only changed name, on the page's own definition", () => {
    const verdict = restrictionEvidence(GEOCODIO, { pageText: GEOCODIO_PRICING_PAGE });
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_MEASURES_NO_CHANGE);
    assert.match(verdict.detail, /2,500 lookup\/day against 2,500 credit\/day/);
  });

  it("takes the equivalence from the page and not from anywhere else", () => {
    assert.strictEqual(restrictionEvidence(GEOCODIO).ok, true);
    assert.strictEqual(restrictionEvidence(GEOCODIO, { pageText: "Geocodio pricing. Credits are billed monthly." }).ok, true);
  });

  it("leaves a record alone when the two states name one unit and the allowance did move", () => {
    const halved = {
      ...GEOCODIO,
      current_state: "Pay-as-you-go accounts get the first 1,000 credits per day for free.",
    };
    assert.strictEqual(restrictionEvidence(halved, { pageText: GEOCODIO_PRICING_PAGE }).ok, true);
  });

  it("keeps every record the control set holds", () => {
    for (const record of [NETLIFY, PINGMETER]) {
      const verdict = restrictionEvidence(record);
      assert.strictEqual(verdict.ok, true, `${record.vendor} survives`);
      assert.strictEqual(verdict.reclassifyAs, undefined, `${record.vendor} keeps its type`);
    }
  });
});

describe("a repair to our own entry is not something the vendor did", () => {
  it("recognises both records that say our earlier entry was wrong", () => {
    for (const record of [NEO4J, DIGITALOCEAN_CORRECTION]) {
      assert.strictEqual(correctsOurOwnRecord(record), true, `${record.vendor} corrects our record`);
      const verdict = restrictionEvidence(record);
      assert.strictEqual(verdict.ok, true);
      assert.strictEqual(verdict.reclassifyAs, RECLASSIFIED_AS_CORRECTION);
    }
  });

  it("wants the wrongness and our own entry inside one clause", () => {
    const vendorWasWrong = {
      ...NETLIFY,
      summary: "The vendor's page previously stated the wrong price. Seats are now billed per committer.",
    };
    assert.strictEqual(correctsOurOwnRecord(vendorWasWrong), false);
    assert.strictEqual(restrictionEvidence(vendorWasWrong).reclassifyAs, undefined);
  });

  it("does not reclassify a record that merely mentions a previous listing", () => {
    const merelyPrevious = {
      ...NETLIFY,
      summary: "The previous listing offered 5 seats. The free plan now offers 1 seat.",
    };
    assert.strictEqual(correctsOurOwnRecord(merelyPrevious), false);
  });

  it("does not join our own entry in one sentence to a wrongness in another", () => {
    const splitAcrossClauses = {
      ...NETLIFY,
      summary:
        "The previous listing offered 5 seats. The vendor has since corrected its own pricing page to show 1 seat.",
    };
    assert.match(splitAcrossClauses.summary, /previous listing/);
    assert.match(splitAcrossClauses.summary, /corrected/);
    assert.strictEqual(correctsOurOwnRecord(splitAcrossClauses), false);
    assert.strictEqual(restrictionEvidence(splitAcrossClauses).reclassifyAs, undefined);
  });
});

describe("the gate carries the restriction rules", () => {
  it("refuses through describesChange, not only through the rule", () => {
    const verdict = describesChange(TESTINGBOT);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_STATES_NO_NARROWING);
  });

  it("reclassifies through describesChange", () => {
    const verdict = describesChange(NEO4J);
    assert.strictEqual(verdict.ok, true);
    assert.strictEqual(verdict.reclassifyAs, RECLASSIFIED_AS_CORRECTION);
  });

  it("hands the page it read to the rule that needs it", () => {
    const withPage = describesChange(GEOCODIO, { pageText: GEOCODIO_PRICING_PAGE });
    assert.strictEqual(withPage.ok, false);
    assert.strictEqual(withPage.reason, REJECT_MEASURES_NO_CHANGE);
  });

  it("leaves every other change type to the rules that already cover it", () => {
    const asLimitsReduced = { ...TESTINGBOT, change_type: "limits_reduced" };
    assert.strictEqual(restrictionEvidence(asLimitsReduced).ok, true);
  });
});

describe("every restriction we have stored survives its own rule", () => {
  const stored = JSON.parse(
    readFileSync(path.join(__dirname, "..", "data", "deal_changes.json"), "utf-8")
  ).changes as Array<Record<string, string>>;

  it("holds no restriction record the rule refuses", () => {
    const failing = stored
      .filter(c => c.change_type === "restriction")
      .map(c => ({ record: c, verdict: restrictionEvidence(c) }))
      .filter(({ verdict }) => !verdict.ok)
      .map(({ record, verdict }) => `${record.vendor} ${record.date}: ${verdict.reason}`);
    assert.deepStrictEqual(failing, [], `stored restrictions the rule refuses:\n${failing.join("\n")}`);
  });

  it("holds no restriction record that corrects our own entry", () => {
    const mistyped = stored
      .filter(c => c.change_type === "restriction" && correctsOurOwnRecord(c))
      .map(c => `${c.vendor} ${c.date}`);
    assert.deepStrictEqual(mistyped, []);
  });

  it("still holds the restrictions the control set names", () => {
    const kept = new Set(stored.filter(c => c.change_type === "restriction").map(c => c.vendor));
    for (const vendor of ["Postman", "Netlify", "Google Gemini API", "GitHub Copilot"]) {
      assert.ok(kept.has(vendor), `${vendor} keeps its restriction record`);
    }
  });

  it("keeps both records the corpus pass retyped as corrections", () => {
    const corrections = new Set(
      stored.filter(c => c.change_type === RECLASSIFIED_AS_CORRECTION).map(c => `${c.vendor} ${c.date}`)
    );
    for (const id of ["DigitalOcean 2026-03-21", "Neo4j AuraDB 2026-03-22"]) {
      assert.ok(corrections.has(id), `${id} is still typed ${RECLASSIFIED_AS_CORRECTION}`);
    }
  });

  it("holds no correction record whose summary does not say it corrects our own entry", () => {
    const unsupported = stored
      .filter(c => c.change_type === RECLASSIFIED_AS_CORRECTION && !correctsOurOwnRecord(c))
      .map(c => `${c.vendor} ${c.date}`);
    assert.deepStrictEqual(unsupported, []);
  });

  it("is not vacuous — the population is large enough to have caught the seven", () => {
    const curated = stored.filter(c => c.change_type === "restriction" && c.date_source === "hand_written");
    assert.ok(curated.length >= 7, `hand-written restriction records: ${curated.length}`);
  });
});
