import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  STORED_TERMS_WITHHELD_META_PHRASE,
  STORED_TERMS_WITHHELD_PHRASE,
  quotesTheStoredTermsAsPrevious,
  readingBehindTheChange,
  supersededTermsAnswer,
  supersededTermsMetaSentence,
  supersededTermsNotice,
  supersededTermsNoticeHtml,
  supersededTermsVerdictSentence,
  supersedingChange,
  storedTermsAreSuperseded,
} = await import("../dist/superseded-description.js");
const { openingOfTerms } = await import("../dist/terms-opening.js");
const { citationLabel } = await import("../dist/change-citation.js");
const { carriesAnUnrenderedExpression, unrenderedExpressionIn } = await import("../dist/unrendered-text.js");
const { toSlug } = await import("../dist/slug.js");
const { qualityBudget } = await import("../dist/page-reviews.js");
const { supersededCensus } = await import("../dist/superseded-census.js");
const { utcDate } = await import("../dist/ranking.js");
const { tierRecordsAFreeTier } = await import("../dist/free-tier-record.js");
const {
  describesOnlyATrial,
  mentionsSomethingFree,
  namesAFreePlan,
  openingOfAReading,
  whereAFreePlanIsNamed,
} = await import("../dist/superseding-reading.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const A_RUN_MAY_RAISE_IT =
  "The daily re-verification run raises this by reading pages, and lowers it by correcting a " +
  "record, so scripts/ratchet-quality-budgets.js writes what it measures into " +
  "data/quality_budgets.json in the same commit as the data. Nothing else may raise it.";

const changesByVendor = new Map<string, DealChange[]>();
for (const change of changes) {
  const key = change.vendor.toLowerCase();
  const held = changesByVendor.get(key);
  if (held) held.push(change);
  else changesByVendor.set(key, [change]);
}

function changesFor(vendor: string): DealChange[] {
  return changesByVendor.get(vendor.toLowerCase()) ?? [];
}

function supersededRecords(): { offer: Offer; change: DealChange }[] {
  const found: { offer: Offer; change: DealChange }[] = [];
  for (const offer of offers) {
    const change = supersedingChange(offer, changesFor(offer.vendor));
    if (change) found.push({ offer, change });
  }
  return found;
}

function firstRecordFor(vendor: string): Offer {
  return offers.find((o) => o.vendor === vendor)!;
}

function supersededPagesRender(): { offer: Offer; change: DealChange }[] {
  return supersededRecords().filter(({ offer }) => firstRecordFor(offer.vendor) === offer);
}

const A_RECORD = {
  vendor: "Quotacorp",
  category: "Cloud Hosting",
  description: "Free plan: 100 GB egress, 1 GiB storage, 5 projects",
  tier: "Free",
  url: "https://quotacorp.example/pricing",
  tags: ["hosting"],
  verifiedDate: "2026-08-01",
};

const A_CHANGE_QUOTING_IT = {
  vendor: "Quotacorp",
  change_type: "limits_reduced",
  date: "2026-08-28",
  date_source: "discovered",
  summary: "Egress on the free plan is now 20 GiB, down from 100 GB.",
  previous_state: A_RECORD.description,
  current_state: "Free plan: 20 GiB egress, 1 GiB storage, 5 projects",
  impact: "high",
  source_url: "https://quotacorp.example/pricing",
  category: "Cloud Hosting",
  alternatives: [],
};

const A_CHANGE_READING_A_TEMPLATE = {
  ...A_CHANGE_QUOTING_IT,
  summary: "The free tier now has a request limit.",
  current_state: "The free tier allows a maximum of {{ appConfig.MaxRequests }} requests. URLs expire.",
};

describe("#1103 a change record that quotes our stored terms as the previous ones", () => {
  it("recognises the quote", () => {
    assert.strictEqual(quotesTheStoredTermsAsPrevious(A_CHANGE_QUOTING_IT, A_RECORD.description), true);
  });

  it("reads through whitespace and case, which the detector does not preserve", () => {
    const reflowed = { ...A_CHANGE_QUOTING_IT, previous_state: "  free plan: 100 GB egress,\n 1 GiB storage,  5 projects " };
    assert.strictEqual(quotesTheStoredTermsAsPrevious(reflowed, A_RECORD.description), true);
  });

  it("does not fire on a change that quotes nothing", () => {
    for (const empty of [undefined, null, "", "   "]) {
      assert.strictEqual(
        quotesTheStoredTermsAsPrevious({ ...A_CHANGE_QUOTING_IT, previous_state: empty }, A_RECORD.description),
        false,
        `previous_state ${JSON.stringify(empty)} must not match`,
      );
    }
  });

  it("does not let a record with no stored terms be superseded by a change that quotes none", () => {
    const blank = { ...A_RECORD, description: "   " };
    const quotingNothing = { ...A_CHANGE_QUOTING_IT, previous_state: "" };
    assert.strictEqual(storedTermsAreSuperseded(blank, [quotingNothing]), false);
    assert.ok(
      changes.filter((c) => !(c.previous_state ?? "").trim()).length > 50,
      "too few changes quote nothing for that guard to be worth holding",
    );
  });

  it("does not fire on a change that quotes part of the stored terms", () => {
    const head = A_RECORD.description.slice(0, 30);
    assert.ok(head.length > 20 && A_RECORD.description.startsWith(head));
    assert.strictEqual(storedTermsAreSuperseded(A_RECORD, [{ ...A_CHANGE_QUOTING_IT, previous_state: head }]), false);
    const extended = { ...A_RECORD, description: `${A_RECORD.description}, 2 seats` };
    assert.strictEqual(storedTermsAreSuperseded(extended, [A_CHANGE_QUOTING_IT]), false);
  });

  it("does not fire once the record carries what the change says replaced the terms", () => {
    const applied = { ...A_RECORD, description: A_CHANGE_QUOTING_IT.current_state };
    assert.strictEqual(storedTermsAreSuperseded(applied, [A_CHANGE_QUOTING_IT]), false);
  });

  it("stops firing when the change is resolved, which is the way back", () => {
    const retracted = {
      ...A_CHANGE_QUOTING_IT,
      resolution: { state: "retracted", date: "2026-09-05", detail: "The plan table still lists 100 GB." },
    };
    assert.strictEqual(storedTermsAreSuperseded(A_RECORD, [retracted]), false);
  });

  it("takes the newest of several", () => {
    const older = { ...A_CHANGE_QUOTING_IT, date: "2026-08-02" };
    const newer = { ...A_CHANGE_QUOTING_IT, date: "2026-09-04" };
    assert.strictEqual(supersedingChange(A_RECORD, [newer, older])?.date, "2026-09-04");
    assert.strictEqual(supersedingChange(A_RECORD, [older, newer])?.date, "2026-09-04");
  });
});

describe("#1103 the catalogue population", () => {
  it("holds no more records than the recorded count, so a widening has to be looked at", () => {
    const budget = qualityBudget("records_with_superseded_terms");
    const measured = supersededRecords().length;
    assert.ok(
      measured <= budget,
      `${measured} records hold terms a change record supersedes, over the ${budget} recorded in ` +
        `data/quality_budgets.json. ${A_RUN_MAY_RAISE_IT}`,
    );
  });

  it("holds no more vendor pages than the recorded count, which is smaller where the vendor has a second record", () => {
    const budget = qualityBudget("vendor_pages_withholding_superseded_terms");
    const measured = supersededPagesRender().length;
    assert.ok(
      measured <= budget,
      `${measured} vendor pages render a superseded record, over the ${budget} recorded in ` +
        `data/quality_budgets.json. ${A_RUN_MAY_RAISE_IT}`,
    );
  });

  it("measures the same population the ratchet writes the budget from", () => {
    const census = supersededCensus(offers, changes, utcDate());
    assert.strictEqual(census.records_with_superseded_terms, supersededRecords().length);
    assert.strictEqual(census.vendor_pages_withholding_superseded_terms, supersededPagesRender().length);
  });

  it("puts one more record over the ceiling every run leaves behind", () => {
    const today = utcDate();
    const atRest = supersededCensus(offers, changes, today).records_with_superseded_terms;
    assert.ok(atRest <= qualityBudget("records_with_superseded_terms"));

    const untouched = offers.find((o) => !supersedingChange(o, changesFor(o.vendor)))!;
    const joining = {
      ...A_CHANGE_QUOTING_IT,
      vendor: untouched.vendor,
      previous_state: untouched.description,
    } as DealChange;

    const grown = supersededCensus(offers, [...changes, joining], today).records_with_superseded_terms;
    assert.strictEqual(grown, atRest + 1);
    assert.ok(!(grown <= atRest), `${grown} passed a ceiling of ${atRest}`);
  });

  it("keeps a record correction under the ceiling, which is the only exit a data pull request has", () => {
    const today = utcDate();
    const budget = qualityBudget("records_with_superseded_terms");
    const atRest = supersededCensus(offers, changes, today).records_with_superseded_terms;
    const { offer } = supersededRecords()[0];
    const corrected = offers.map((o) =>
      o === offer ? { ...o, description: `${o.description}, re-read on ${today}` } : o,
    );

    const after = supersededCensus(corrected, changes, today).records_with_superseded_terms;
    assert.strictEqual(after, atRest - 1);
    assert.ok(after <= budget, "correcting a record must not go red");
  });

  it("finds one superseding change per record, so no page has to choose between two", () => {
    for (const offer of offers) {
      const vendorChanges = changesFor(offer.vendor);
      const chosen = supersedingChange(offer, vendorChanges);
      if (!chosen) continue;
      const readTheOtherWay = supersedingChange(offer, [...vendorChanges].reverse());
      assert.strictEqual(
        readTheOtherWay,
        chosen,
        `${offer.vendor} supersedes its stored terms with a different change when the same records are read in the opposite order, so the page quotes whichever the file happens to list first`,
      );
    }
  });

  it("catches two superseding changes that share a date, which is the only way the order can decide it", () => {
    const sameDay = [
      { ...A_CHANGE_QUOTING_IT, summary: "Egress on the free plan is now 20 GiB." },
      { ...A_CHANGE_QUOTING_IT, summary: "Storage on the free plan is now 500 MiB." },
    ] as DealChange[];

    assert.strictEqual(sameDay[0].date, sameDay[1].date);
    assert.notStrictEqual(
      supersedingChange(A_RECORD, sameDay),
      supersedingChange(A_RECORD, [...sameDay].reverse()),
    );
  });

  it("a later superseding change replaces an earlier one rather than competing with it", () => {
    const earlier = { ...A_CHANGE_QUOTING_IT, date: "2026-08-28" } as DealChange;
    const later = { ...A_CHANGE_QUOTING_IT, date: "2026-09-07" } as DealChange;

    assert.strictEqual(supersedingChange(A_RECORD, [earlier, later]), later);
    assert.strictEqual(supersedingChange(A_RECORD, [later, earlier]), later);
  });

  it("a change that widens the terms does not compete with the one that narrowed them", () => {
    const narrowed = { ...A_CHANGE_QUOTING_IT, date: "2026-08-28" } as DealChange;
    const widened = {
      ...A_CHANGE_QUOTING_IT,
      change_type: "limits_increased",
      date: "2026-09-07",
      summary: "Egress on the free plan is now 200 GB, up from 100 GB.",
    } as DealChange;

    assert.strictEqual(quotesTheStoredTermsAsPrevious(widened, A_RECORD.description), true);
    assert.strictEqual(supersedingChange(A_RECORD, [narrowed, widened]), narrowed);
  });
});

describe("#1103 which recorded changes make the stored terms unpublishable", () => {
  const NARROWS = [
    "free_tier_removed",
    "limits_reduced",
    "restriction",
    "product_deprecated",
    "open_source_killed",
    "pricing_restructured",
    "pricing_model_change",
  ];
  const LEAVES_THE_STORED_FIGURE_CONSERVATIVE = [
    "limits_increased",
    "new_free_tier",
    "new_tier",
    "rebranded",
    "startup_program_expanded",
    "pricing_postponed",
    "record_corrected",
  ];

  it("withholds on a change that narrows the terms and publishes on one that does not", async () => {
    const { narrowsTheStoredTerms } = await import("../dist/change-direction.js");
    for (const type of NARROWS) assert.strictEqual(narrowsTheStoredTerms(type), true, type);
    for (const type of LEAVES_THE_STORED_FIGURE_CONSERVATIVE) {
      assert.strictEqual(narrowsTheStoredTerms(type), false, type);
    }
  });

  it("classifies every change type the data model declares, and nothing is left over", async () => {
    const { CHANGE_DIRECTION } = await import("../dist/change-direction.js");
    const declared = Object.keys(CHANGE_DIRECTION).sort();
    assert.deepStrictEqual([...NARROWS, ...LEAVES_THE_STORED_FIGURE_CONSERVATIVE].sort(), declared);
  });

  it("withholds on a change type it does not recognise, which is the safe direction", async () => {
    const { narrowsTheStoredTerms, directionOfChange } = await import("../dist/change-direction.js");
    assert.strictEqual(directionOfChange("terms_rewritten_by_a_type_we_have_not_met"), null);
    assert.strictEqual(narrowsTheStoredTerms("terms_rewritten_by_a_type_we_have_not_met"), true);
    assert.strictEqual(narrowsTheStoredTerms(undefined as unknown as string), true);
  });

  it("does not supersede the terms on a quoting change that widened them", () => {
    const widening = { ...A_CHANGE_QUOTING_IT, change_type: "limits_increased" };
    assert.strictEqual(quotesTheStoredTermsAsPrevious(widening, A_RECORD.description), true);
    assert.strictEqual(storedTermsAreSuperseded(A_RECORD, [widening]), false);
    assert.strictEqual(storedTermsAreSuperseded(A_RECORD, [A_CHANGE_QUOTING_IT]), true);
  });

  it("takes the newest narrowing change and passes over a newer widening one", () => {
    const olderNarrowing = { ...A_CHANGE_QUOTING_IT, date: "2026-08-02" };
    const newerWidening = { ...A_CHANGE_QUOTING_IT, date: "2026-09-04", change_type: "limits_increased" };
    assert.strictEqual(supersedingChange(A_RECORD, [olderNarrowing, newerWidening])?.date, "2026-08-02");
  });

  it("leaves every record the change log only ever widened publishing its terms", () => {
    const widenedOnly = offers.filter((offer) => {
      const quoting = changesFor(offer.vendor).filter(
        (c) => !c.resolution && quotesTheStoredTermsAsPrevious(c, offer.description),
      );
      return quoting.length > 0 && !supersedingChange(offer, changesFor(offer.vendor));
    });
    assert.ok(widenedOnly.length > 0, "no record in the shipped data exercises this, so the assertion is vacuous");
    for (const offer of widenedOnly) {
      assert.strictEqual(supersedingChange(offer, changesFor(offer.vendor)), null, offer.vendor);
    }
  });
});

describe("#1383 which of the two directions holds a scheduled data commit", () => {
  const CENSUS = [
    "records_with_superseded_terms",
    "vendor_pages_withholding_superseded_terms",
    "ungated_pages_withholding_superseded_terms",
  ] as const;

  it("names the three counts a data run may raise, and no others", async () => {
    const { QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE, QUALITY_BUDGET_NAMES } = await import("../dist/page-reviews.js");
    assert.deepStrictEqual([...QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE], [...CENSUS]);
    for (const name of CENSUS) assert.ok(QUALITY_BUDGET_NAMES.includes(name), `${name} is not a budget`);
  });

  it("writes a rise in one of the three rather than reporting it over budget", async () => {
    const { ratchet } = await import("../scripts/ratchet-quality-budgets.js");
    const budgets = { records_with_superseded_terms: 237, stale_fact_pages: 57 };
    const { next, raised, over } = ratchet(budgets, { records_with_superseded_terms: 263, stale_fact_pages: 57 });
    assert.strictEqual(next.records_with_superseded_terms, 263);
    assert.deepStrictEqual(raised, [{ name: "records_with_superseded_terms", from: 237, to: 263 }]);
    assert.deepStrictEqual(over, []);
  });

  it("still reports a rise in a budget outside the three, so that one holds the commit", async () => {
    const { ratchet } = await import("../scripts/ratchet-quality-budgets.js");
    const budgets = { records_with_superseded_terms: 237, stale_fact_pages: 57 };
    const { next, raised, over } = ratchet(budgets, { records_with_superseded_terms: 237, stale_fact_pages: 58 });
    assert.strictEqual(next.stale_fact_pages, 57);
    assert.deepStrictEqual(raised, []);
    assert.deepStrictEqual(over, [{ name: "stale_fact_pages", budget: 57, measured: 58 }]);
  });

  it("lowers one of the three the same way every other budget is lowered", async () => {
    const { ratchet } = await import("../scripts/ratchet-quality-budgets.js");
    const budgets = { records_with_superseded_terms: 237 };
    const { next, lowered, raised } = ratchet(budgets, { records_with_superseded_terms: 235 });
    assert.strictEqual(next.records_with_superseded_terms, 235);
    assert.deepStrictEqual(lowered, [{ name: "records_with_superseded_terms", from: 237, to: 235 }]);
    assert.deepStrictEqual(raised, []);
  });

  it("measures the three from the shipped data under the ceilings the shipped budgets hold", async () => {
    const { measureBudgets } = await import("../scripts/ratchet-quality-budgets.js");
    const measured = measureBudgets(utcDate());
    for (const name of CENSUS) {
      assert.ok(
        measured[name] <= qualityBudget(name),
        `the ratchet measures ${name} at ${measured[name]}, over the ${qualityBudget(name)} it holds`,
      );
    }
  });

  it("leaves no equality assertion pinning the population in either direction", () => {
    const pinned = /assert\.strictEqual\([^)]*(SUPERSEDED|WITHHOLDING|RENDERING)/;
    for (const file of ["superseded-terms.test.ts", "gated-vendor-answers.test.ts"]) {
      const source = readFileSync(path.join(REPO, "test", file), "utf-8");
      assert.ok(!pinned.test(source), `${file} still pins the population with an equality assertion`);
    }
  });
});

describe("#1424 whether a superseding reading prices a plan or describes a trial", () => {
  const A_TRIAL_AND_NOTHING_ELSE = [
    ["a trial in place of a free forever plan", "We provide 14 days free trial with unlimited data ingestion."],
    ["a trial in place of a free plan", "A 7-day trial is available with 5,000 API credits and no credit card required."],
    [
      "a trial banner in place of a free plan",
      "Free 10-day trial No card required Explore all features Give Survicate a test drive with the following features: " +
        "Collect up to 25 survey responses Research Hub with 100 data points 25+ integrations available",
    ],
    ["a trial with no plan beside it", "Offers a 7-day free trial, no credit card required."],
  ] as const;

  const A_PLAN = [
    [
      "a free price beside a paid one",
      "Send 100 monthly geocode requests for free — in case you ever need more, premium geocoding subscriptions start at just USD $9.99 per month.",
    ],
    ["a paid plan and its limits", "Starter plan includes 10 users, 500 test results / month, and 100 prompt execs / month."],
    ["prices per period", "DBOS Pro is $99/month (2 user seats, 3 apps, 1M checkpoints)."],
    ["prices per token", "Grok 4.6: Input $2.00 / 1M tokens, Output $6.00 / 1M tokens"],
  ] as const;

  const NAMES_A_FREE_PLAN = [
    "The free tier includes unlimited API requests, 50,000 monthly active users, 500 MB database size.",
    "Always Free services include HeatWave AMD-based Compute and Object Storage.",
    "Free Forever $0 Free Up to 25 infrastructure units",
    "The Free plan costs $0 per month and includes 50 AI credits.",
    "The Community plan is free and includes unlimited users.",
  ];

  const NAMES_NO_FREE_PLAN = [
    "The page offers a free trial with up to 1,000 MAU and 6-month message retention.",
    "Start with a free credit of $40.",
    "It does not mention a permanently free tier for up to 5 servers.",
    'It states "Why We are Removing Burner Mail\'s Free Plan Read more".',
    "Brevo 50% off Starter and Standard Plans Save up to $2,574",
    "Free plan trial: 14 days, then $19 a month.",
  ];

  const OFFERS_NOTHING_FREE_OUTRIGHT = [
    "Start for free with $50 in credit for new signups.",
    "There is a free 7-day trial, then $10 a month for the Developer plan.",
    "Brevo 50% off Starter and Standard Plans Save up to $2,574",
  ];

  const OFFERS_SOMETHING_FREE_OUTRIGHT = [
    "KIRO FREE $0 per month 50 credits.",
    "The Free plan costs $0 per month and includes 50 AI credits.",
    "Leiga is free forever with no credit card required.",
  ];

  for (const sentence of OFFERS_NOTHING_FREE_OUTRIGHT) {
    it(`reads nothing as offered free outright in "${sentence.slice(0, 40)}"`, () => {
      assert.strictEqual(mentionsSomethingFree(sentence), false);
    });
  }

  for (const sentence of OFFERS_SOMETHING_FREE_OUTRIGHT) {
    it(`reads something as offered free outright in "${sentence.slice(0, 40)}"`, () => {
      assert.strictEqual(mentionsSomethingFree(sentence), true);
    });
  }

  for (const [shape, reading] of A_TRIAL_AND_NOTHING_ELSE) {
    it(`reads ${shape} as no reading of the plan table`, () => {
      assert.strictEqual(describesOnlyATrial(reading), true, reading);
    });
  }

  for (const [shape, reading] of A_PLAN) {
    it(`reads ${shape} as a reading of the plan table`, () => {
      assert.strictEqual(describesOnlyATrial(reading), false, reading);
    });
  }

  for (const sentence of NAMES_A_FREE_PLAN) {
    it(`finds the free plan in "${sentence.slice(0, 44)}"`, () => {
      assert.strictEqual(namesAFreePlan(sentence), true);
    });
  }

  for (const sentence of NAMES_NO_FREE_PLAN) {
    it(`finds no free plan in "${sentence.slice(0, 44)}"`, () => {
      assert.strictEqual(namesAFreePlan(sentence), false);
    });
  }

  it("opens on the sentence that names the free plan when the first one does not", () => {
    const reading =
      "Test Manager Premium is $49 /month billed annually. KaneAI Starter is $17 /month billed annually. " +
      "A free forever plan for Test Manager exists with unlimited projects and 24x7 support.";
    assert.strictEqual(openingOfTerms(reading, 90), "Test Manager Premium is $49 /month billed annually…");
    assert.strictEqual(
      openingOfAReading(reading, 90),
      "…A free forever plan for Test Manager exists with unlimited projects and 24x7 support.",
    );
  });

  it("opens where it always did when the first sentence already says something is free", () => {
    const reading = "The free tier includes 10K search requests a month and 50K records. Paid plans start at $50.";
    assert.strictEqual(openingOfAReading(reading, 60), openingOfTerms(reading, 60));
  });

  it("opens where it always did when no sentence names a free plan", () => {
    const reading = "Starter plan includes 10 users, 500 test results / month, and 100 prompt execs / month.";
    assert.strictEqual(openingOfAReading(reading, 40), openingOfTerms(reading, 40));
  });

  it("marks the opening it moved, so a reader can see it began later than the reading did", () => {
    const reading = "Pricing starts at $76 a month for 1K sessions. The free tier covers 1,000 sessions a month.";
    assert.ok(openingOfAReading(reading, 60).startsWith("…"));
  });

  it("keeps the withholding wherever the record is not a free-tier one", () => {
    const trialOnly = { ...A_CHANGE_QUOTING_IT, current_state: "Offers a 7-day free trial, no credit card required." };
    assert.strictEqual(supersedingChange({ ...A_RECORD, tier: "Startup Program" }, [trialOnly]), trialOnly);
    assert.strictEqual(supersedingChange({ ...A_RECORD, tier: "Free" }, [trialOnly]), null);
  });

  it("keeps the withholding wherever the reading prices a plan", () => {
    const priced = { ...A_CHANGE_QUOTING_IT, current_state: "After the trial, plans start at $349 per month." };
    assert.strictEqual(supersedingChange({ ...A_RECORD, tier: "Free" }, [priced]), priced);
  });
});

describe("#1386 the reading the superseding record already holds", () => {
  const NO_READING_TO_PUBLISH = [
    ["no source", { source_url: "" }],
    ["a blank source", { source_url: "   " }],
    ["no source field", { source_url: undefined }],
    ["nothing read", { current_state: "" }],
    ["a blank reading", { current_state: "  \n " }],
  ] as const;

  const TERMS_THE_PAGE_NEVER_RENDERED = [
    ["a client-side template", "The free tier allows a maximum of {{ appConfig.MaxRequests }} requests."],
    ["a template literal", "Free plan: ${limits.egress} of egress a month"],
    ["a server-side template", "Free plan: <%= plan.storage %> of storage"],
    ["a stringified object", "Free plan: [object Object] included"],
    ["a value that never arrived", "Free plan: undefined GB of egress"],
    ["a calculation that failed", "Free plan: NaN requests per month"],
  ] as const;

  it("is the current state, dated by the day the record was written, attributed to its source", () => {
    const reading = readingBehindTheChange({ ...A_CHANGE_QUOTING_IT, recorded_date: "2026-08-29" })!;
    assert.strictEqual(reading.terms, A_CHANGE_QUOTING_IT.current_state);
    assert.strictEqual(reading.url, A_CHANGE_QUOTING_IT.source_url);
    assert.strictEqual(reading.label, "quotacorp.example/pricing");
    assert.strictEqual(reading.date, "2026-08-29");
  });

  it("falls back to the change date where the record does not say when it was written", () => {
    assert.strictEqual(readingBehindTheChange(A_CHANGE_QUOTING_IT)!.date, A_CHANGE_QUOTING_IT.date);
  });

  it("is nothing at all where the record cites no page or read nothing off it", () => {
    for (const [why, missing] of NO_READING_TO_PUBLISH) {
      assert.strictEqual(readingBehindTheChange({ ...A_CHANGE_QUOTING_IT, ...missing }), null, why);
    }
  });

  it("is nothing at all where the terms carry an expression the vendor's page never rendered", () => {
    for (const [why, current_state] of TERMS_THE_PAGE_NEVER_RENDERED) {
      assert.strictEqual(readingBehindTheChange({ ...A_CHANGE_QUOTING_IT, current_state }), null, why);
    }
  });

  it("names the expression it refused, and finds none in terms a page did render", () => {
    assert.strictEqual(
      unrenderedExpressionIn(A_CHANGE_READING_A_TEMPLATE.current_state),
      "{{ appConfig.MaxRequests }}",
    );
    assert.strictEqual(unrenderedExpressionIn("a maximum of {{ appConfig.MaxReq"), "{{ appConfig.MaxReq");
    for (const rendered of [
      A_CHANGE_QUOTING_IT.current_state,
      "Starter: $0 / month — $10 credits + tok rates, 1 GB processed data + $4/GB",
      "Orders 25, Items 100, Bandwidth 5 GB, API calls 25000, Users Unlimited",
      "Free for 3 users. Projects 10. Environments 4. Config syncs (5).",
      "$15 free credits per month (≈ 2,000 Ubuntu x64 2-vCPU minutes)",
    ]) {
      assert.strictEqual(carriesAnUnrenderedExpression(rendered), false, rendered);
    }
  });

  it("publishes no reading carrying one, on any record in the catalogue population", () => {
    const carrying = supersededRecords()
      .map(({ offer, change }) => ({
        vendor: offer.vendor,
        found: unrenderedExpressionIn(readingBehindTheChange(change)?.terms),
      }))
      .filter(({ found }) => found)
      .map(({ vendor, found }) => `${vendor} :: ${found}`);
    assert.deepStrictEqual(carrying.slice(0, 20), []);
  });

  it("shortens a URL to what a reader can place, and leaves one it cannot parse alone", () => {
    assert.strictEqual(citationLabel("https://www.turso.tech/pricing/"), "turso.tech/pricing");
    assert.strictEqual(citationLabel("https://supabase.com/"), "supabase.com");
    assert.strictEqual(citationLabel("https://vendor.test/plans?tab=free"), "vendor.test/plans?tab=free");
    assert.strictEqual(citationLabel("not a url"), "not a url");
  });

  it("takes whole sentences up to the cap rather than cutting mid-figure, and marks that it stopped early", () => {
    const terms = "Free plan: 20 GiB egress. Paid plans start at $19/month. Enterprise is quoted.";
    assert.strictEqual(openingOfTerms(terms, 200), terms);
    assert.strictEqual(openingOfTerms(terms, 60), "Free plan: 20 GiB egress. Paid plans start at $19/month…");
    assert.strictEqual(openingOfTerms(terms, 30), "Free plan: 20 GiB egress…");
  });

  it("clips a single long sentence on a word boundary and marks it as clipped", () => {
    const oneSentence = "The free tier includes 500 million rows read per month and 10 million rows written per month";
    const opening = openingOfTerms(oneSentence, 40);
    assert.ok(opening.endsWith("…"), opening);
    assert.ok(opening.length <= 41, opening);
    assert.ok(oneSentence.startsWith(opening.slice(0, -1)), opening);
    assert.ok(!/\s$/.test(opening.slice(0, -1)), opening);
  });

  it("publishes the reading, its date and its source in every wording that withholds our terms", () => {
    const reading = readingBehindTheChange(A_CHANGE_QUOTING_IT)!;
    const wordings = {
      notice: supersededTermsNotice(A_RECORD.vendor, A_CHANGE_QUOTING_IT),
      answer: supersededTermsAnswer(A_RECORD.vendor, A_CHANGE_QUOTING_IT),
      meta: supersededTermsMetaSentence(A_RECORD.vendor, A_CHANGE_QUOTING_IT),
      verdict: supersededTermsVerdictSentence(A_RECORD.vendor, A_CHANGE_QUOTING_IT),
    };
    for (const [surface, text] of Object.entries(wordings)) {
      assert.ok(text.includes(reading.label), `${surface}: ${text}`);
      assert.ok(text.includes(reading.date), `${surface}: ${text}`);
      assert.ok(text.includes(openingOfTerms(reading.terms, 90)), `${surface}: ${text}`);
    }
    assert.ok(wordings.answer.includes(A_CHANGE_QUOTING_IT.summary), wordings.answer);

    assert.ok(!/[.!?…]$/.test(reading.terms), "the fixture must read terms with no closing stop for the next assertion to bite");
    for (const [surface, text] of Object.entries(wordings)) {
      const after = text.indexOf(reading.terms) + reading.terms.length;
      assert.strictEqual(text.slice(after, after + 2), ". ", `${surface} runs the reading into the next sentence: ${text}`);
    }
  });

  it("closes the reading on every record that read terms with no stop of their own", () => {
    const unstopped = supersededRecords()
      .map(({ offer, change }) => ({ offer, change, reading: readingBehindTheChange(change)! }))
      .filter(({ reading }) => reading && !/[.!?…]$/.test(reading.terms));
    assert.ok(unstopped.length > 10, `only ${unstopped.length} records read terms with no closing stop`);
    for (const { offer, change, reading } of unstopped) {
      const notice = supersededTermsNotice(offer.vendor, change);
      const after = notice.indexOf(reading.terms) + reading.terms.length;
      assert.strictEqual(notice.slice(after, after + 2), ". ", `${offer.vendor}: ${notice}`);
    }
  });

  it("says why it withholds, and invents no reading, where the record read an expression the page never rendered", () => {
    const wordings = [
      supersededTermsNotice(A_RECORD.vendor, A_CHANGE_READING_A_TEMPLATE),
      supersededTermsAnswer(A_RECORD.vendor, A_CHANGE_READING_A_TEMPLATE),
      supersededTermsMetaSentence(A_RECORD.vendor, A_CHANGE_READING_A_TEMPLATE),
      supersededTermsVerdictSentence(A_RECORD.vendor, A_CHANGE_READING_A_TEMPLATE),
      unescaped(supersededTermsNoticeHtml(A_RECORD.vendor, A_CHANGE_READING_A_TEMPLATE, escapedFor)),
    ];
    for (const text of wordings) {
      assert.ok(text.includes(STORED_TERMS_WITHHELD_PHRASE), text);
      assert.ok(!text.includes("As of"), text);
      assert.ok(!text.includes("{{"), text);
      assert.ok(!text.includes("appConfig"), text);
    }
  });

  it("says why it withholds, and invents no reading, where the record cites nothing", () => {
    const uncited = { ...A_CHANGE_QUOTING_IT, source_url: "" };
    const wordings = [
      supersededTermsNotice(A_RECORD.vendor, uncited),
      supersededTermsAnswer(A_RECORD.vendor, uncited),
      supersededTermsMetaSentence(A_RECORD.vendor, uncited),
      supersededTermsVerdictSentence(A_RECORD.vendor, uncited),
    ];
    for (const text of wordings) {
      assert.ok(text.includes(STORED_TERMS_WITHHELD_PHRASE), text);
      assert.ok(!text.includes("As of"), text);
      assert.ok(!text.includes(uncited.current_state), text);
    }
  });

  it("links the page in the description block and escapes what it puts in the href", () => {
    const hostile = {
      ...A_CHANGE_QUOTING_IT,
      source_url: 'https://quotacorp.example/pricing?a=1&b="x"',
      current_state: 'Free plan: <b>20 GiB</b> egress & "burst"',
    };
    const html = supersededTermsNoticeHtml(A_RECORD.vendor, hostile, escapedFor);
    assert.ok(html.includes('href="https://quotacorp.example/pricing?a=1&amp;b=&quot;x&quot;"'), html);
    assert.ok(html.includes('class="change-source"'), html);
    assert.ok(!html.includes("<b>"), html);
    assert.ok(html.includes("&lt;b&gt;20 GiB&lt;/b&gt;"), html);
  });

  it("prints no link, and no reading, where the record cites nothing", () => {
    const uncited = { ...A_CHANGE_QUOTING_IT, source_url: "" };
    const html = supersededTermsNoticeHtml(A_RECORD.vendor, uncited, escapedFor);
    assert.ok(!html.includes("<a "), html);
    assert.strictEqual(unescaped(html), supersededTermsNotice(A_RECORD.vendor, uncited));
  });

  it("renders the same words as the plain notice once the markup is taken out", () => {
    const html = supersededTermsNoticeHtml(A_RECORD.vendor, A_CHANGE_QUOTING_IT, escapedFor);
    const asText = unescaped(html.replace(/<[^>]+>/g, ""));
    assert.strictEqual(asText, supersededTermsNotice(A_RECORD.vendor, A_CHANGE_QUOTING_IT));
  });
});

const FIXTURE_VENDOR = "Deno Deploy";
const FIXTURE_SLUG = toSlug(FIXTURE_VENDOR);

function fixtureFrom(withResolution: boolean, changeType?: string) {
  const record = JSON.parse(JSON.stringify(offers.find((o) => o.vendor === FIXTURE_VENDOR)));
  const change = JSON.parse(JSON.stringify(changes.find((c) => c.vendor === FIXTURE_VENDOR)));
  assert.ok(record && change, "the fixture is built from the record and change this issue names");
  record.description = change.previous_state;
  if (changeType) change.change_type = changeType;
  if (withResolution) {
    change.resolution = { state: "reversed", date: "2026-09-04", detail: "The vendor restored the earlier limits." };
  }
  return { record, change };
}

function writeFixture(dir: string, name: string, withResolution: boolean, changeType?: string) {
  const { record, change } = fixtureFrom(withResolution, changeType);
  writeFileSync(path.join(dir, `${name}-index.json`), JSON.stringify({ offers: [record, ...offers.filter((o) => o.vendor !== FIXTURE_VENDOR)] }));
  writeFileSync(path.join(dir, `${name}-changes.json`), JSON.stringify({ changes: [change] }));
  return { record, change };
}

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function jsonLdOfType(html: string, type: string): Record<string, any> | undefined {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed["@type"] === type) return parsed;
    } catch { continue; }
  }
  return undefined;
}

function metaDescriptionOf(html: string): string {
  return /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
}

function descriptionBlockOf(html: string): string {
  return /<div class="desc-block">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
}

function faqAnswersOf(html: string): { question: string; answer: string }[] {
  const faq = jsonLdOfType(html, "FAQPage");
  return (faq?.mainEntity ?? []).map((item: { name: string; acceptedAnswer: { text: string } }) => ({
    question: item.name,
    answer: item.acceptedAnswer.text,
  }));
}

function unescaped(html: string): string {
  return html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapedFor(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function quickVerdictOf(html: string): string {
  return /<div class="quick-verdict">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
}

function withholdingSurfacesOf(html: string): [string, string][] {
  const page = jsonLdOfType(html, "WebPage");
  const surfaces: [string, string][] = [
    ["meta description", unescaped(metaDescriptionOf(html))],
    ["description block", unescaped(descriptionBlockOf(html))],
    ["quick verdict", unescaped(quickVerdictOf(html))],
    ["structured description", String(page?.mainEntity?.description ?? "")],
    ...faqAnswersOf(html).map(({ question, answer }) => [question, answer] as [string, string]),
  ];
  return surfaces.filter(
    ([, text]) => text.includes(STORED_TERMS_WITHHELD_PHRASE) || text.includes(STORED_TERMS_WITHHELD_META_PHRASE),
  );
}

describe("#1103 a page whose stored terms its own change log quotes as previous", () => {
  let dir = "";
  let superseded: { proc: ChildProcess; port: number } | null = null;
  let resolved: { proc: ChildProcess; port: number } | null = null;
  let improved: { proc: ChildProcess; port: number } | null = null;
  let supersededPage = "";
  let resolvedPage = "";
  let improvedPage = "";
  let storedTerms = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "superseded-terms-"));
    const built = writeFixture(dir, "superseded", false);
    writeFixture(dir, "resolved", true);
    writeFixture(dir, "improved", false, "limits_increased");
    storedTerms = built.record.description;
    [superseded, resolved, improved] = await Promise.all([
      startServer({
        AGENTDEALS_INDEX_PATH: path.join(dir, "superseded-index.json"),
        AGENTDEALS_CHANGES_PATH: path.join(dir, "superseded-changes.json"),
      }),
      startServer({
        AGENTDEALS_INDEX_PATH: path.join(dir, "resolved-index.json"),
        AGENTDEALS_CHANGES_PATH: path.join(dir, "resolved-changes.json"),
      }),
      startServer({
        AGENTDEALS_INDEX_PATH: path.join(dir, "improved-index.json"),
        AGENTDEALS_CHANGES_PATH: path.join(dir, "improved-changes.json"),
      }),
    ]);
    supersededPage = await fetch(`http://localhost:${superseded.port}/vendor/${FIXTURE_SLUG}`).then((r) => r.text());
    resolvedPage = await fetch(`http://localhost:${resolved.port}/vendor/${FIXTURE_SLUG}`).then((r) => r.text());
    improvedPage = await fetch(`http://localhost:${improved.port}/vendor/${FIXTURE_SLUG}`).then((r) => r.text());
  });

  after(() => {
    superseded?.proc.kill();
    resolved?.proc.kill();
    improved?.proc.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("builds a fixture whose stored terms are the change's previous_state", () => {
    const { record, change } = fixtureFrom(false);
    assert.strictEqual(record.description, change.previous_state);
    assert.notStrictEqual(change.previous_state, change.current_state);
    assert.ok(storedTerms.length > 60, "the stored terms must be long enough for the assertions below to bite");
  });

  it("does not state the stored terms in the description block", () => {
    assert.ok(!unescaped(descriptionBlockOf(supersededPage)).includes(storedTerms));
  });

  it("does not state the stored terms in the meta description", () => {
    const meta = unescaped(metaDescriptionOf(supersededPage));
    assert.ok(!meta.includes(storedTerms.slice(0, 60)), meta);
    assert.ok(meta.includes(STORED_TERMS_WITHHELD_META_PHRASE), meta);
  });

  it("offers no upgrade threshold read off terms it will not publish", () => {
    assert.ok(!supersededPage.includes(`class="section growth-section"`), "the page still tells the reader when they outgrow figures it withholds");
    assert.ok(resolvedPage.includes(`class="section growth-section"`), "the same page without the supersession must carry one, or the assertion above is vacuous");
  });

  it("does not state the stored terms in the structured description a machine reads", () => {
    const page = jsonLdOfType(supersededPage, "WebPage");
    assert.ok(page, "the page must ship WebPage structured data for the assertion to mean anything");
    assert.ok(!page!.mainEntity.description.includes(storedTerms));
    assert.ok(!String(page!.description).includes(storedTerms.slice(0, 60)));
  });

  it("does not state the stored terms in any structured answer", () => {
    const stating = faqAnswersOf(supersededPage).filter((pair) => pair.answer.includes(storedTerms.slice(0, 60)));
    assert.deepStrictEqual(stating.map((pair) => pair.question), []);
  });

  it("does not answer that the vendor offers the tier we can no longer stand behind", () => {
    const answers = faqAnswersOf(supersededPage);
    const isFree = answers.find((pair) => pair.question === `Is ${FIXTURE_VENDOR} free?`);
    assert.ok(isFree, "the page must still ask whether the vendor is free");
    assert.ok(!isFree!.answer.startsWith("Yes,"), isFree!.answer);
    assert.ok(isFree!.answer.includes(STORED_TERMS_WITHHELD_PHRASE), isFree!.answer);
  });

  it("still names the tier while withholding the figures behind it", () => {
    const tier = faqAnswersOf(supersededPage).find(
      (pair) => pair.question === `What is ${FIXTURE_VENDOR}'s free tier?`,
    );
    assert.ok(tier, "the page must still answer what the tier is called");
    assert.ok(tier!.answer.includes(`is called "Free"`), tier!.answer);
    assert.ok(!tier!.answer.includes(storedTerms.slice(0, 60)), tier!.answer);
  });

  it("does not offer a price of zero to a machine reading the record", () => {
    const page = jsonLdOfType(supersededPage, "WebPage");
    assert.ok(!("offers" in page!.mainEntity), JSON.stringify(page!.mainEntity.offers ?? null));
  });

  it("keeps the terms on the page as what the change record replaced", () => {
    assert.ok(unescaped(supersededPage).includes(storedTerms));
    assert.ok(supersededPage.includes("Before:"));
  });

  it("publishes the same terms as current where the recorded change widened them", () => {
    const { change } = fixtureFrom(false, "limits_increased");
    assert.strictEqual(change.previous_state, fixtureFrom(false).record.description);
    assert.ok(unescaped(descriptionBlockOf(improvedPage)).includes(storedTerms));
    const isFree = faqAnswersOf(improvedPage).find((pair) => pair.question === `Is ${FIXTURE_VENDOR} free?`);
    assert.ok(isFree!.answer.startsWith("Yes,"), isFree!.answer);
    assert.ok("offers" in jsonLdOfType(improvedPage, "WebPage")!.mainEntity);
    assert.ok(!improvedPage.includes(`class="terms-superseded-text"`), "the page withheld terms a widening replaced");
  });

  it("publishes the same terms as current once the change is resolved", () => {
    assert.ok(unescaped(descriptionBlockOf(resolvedPage)).includes(storedTerms));
    const isFree = faqAnswersOf(resolvedPage).find((pair) => pair.question === `Is ${FIXTURE_VENDOR} free?`);
    assert.ok(isFree!.answer.startsWith("Yes,"), isFree!.answer);
    assert.ok("offers" in jsonLdOfType(resolvedPage, "WebPage")!.mainEntity);
  });
});

describe("#1103 every catalogue record whose stored terms are superseded", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  const bodies = new Map<string, string>();
  const population = supersededPagesRender();
  const withARecordedReading = () => population.filter(({ change }) => readingBehindTheChange(change));

  before(async () => {
    server = await startServer({});
    const queue = population.map(({ offer }) => `/vendor/${toSlug(offer.vendor)}`);
    let next = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        while (next < queue.length) {
          const pathname = queue[next++];
          bodies.set(pathname, await fetch(`http://localhost:${server!.port}${pathname}`).then((r) => r.text()));
        }
      }),
    );
  });

  after(() => { server?.proc.kill(); });

  it("renders a page for every one of them", () => {
    assert.strictEqual(bodies.size, population.length);
  });

  it("holds a dated, sourced reading for most of them, so the citations below have subjects", () => {
    assert.ok(
      withARecordedReading().length > population.length * 0.9,
      `only ${withARecordedReading().length} of ${population.length} superseding records carry a citable reading`,
    );
  });

  it("says why it withholds on the rest, where there is no reading to publish instead", () => {
    const silent = population
      .filter(({ change }) => !readingBehindTheChange(change))
      .filter(({ offer }) => withholdingSurfacesOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!).length === 0)
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(silent.slice(0, 20), []);
  });

  it("states the stored terms in no description block", () => {
    const stating = population.filter(({ offer }) =>
      unescaped(descriptionBlockOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!)).includes(offer.description),
    );
    assert.deepStrictEqual(stating.map(({ offer }) => offer.vendor), []);
  });

  it("states the stored terms in no structured answer and no structured description", () => {
    const stating: string[] = [];
    for (const { offer, change } of population) {
      const html = bodies.get(`/vendor/${toSlug(offer.vendor)}`)!;
      const opening = offer.description.slice(0, 60);
      const withoutWhatTheChangeItselfSays = (text: string) => text.split(change.summary).join(" ");
      const page = jsonLdOfType(html, "WebPage");
      if (page && String(page.mainEntity?.description ?? "").includes(opening)) stating.push(`${offer.vendor} :: mainEntity`);
      if (page && String(page.description ?? "").includes(opening)) stating.push(`${offer.vendor} :: WebPage`);
      for (const pair of faqAnswersOf(html)) {
        if (withoutWhatTheChangeItselfSays(pair.answer).includes(opening)) stating.push(`${offer.vendor} :: ${pair.question}`);
      }
    }
    assert.deepStrictEqual(stating, []);
  });

  it("offers a price of zero to none of them", () => {
    const offering = population.filter(({ offer }) =>
      "offers" in (jsonLdOfType(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!, "WebPage")?.mainEntity ?? {}),
    );
    assert.deepStrictEqual(offering.map(({ offer }) => offer.vendor), []);
  });

  it("names an upgrade threshold on none of them", () => {
    const telling = population
      .filter(({ offer }) => bodies.get(`/vendor/${toSlug(offer.vendor)}`)!.includes(`class="section growth-section"`))
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(telling.slice(0, 20), []);
  });

  it("says in the meta description of every one why the terms are withheld", () => {
    const silent = population
      .filter(({ offer }) => !metaDescriptionOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!).includes(STORED_TERMS_WITHHELD_META_PHRASE))
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(silent.slice(0, 20), []);
  });

  it("publishes the terms the record read, dated and linked to the page it read them from", () => {
    const missing: string[] = [];
    for (const { offer, change } of withARecordedReading()) {
      const reading = readingBehindTheChange(change)!;
      const html = bodies.get(`/vendor/${toSlug(offer.vendor)}`)!;
      const block = unescaped(descriptionBlockOf(html));
      if (!block.includes(reading.terms)) missing.push(`${offer.vendor} :: terms`);
      if (!block.includes(reading.date)) missing.push(`${offer.vendor} :: date`);
      if (!descriptionBlockOf(html).includes(`href="${escapedFor(reading.url)}"`)) missing.push(`${offer.vendor} :: link`);
      if (!block.includes(reading.label)) missing.push(`${offer.vendor} :: label`);
    }
    assert.deepStrictEqual(missing.slice(0, 20), []);
  });

  it("cites the page beside every sentence that withholds our stored terms", () => {
    const uncited: string[] = [];
    for (const { offer, change } of withARecordedReading()) {
      const reading = readingBehindTheChange(change)!;
      for (const [surface, text] of withholdingSurfacesOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!)) {
        if (!text.includes(reading.label)) uncited.push(`${offer.vendor} :: ${surface} :: no source`);
        if (!text.includes(reading.date)) uncited.push(`${offer.vendor} :: ${surface} :: no date`);
      }
    }
    assert.deepStrictEqual(uncited.slice(0, 20), []);
  });

  it("finds those sentences on every page, so the assertion above has subjects", () => {
    const bare = withARecordedReading()
      .filter(({ offer }) => withholdingSurfacesOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!).length < 4)
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(bare.slice(0, 20), []);
  });

  it("quotes an expression the vendor's page never rendered on none of them", () => {
    const leaking: string[] = [];
    for (const { offer, change } of population) {
      const html = bodies.get(`/vendor/${toSlug(offer.vendor)}`)!;
      const withoutWhatTheChangeItselfSays = (text: string) => text.split(change.summary).join(" ");
      for (const [surface, text] of withholdingSurfacesOf(html)) {
        const found = unrenderedExpressionIn(withoutWhatTheChangeItselfSays(text));
        if (found) leaking.push(`${offer.vendor} :: ${surface} :: ${found}`);
      }
    }
    assert.deepStrictEqual(leaking.slice(0, 20), []);
  });

  it("opens the meta description on what it read rather than on what it will not say", () => {
    const refusing = withARecordedReading()
      .filter(({ offer, change }) => {
        const meta = unescaped(metaDescriptionOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!));
        return !meta.includes(openingOfAReading(readingBehindTheChange(change)!.terms, 90));
      })
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(refusing.slice(0, 20), []);
  });

  const readingNamesAFreePlanLaterOn = () =>
    withARecordedReading().filter(({ change }) => {
      const terms = readingBehindTheChange(change)!.terms;
      return whereAFreePlanIsNamed(terms) > 0 && !mentionsSomethingFree(openingOfTerms(terms, 90));
    });

  it("names the free plan in the meta description wherever the reading names one the opening would miss", () => {
    const silent = readingNamesAFreePlanLaterOn()
      .filter(({ offer }) => !mentionsSomethingFree(unescaped(metaDescriptionOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!))))
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(silent.slice(0, 20), []);
  });

  it("finds readings that name one, so the assertion above has subjects", () => {
    assert.ok(readingNamesAFreePlanLaterOn().length >= 4, `${readingNamesAFreePlanLaterOn().length} readings name a free plan the opening would miss`);
  });

  it("leaves the opening alone wherever it already says something is free", () => {
    const moved: string[] = [];
    for (const { offer, change } of withARecordedReading()) {
      const terms = readingBehindTheChange(change)!.terms;
      const asBefore = openingOfTerms(terms, 90);
      if (!mentionsSomethingFree(asBefore)) continue;
      if (openingOfAReading(terms, 90) !== asBefore) moved.push(offer.vendor);
    }
    assert.deepStrictEqual(moved, []);
  });

  it("withholds our free-tier terms behind no reading that is only a trial", () => {
    const banners = population
      .filter(({ offer }) => tierRecordsAFreeTier(offer.tier ?? ""))
      .filter(({ change }) => {
        const reading = readingBehindTheChange(change);
        return reading !== null && describesOnlyATrial(reading.terms);
      })
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(banners.slice(0, 20), []);
  });
});
