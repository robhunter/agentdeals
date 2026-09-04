import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_CHECK_OUTCOMES,
  LEVEL_WITHHOLDING_OUTCOMES,
  cannotVouchForLevel,
  levelWithheldReason,
  sourceCheckNotice,
  sourceStatesNoAmount,
  amountUnstatedSentence,
} from "../dist/source-check.js";
import { openapiSpec } from "../dist/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");

const { priceSignals, numericPriceSignals } = await import("../scripts/change-gate.js");
const { classifySource, holdsVerifiedDate, statesAnAmount, SOURCE_CHECK_NO_AMOUNT } =
  await import("../scripts/vendor-naming.js");
const { structuredDetail, NO_STRUCTURED_DATA } = await import("../scripts/structured-prices.js");

const OFFER = {
  vendor: "Widgetson",
  category: "Object Storage",
  tier: "Free",
  description: "10 GB storage",
  url: "https://widgetson.example/pricing",
};

const nav = `${OFFER.vendor} Docs Blog Careers Support Community Login Sign up `.repeat(12);

function pageSaying(claim: string) {
  return { ok: true, text: `${nav} ${OFFER.vendor} pricing. ${claim} Talk to our team about what you need.` };
}

const ONLY_A_PLAN_BY_NAME = pageSaying("Free forever.");
const THE_QUANTITY_WE_PUBLISH = pageSaying(`${OFFER.description} free.`);
const THE_QUANTITY_AS_A_RATE = pageSaying(`${OFFER.description} per month free.`);
const NOTHING_PRICE_SHAPED = pageSaying("We help teams ship software they can operate.");

function gradeOf(page: { ok: boolean; text: string }) {
  return classifySource(OFFER, page, priceSignals(page.text)).outcome;
}

describe("a page that names a plan and a page that states an amount are different evidence", () => {
  it("grades a page whose only price evidence is a plan name apart from one stating the quantity", () => {
    assert.notStrictEqual(gradeOf(ONLY_A_PLAN_BY_NAME), gradeOf(THE_QUANTITY_WE_PUBLISH));
    assert.notStrictEqual(gradeOf(ONLY_A_PLAN_BY_NAME), gradeOf(THE_QUANTITY_AS_A_RATE));
  });

  it("confirms the record only from the page that states the amount as a rate", () => {
    assert.strictEqual(gradeOf(THE_QUANTITY_AS_A_RATE), "ok");
    assert.strictEqual(gradeOf(ONLY_A_PLAN_BY_NAME), SOURCE_CHECK_NO_AMOUNT);
  });

  it("reads the plan name as a price signal and the figure beside it as an amount", () => {
    assert.ok(priceSignals(ONLY_A_PLAN_BY_NAME.text).length > 0);
    assert.strictEqual(numericPriceSignals(ONLY_A_PLAN_BY_NAME.text).length, 0);
    assert.ok(numericPriceSignals(THE_QUANTITY_AS_A_RATE.text).length > 0);
  });

  it("reads a bare quantity with no period or currency beside it as no signal at all", () => {
    assert.deepStrictEqual(priceSignals(THE_QUANTITY_WE_PUBLISH.text), []);
    assert.strictEqual(gradeOf(THE_QUANTITY_WE_PUBLISH), "states_no_terms");
  });

  it("leaves a page with no price signal of any kind where it already was", () => {
    assert.strictEqual(priceSignals(NOTHING_PRICE_SHAPED.text).length, 0);
    assert.strictEqual(gradeOf(NOTHING_PRICE_SHAPED), "states_no_terms");
  });

  it("names the phrase that was the page's whole price evidence", () => {
    const graded = classifySource(OFFER, ONLY_A_PLAN_BY_NAME, priceSignals(ONLY_A_PLAN_BY_NAME.text));
    assert.match(graded.detail, /Free forever/);
    assert.match(graded.detail, /Widgetson/);
  });

  it("still reports a page that does not name the vendor as one about somebody else", () => {
    const strangerOffer = { ...OFFER, url: "https://dealmarket.example/offers" };
    const elsewhere = { ok: true, text: "Someothercorp pricing. Enterprise plan available." };
    assert.strictEqual(
      classifySource(strangerOffer, elsewhere, priceSignals(elsewhere.text)).outcome,
      "does_not_name_vendor"
    );
  });
});

describe("which price signals count as an amount", () => {
  const cases: Array<[string, boolean]> = [
    ["$20", true],
    ["500 GB per month", true],
    ["100 daily requests", true],
    ["1000 USD", true],
    ["Enterprise plan", false],
    ["Free forever", false],
    ["starts at", false],
    ["Team plan", false],
  ];

  for (const [signal, isAmount] of cases) {
    it(`${isAmount ? "counts" : "does not count"} "${signal}" as an amount`, () => {
      assert.strictEqual(statesAnAmount(signal), isAmount);
    });
  }

  it("splits every signal the matcher can produce into one side or the other", () => {
    const page = "Widgetson Free forever. Enterprise plan starts at $20 per month for 500 GB per month.";
    const all = priceSignals(page);
    const amounts = numericPriceSignals(page);
    assert.ok(all.length > amounts.length, "the fixture must carry both kinds for the split to mean anything");
    assert.deepStrictEqual(amounts, all.filter(statesAnAmount));
  });
});

describe("what the new grade does and does not change about a record", () => {
  const graded = {
    source_check: {
      checked: "2026-09-02",
      outcome: SOURCE_CHECK_NO_AMOUNT,
      detail: `the page names Widgetson and says "Free forever" but states no amount, rate or price we can read`,
    },
  };

  it("belongs to the vocabulary both sides of the pipeline share", () => {
    assert.ok(SOURCE_CHECK_OUTCOMES.includes(SOURCE_CHECK_NO_AMOUNT));
  });

  it("does not withhold the stability level, so no record joins the withholding population", () => {
    assert.strictEqual(LEVEL_WITHHOLDING_OUTCOMES.includes(SOURCE_CHECK_NO_AMOUNT), false);
    assert.strictEqual(cannotVouchForLevel(graded, null), false);
    assert.strictEqual(levelWithheldReason(graded, null), null);
  });

  it("still reports the check to a caller, unlike the grade that confirms the record", () => {
    assert.ok(sourceCheckNotice(graded));
    assert.strictEqual(sourceStatesNoAmount(graded), true);
    assert.strictEqual(sourceStatesNoAmount({ source_check: { checked: "2026-09-02", outcome: "ok", detail: "text" } }), false);
  });

  it("says where the quantities came from instead", () => {
    const sentence = amountUnstatedSentence("Widgetson");
    assert.match(sentence, /Widgetson/);
    assert.match(sentence, /our own record/);
  });

  it("keeps the verified date moving, unlike the three grades that cannot confirm anything", () => {
    assert.strictEqual(holdsVerifiedDate(SOURCE_CHECK_NO_AMOUNT), false);
    assert.strictEqual(holdsVerifiedDate("ok"), false);
    for (const outcome of ["does_not_name_vendor", "states_no_terms", "unreadable"]) {
      assert.strictEqual(holdsVerifiedDate(outcome), true, `${outcome} must hold the verified date`);
    }
  });

  it("holds the verified date for exactly the grades that withhold a level", () => {
    assert.deepStrictEqual(
      SOURCE_CHECK_OUTCOMES.filter(holdsVerifiedDate).sort(),
      [...LEVEL_WITHHOLDING_OUTCOMES].sort()
    );
  });
});

describe("what an agent reading the API is told about the grade", () => {
  const spec = openapiSpec as unknown as {
    components: { schemas: Record<string, { properties?: Record<string, { enum?: string[]; description?: string; $ref?: string }> }> };
    paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: { properties?: Record<string, unknown> } }> }> } }>;
  };

  it("documents every outcome the writer can write, and no others", () => {
    const documented = spec.components.schemas.SourceCheck.properties!.outcome.enum!;
    assert.deepStrictEqual([...documented].sort(), [...SOURCE_CHECK_OUTCOMES].sort());
  });

  it("says what each outcome means in terms of what was found on the page", () => {
    const described = spec.components.schemas.SourceCheck.properties!.outcome.description!;
    for (const outcome of SOURCE_CHECK_OUTCOMES) {
      assert.ok(described.includes(`${outcome} —`), `${outcome} is offered as a value but never explained`);
    }
  });

  it("carries the check on the record the search endpoints return", () => {
    assert.strictEqual(
      spec.components.schemas.Offer.properties!.source_check.$ref,
      "#/components/schemas/SourceCheck"
    );
  });

  it("carries the check on the endpoint that rates a vendor", () => {
    const risk = spec.paths["/api/vendor-risk/{vendor}"].get.responses["200"].content["application/json"].schema;
    assert.deepStrictEqual(
      (risk.properties as Record<string, { $ref?: string }>).source_check,
      { $ref: "#/components/schemas/SourceCheck" }
    );
  });
});

describe("the catalog after the grade was applied", () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as {
    offers: Array<{ vendor: string; source_check?: { outcome: string; detail: string } }>;
  };
  const graded = index.offers.filter((o) => o.source_check?.outcome === SOURCE_CHECK_NO_AMOUNT);

  it("holds records at the new grade, so the surfaces above are reachable from real data", () => {
    assert.ok(graded.length > 0);
  });

  it("quotes the page's own words in every one of their details", () => {
    for (const offer of graded) {
      assert.match(
        offer.source_check!.detail,
        /^the page names .+ and says ".+" but states no amount, rate or price we can read(, and .+)?$/,
        `${offer.vendor} carries a detail the grade did not write`
      );
    }
  });

  it("closes a markup clause with the phrase the writer composes, not one an older shape allowed", () => {
    const clauses = graded
      .map((o) => ({
        vendor: o.vendor,
        clause: o.source_check!.detail.match(/ but states no amount, rate or price we can read, and (.+)$/)?.[1],
      }))
      .filter((c): c is { vendor: string; clause: string } => Boolean(c.clause));
    assert.ok(clauses.length > 0, "no graded record carries a markup clause, so this assertion has no subject");

    for (const { vendor, clause } of clauses) {
      if (clause === NO_STRUCTURED_DATA) continue;
      const blocks = Number(clause.match(/^the (\d+) structured-data blocks? in its markup states? no price$/)?.[1]);
      if (Number.isInteger(blocks)) {
        assert.strictEqual(
          clause,
          structuredDetail({ blocks, parsed: blocks, prices: [] }),
          `${vendor} carries a clause the writer would compose differently`
        );
        continue;
      }
      assert.match(
        clause,
        /^its markup states \d+ typed prices? \(.+\)$/,
        `${vendor} carries a clause structuredDetail does not compose: ${clause}`
      );
    }
  });
});
