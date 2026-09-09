import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  A_PLAN_PRICED_AT_NOTHING,
  freePlanStatedOn,
  readablePartsOf,
  statedOnlyInMarkupWeDiscard,
  statesAFreePlan,
  structuredTextOf,
  visibleTextOf,
  whereAFreePlanIsStated,
} = await import("../dist/page-free-plan.js");
const { REMOVAL_CLASS, aFreePlanOnThePageWouldRefuteIt, removalRecordsInTheServedWindow, removalRecordsStillInForce } =
  await import("../dist/removal-record.js");
const { publishedRisk } = await import("../dist/data.js");
const { storedTermsAreSuperseded } = await import("../dist/superseded-description.js");
const { theEventNeverHappened } = await import("../dist/change-resolution.js");
const { isOurOwnBookkeeping, narrowingSentence } = await import("../dist/vendor-verdict.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const PLAN_LADDERS = {
  middleware:
    "Flexible pricing that adapts to your business growth.. Free Forever. $0. Free access to all features with monthly limits.. Sign Up Now . Up to 100GB Data. Up to 1k RUM Sessions. Up to 20k Synthetic Checks. 10 Browser Test Runs. Unlimited Users.",
  financialData:
    "Monthly . Yearly 30% Off . . . Free. $ 0 /month . 300 Requests / Day. REST API & Python SDK. Symbol Lists. Get Started . . . . Standard. $ 29 /month . 10 Requests / Second.",
  simpleObservability:
    "Stop guessing your bill at the end of the month. . . Free. Free plan for one server. Ideal for testing, development, or low-traffic workloads. . Free. for 1 server. . Start For Free ● 50 metrics per server . ● Low log volume .",
  localazy:
    "No credit card required! Start a 14-day trial of Business plan.. . Small project = free plan!. . Start your localization journey early with all the essentials you need.. Up to 200 source keys All essential localization features Unlimited seats & languages",
  scraperApiAnswer:
    "Does ScraperAPI offer a free plan? . Yes, ScraperAPI offers a free plan where you can sign up here and get 1,000 free API credits (with a maximum of 5 concurrent connections).",
  survicateAnswer:
    "FAQPage. Question. Answer. Yes! Our Free Plan is perfect for getting started with surveys at no cost. It includes: Up to 25 responses per month, 1 active survey at a time, Basic CRM integrations.",
};

const NOT_A_PLAN_LADDER = {
  aCreditAllowanceInsideAPaidPlan:
    "RBAC & audit logging . 500 free API / MCP credits per month . . Start free trial + Scale & security. Enterprise.",
  anotherVendorsFreeKey:
    "To keep using our API, switch to ipstack and get your free API key. Switch to ipstack .",
  aDiscountForOpenSource:
    "Open source Enterprise . . Free for Open Source. Chat with us -> . We come from an open-source background and are committed to supporting open-source projects.",
  onlyTheQuestion:
    "Is there a Free version of Survicate? . How do you count responses? . How do you count datapoints? .",
};

const WHERE_THE_RULE_IS_WRONG = {
  aLedeThePlanTableDoesNotBackUp:
    "Start monitoring your infrastructure in under 60 seconds. No credit card required.. Start Free Trial Talk to Sales . Free plan available • No credit card required • Setup in 60 seconds.",
  aFictionalLadderInsideAProductDemo:
    "replay · session 4f2a91 DE . acme Product Pricing Docs Sign in . Plans for every team. Start free, upgrade when you need to.. Free. $0 /mo . . Choose Free. . Pro. $24 /mo . . Choose Pro. . Checkout · Pro. Card number. MM / YY. . Pay now.",
};

const CORRECTED_ON = "2026-09-09";

const RETRACTED = [
  "Middleware.io",
  "ploi.io",
  "Simple Observability",
  "Financial Data",
  "DynamicDocs",
  "Survicate",
  "ScraperAPI",
];

const RETYPED: Record<string, { date: string; type: string }> = {
  "localazy.com": { date: "2026-09-07", type: "limits_reduced" },
  InstallOnAir: { date: "2026-08-28", type: "limits_reduced" },
};

const STILL_STANDS = [
  "bonsai.io",
  "Burner Mail",
  "fivenines.io",
  "IPTrace",
  "LogRocket",
  "Unkey",
  "Webvizio",
  "Xitoring.com",
  "Rybbit",
  "Applitools",
  "Circum Icons",
  "Plausible",
  "Highlight.io",
  "Augment Code",
  "Momento",
];

function changesFor(vendor: string): DealChange[] {
  return changes.filter((c) => c.vendor.toLowerCase() === vendor.toLowerCase());
}

function offerFor(vendor: string): Offer | undefined {
  return offers.find((o) => o.vendor.toLowerCase() === vendor.toLowerCase());
}

describe("a page that prices a plan at nothing", () => {
  for (const [vendor, ladder] of Object.entries(PLAN_LADDERS)) {
    it(`is read off ${vendor}`, () => {
      assert.ok(whereAFreePlanIsStated(ladder), `no free plan read from: ${ladder.slice(0, 80)}`);
    });
  }

  for (const [shape, text] of Object.entries(NOT_A_PLAN_LADDER)) {
    it(`is not read off ${shape}`, () => {
      assert.equal(whereAFreePlanIsStated(text), null, `read a free plan from: ${text.slice(0, 80)}`);
    });
  }

  it("is not read from a question on its own, and is read from the answer beneath it", () => {
    assert.equal(whereAFreePlanIsStated(NOT_A_PLAN_LADDER.onlyTheQuestion), null);
    assert.ok(whereAFreePlanIsStated(PLAN_LADDERS.scraperApiAnswer));
  });

  it("needs a plan word or a zero price, not the word free on its own", () => {
    assert.equal(statesAFreePlan("Get started for free today."), false);
    assert.equal(statesAFreePlan("Try it free."), false);
    assert.equal(statesAFreePlan("Free. $0 /month . 300 Requests / Day."), true);
  });

  it("does not count a plan the page denies or prices only as a trial", () => {
    assert.equal(statesAFreePlan("The free plan is no longer available."), false);
    assert.equal(statesAFreePlan("Start your 14-day free trial of the Business plan."), false);
  });

  it("does not count the plan an announcement names as the one it is taking away", () => {
    const announcements = [
      "In order to focus our resources, we will be phasing out our free plan for Heroku Dynos, free plan for Heroku Postgres, and free plan for Heroku Data for Redis.",
      "I understand completely that retiring our free tier will cause inconvenience to some of our users.",
      "We are winding down the free tier at the end of the month.",
      "The free plan is being sunset on 1 March.",
    ];
    for (const announcement of announcements) {
      assert.equal(statesAFreePlan(announcement), false, announcement);
    }
  });

  it("reads a currency amount of nothing however the page spaces it", () => {
    for (const priced of ["$0 /mo", "$ 0 /month", "€0 /mo", "£0 per month", "$0.00 / user"]) {
      assert.ok(A_PLAN_PRICED_AT_NOTHING.test(priced), priced);
    }
  });
});

describe("terms a page publishes only in structured markup", () => {
  const page = `<html><body><div class="accordion">${NOT_A_PLAN_LADDER.onlyTheQuestion}</div>
    <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is there a Free version of Survicate?","acceptedAnswer":{"@type":"Answer","text":"Yes! Our Free Plan is perfect for getting started with surveys at no cost. It includes: Up to 25 responses per month."}}]}</script>
    </body></html>`;

  it("are invisible to a reader of the rendered text", () => {
    assert.equal(whereAFreePlanIsStated(visibleTextOf(page)), null);
  });

  it("are recovered from the markup", () => {
    assert.ok(structuredTextOf(page).includes("Up to 25 responses per month"));
    assert.equal(freePlanStatedOn(readablePartsOf(page))?.where, "structured");
    assert.equal(statedOnlyInMarkupWeDiscard(readablePartsOf(page)), true);
  });

  it("do not swallow a page whose markup will not parse", () => {
    const broken = `<html><script type="application/ld+json">{not json}</script><body>Free. $0 /mo.</body></html>`;
    assert.equal(structuredTextOf(broken), "");
    assert.equal(freePlanStatedOn(readablePartsOf(broken))?.where, "visible");
  });
});

describe("what a free plan on the page can refute", () => {
  it("refutes a record that says the free tier was removed", () => {
    assert.equal(aFreePlanOnThePageWouldRefuteIt("free_tier_removed"), true);
  });

  it("does not refute a record that says the product is ending", () => {
    assert.ok(REMOVAL_CLASS.has("product_deprecated"));
    assert.equal(aFreePlanOnThePageWouldRefuteIt("product_deprecated"), false);
  });

  it("is asked of no record we have already withdrawn", () => {
    const withdrawn = changes.filter((c) => REMOVAL_CLASS.has(c.change_type) && c.resolution);
    assert.ok(withdrawn.length > 0);
    assert.equal(removalRecordsStillInForce(withdrawn).length, 0);
  });
});

describe("the rule reads a plan table over a lede, and here is where it does not", () => {
  it("still believes a lede that claims a free plan the plan table does not carry", () => {
    assert.ok(whereAFreePlanIsStated(WHERE_THE_RULE_IS_WRONG.aLedeThePlanTableDoesNotBackUp));
  });

  it("still believes a plan table belonging to a fictional company inside a product demo", () => {
    assert.ok(whereAFreePlanIsStated(WHERE_THE_RULE_IS_WRONG.aFictionalLadderInsideAProductDemo));
  });
});

describe("records whose own pricing page sells the plan they withheld", () => {
  for (const vendor of RETRACTED) {
    it(`${vendor} no longer withholds a free tier`, () => {
      const record = changesFor(vendor).find((c) => c.change_type === "free_tier_removed");
      assert.ok(record, `${vendor} has no free_tier_removed record`);
      assert.equal(theEventNeverHappened(record), true);
      assert.equal(record.resolution?.date, CORRECTED_ON);
      const cited = record.resolution?.source_url ?? "";
      assert.ok(cited, `${vendor} withdrawal cites nothing`);
      const detail = record.resolution?.detail ?? "";
      assert.match(detail, /"/, `${vendor} withdrawal quotes nothing from the page`);
      assert.ok(
        detail.includes(new URL(cited).hostname.replace(/^www\./, "")),
        `${vendor} withdrawal does not name the page it read`,
      );
    });
  }

  for (const [vendor, expected] of Object.entries(RETYPED)) {
    it(`${vendor} records the narrowing that actually happened`, () => {
      const record = changesFor(vendor).find((c) => c.date === expected.date);
      assert.ok(record, `${vendor} has no record on ${expected.date}`);
      assert.equal(record.change_type, expected.type);
      assert.equal(REMOVAL_CLASS.has(record.change_type), false);
    });
  }

  it("leaves none of them rated risky", () => {
    const risky: string[] = [];
    for (const vendor of [...RETRACTED, ...Object.keys(RETYPED)]) {
      const offer = offerFor(vendor);
      if (!offer) continue;
      const risk = publishedRisk(offer, changesFor(vendor));
      if (risk.risk_level === "risky") risky.push(vendor);
    }
    assert.deepEqual(risky, []);
  });

  it("restores the vendor's own terms wherever the record was withdrawn", () => {
    const withheld: string[] = [];
    for (const vendor of RETRACTED) {
      const offer = offerFor(vendor);
      if (!offer) continue;
      const superseding = storedTermsAreSuperseded(offer, changesFor(vendor));
      const stillNarrowed = changesFor(vendor).some(
        (c) => !c.resolution && c.change_type === "limits_reduced",
      );
      if (superseding && !stillNarrowed) withheld.push(vendor);
    }
    assert.deepEqual(withheld, []);
  });
});

describe("what a vendor page says once we withdraw the only record we held", () => {
  it("does not call a withdrawn record a change the vendor made", () => {
    for (const vendor of RETRACTED) {
      const sentence = narrowingSentence(changesFor(vendor));
      assert.doesNotMatch(
        sentence,
        /change we have recorded|recorded changes/,
        `${vendor}: ${sentence}`,
      );
    }
  });

  it("says whose error it was", () => {
    assert.equal(
      narrowingSentence(changesFor("Middleware.io")),
      "The one record we hold was our own error and has been withdrawn.",
    );
  });

  it("keeps counting the changes a vendor did make", () => {
    assert.match(narrowingSentence(changesFor("ploi.io")), /narrowed the terms/);
  });

  it("separates a withdrawal from a correction entry and from an uncited record", () => {
    const withdrawn = { change_type: "free_tier_removed", date: "2026-01-01", source_url: "https://example.com/pricing", summary: "x", resolution: { state: "retracted", date: "2026-02-01" } };
    const correction = { change_type: "record_corrected", date: "2026-01-01", source_url: "https://example.com/pricing", summary: "x" };
    assert.equal(isOurOwnBookkeeping(withdrawn), true);
    assert.equal(isOurOwnBookkeeping(correction), true);
    assert.equal(isOurOwnBookkeeping({ change_type: "limits_reduced", date: "2026-01-01", summary: "x" }), false);
    assert.match(narrowingSentence([withdrawn] as never), /was our own error and has been withdrawn/);
    assert.match(narrowingSentence([correction] as never), /corrects our own earlier entry/);
  });
});

describe("the records this correction must not move", () => {
  for (const vendor of STILL_STANDS) {
    it(`${vendor} keeps the verdict it had`, () => {
      const held = changesFor(vendor).filter((c) => REMOVAL_CLASS.has(c.change_type));
      if (held.length === 0) return;
      for (const record of held) {
        assert.notEqual(
          record.resolution?.date,
          CORRECTED_ON,
          `${vendor} was withdrawn by this correction and should not have been`,
        );
      }
    });
  }

  it("keeps every removal record we did not read", () => {
    const read = new Set([...RETRACTED, ...Object.keys(RETYPED)].map((v) => v.toLowerCase()));
    const withdrawnOn = changes.filter(
      (c) => c.resolution?.date === CORRECTED_ON && !read.has(c.vendor.toLowerCase()),
    );
    assert.deepEqual(withdrawnOn.map((c) => c.vendor), []);
  });
});

describe("the population a re-read has to cover", () => {
  it("is every removal record still in force in the served window", () => {
    const window = removalRecordsInTheServedWindow(changes);
    assert.ok(window.length > 0);
    for (const record of window) assert.ok(REMOVAL_CLASS.has(record.change_type));
    const inForce = removalRecordsStillInForce(window);
    assert.ok(inForce.length < window.length);
  });

  it("carries a source URL on every record we would re-read", () => {
    const unciteable = removalRecordsStillInForce(removalRecordsInTheServedWindow(changes))
      .filter((c) => aFreePlanOnThePageWouldRefuteIt(c.change_type))
      .filter((c) => !c.source_url?.trim());
    assert.deepEqual(unciteable.map((c) => `${c.vendor} ${c.date}`), []);
  });
});
