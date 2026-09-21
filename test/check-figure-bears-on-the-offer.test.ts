import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOST_FIGURES_REPORTED,
  SOURCE_CHECK_OK,
  STATES_NO_FIGURE_WE_PUBLISH,
  classifySource,
  figuresWorthReporting,
  statesAnAmountOfZero,
} from "../scripts/vendor-naming.js";
import { figuresWeAlsoPublish, priceSignals } from "../scripts/change-gate.js";
import {
  detailWithoutFiguresWeDoNotPublish,
  reportedFigures,
} from "../scripts/withdraw-figures-we-do-not-publish.js";
import { assertPopulationFloor, assertSharesPopulation, recordsInTheCatalogue } from "./population-floor.ts";

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const offers: Offer[] = JSON.parse(
  readFileSync(path.join(__dirname, "..", "data", "index.json"), "utf-8"),
).offers;

function checkOf(offer: { vendor: string; url: string; description: string }, pageText: string) {
  return classifySource(offer, { ok: true, text: pageText }, priceSignals(pageText));
}

describe("the figure a source check reports bears on the offer", () => {
  it("reports the figure the record publishes rather than the first price on the page", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 1,000 events/mo and 3 projects",
      },
      "Hookline pricing. Team plans start at $29/mo. The free plan includes 1,000 events/mo.",
    );
    assert.strictEqual(check.outcome, SOURCE_CHECK_OK);
    assert.match(check.detail, /and states "1,000 events\/mo"/);
    assert.doesNotMatch(check.detail, /\$29/);
  });

  it("reports no figure at all where none of them is one we publish", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 5 GB storage",
      },
      "Hookline pricing. Plans start at $49/mo for teams that need more.",
    );
    assert.strictEqual(check.outcome, SOURCE_CHECK_OK);
    assert.doesNotMatch(check.detail, /and states "/);
    assert.ok(check.detail.endsWith(STATES_NO_FIGURE_WE_PUBLISH), check.detail);
  });

  it("reports the numeric signal the check passed on rather than a tier name with no figure in it", () => {
    const pageText = "Hookline pricing. Free plan for small teams. Includes 1,000 events/mo.";
    assert.strictEqual(priceSignals(pageText)[0], "Free plan");
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 1,000 events/mo",
      },
      pageText,
    );
    assert.match(check.detail, /and states "1,000 events\/mo"/);
    assert.doesNotMatch(check.detail, /"Free plan"/);
  });

  it("reports every figure the page states that we also publish", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 1,000 events/mo and 20 GB of bandwidth",
      },
      "Hookline pricing. Teams from $29/mo. Free: 1,000 events/mo and 20 GB / mo of bandwidth.",
    );
    assert.match(check.detail, /"1,000 events\/mo" and "20 GB \/ mo"/);
  });

  it("keeps a stated price of zero where the page states no other figure we publish", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 5 GB storage",
      },
      "Hookline pricing. Free $0 to start. Teams from $49/mo.",
    );
    assert.match(check.detail, /and states "\$0"/);
  });

  it("reports the first price of zero the page states, not the last", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 5 GB storage",
      },
      "Hookline pricing. Free is $0 a month. Enterprise is priced on application, with $ 0.00 up front.",
    );
    assert.match(check.detail, /and states "\$0"/);
    assert.doesNotMatch(check.detail, /0\.00/);
  });

  it("holds the reported figures to a sentence rather than a list of every match", () => {
    const ours = "Free plan includes 1 project, 2 seats, 3 builds, 4 monitors, 5 checks and 6 alerts";
    const page = "Free: 1 project / mo, 2 seats / mo, 3 builds / mo, 4 monitors / mo, 5 checks / mo, 6 alerts / mo.";
    const bearing = figuresWeAlsoPublish(priceSignals(page), ours);
    assert.ok(bearing.length > MOST_FIGURES_REPORTED, `only ${bearing.length} signals bear on those terms`);
    assert.strictEqual(figuresWorthReporting(priceSignals(page), ours).length, MOST_FIGURES_REPORTED);
  });

  it("does not read a currency amount as the allowance that carries the same number", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["$1,000"], "Free plan includes 1,000 events/mo"), []);
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["1,000 events/mo"], "Free plan includes 1,000 events/mo"),
      ["1,000 events/mo"],
    );
  });

  it("does not read a figure of a different size as the one we publish", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["2,000 events/mo"], "Free plan includes 1,000 events/mo"), []);
    assert.deepStrictEqual(figuresWeAlsoPublish(["5 GB / mo"], "Free plan includes 5 GB storage"), ["5 GB / mo"]);
  });

  it("prefers the allowance we publish over a price of zero the page also states", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 1M events / month",
      },
      "Hookline pricing. Free $0 to start. The free plan includes 1M events / month.",
    );
    assert.match(check.detail, /and states "1M events \/ month"/);
    assert.doesNotMatch(check.detail, /\$0/);
  });

  it("reports a figure the page states twice only once", () => {
    const ours = "Free plan includes 1,000 events/mo";
    const page = "Free: 1,000 events/mo. Still free at 1,000 events/mo after the trial.";
    assert.strictEqual(priceSignals(page).filter(signal => /1,000 events/.test(signal)).length, 2);
    assert.deepStrictEqual(figuresWeAlsoPublish(priceSignals(page), ours), ["1,000 events/mo"]);
  });
});

describe("the figures already stored are settled by the same rule", () => {
  it("withdraws a figure the record does not publish and keeps the naming clause", () => {
    assert.strictEqual(
      detailWithoutFiguresWeDoNotPublish(
        'the page names Render as "render" and states "$10"',
        "Free web services (512 MB RAM), 5 GB bandwidth/month",
      ),
      'the page names Render as "render"',
    );
  });

  it("leaves the clause that ends in a comma reading as a sentence", () => {
    assert.strictEqual(
      detailWithoutFiguresWeDoNotPublish(
        'the page writes "swagger", the domain we cite SwaggerHub from, and states "$21"',
        "Free plan includes 3 collaborators",
      ),
      'the page writes "swagger", the domain we cite SwaggerHub from',
    );
  });

  it("leaves a stored figure the record publishes exactly as it was", () => {
    const kept = 'the page names Hookline as "hookline" and states "1,000 events/mo"';
    assert.strictEqual(detailWithoutFiguresWeDoNotPublish(kept, "Free plan includes 1,000 events/mo"), kept);
  });

  it("reads back every figure the check itself wrote", () => {
    const check = checkOf(
      {
        vendor: "Hookline",
        url: "https://hookline.dev/pricing",
        description: "Free plan includes 1,000 events/mo and 20 GB of bandwidth",
      },
      "Hookline pricing. Teams from $29/mo. Free: 1,000 events/mo and 20 GB / mo of bandwidth.",
    );
    assert.deepStrictEqual(reportedFigures(check.detail)?.figures, ["1,000 events/mo", "20 GB / mo"]);
  });

  it("narrows a stored pair to the figure we publish", () => {
    assert.strictEqual(
      detailWithoutFiguresWeDoNotPublish(
        'the page names Hookline as "hookline" and states "$49" and "1,000 events/mo"',
        "Free plan includes 1,000 events/mo",
      ),
      'the page names Hookline as "hookline" and states "1,000 events/mo"',
    );
  });
});

const passing = offers.filter(offer => offer.source_check?.outcome === "ok");
const reporting = passing.filter(offer => reportedFigures(offer.source_check!.detail ?? "") !== null);

describe("no record we publish reports a figure its own terms do not state", () => {
  it("holds a population of passing checks large enough for the sweep to mean something", () => {
    assertSharesPopulation(passing.length, recordsInTheCatalogue(), 0.35, "records passing the source check");
  });

  it("reports, on every record that reports a figure, only figures the record itself publishes", () => {
    const unrelated: string[] = [];
    for (const offer of reporting) {
      const detail = offer.source_check!.detail ?? "";
      const figures = reportedFigures(detail)!.figures;
      const ours = new Set(figuresWeAlsoPublish(figures, offer.description));
      const strangers = figures.filter(figure => !ours.has(figure) && !statesAnAmountOfZero(figure));
      if (strangers.length > 0) unrelated.push(`${offer.vendor} — ${detail}`);
    }
    assert.deepStrictEqual(
      unrelated.slice(0, 10),
      [],
      `${unrelated.length} of ${reporting.length} records report a figure their own terms do not state`,
    );
  });

  it("is settled, so the same rule applied again moves nothing", () => {
    const moved = passing.filter(offer => {
      const detail = offer.source_check!.detail ?? "";
      return detailWithoutFiguresWeDoNotPublish(detail, offer.description) !== detail;
    });
    assert.deepStrictEqual(moved.map(offer => offer.vendor).slice(0, 10), []);
  });

  it("keeps reporting the figures that are ours, including amounts that are not zero", () => {
    const amounts = reporting.filter(offer =>
      reportedFigures(offer.source_check!.detail ?? "")!.figures.some(figure => !statesAnAmountOfZero(figure)),
    );
    assertPopulationFloor(reporting.length, 180, "records still reporting a figure the page states");
    assertPopulationFloor(amounts.length, 40, "records still reporting a figure that is not a stated zero");
  });

  it("leaves a record whose reported figure is one we publish exactly as it was", () => {
    const kept = reporting.filter(offer => {
      const figures = reportedFigures(offer.source_check!.detail ?? "")!.figures;
      return figures.length > 0 && figuresWeAlsoPublish(figures, offer.description).length === figures.length;
    });
    assertPopulationFloor(kept.length, 70, "records whose reported figure is a figure we publish");
  });
});
