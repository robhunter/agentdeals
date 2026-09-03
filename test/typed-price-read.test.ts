import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, "..", "scripts");

const {
  jsonLdBlocks,
  readStructuredPrices,
  structuredDetail,
  unrenderedPrices,
  priceLabel,
  NO_STRUCTURED_DATA,
} = await import("../scripts/structured-prices.js");
const { fetchPageText } = await import("../scripts/verify-freshness.js");
const { classifySource, sourceCheckRecord, READ_FROM_MARKUP } = await import("../scripts/vendor-naming.js");
const { priceSignals } = await import("../scripts/change-gate.js");
const { runUrlMode, summaryLines } = await import("../scripts/reverify-rolling.js");

const OFFER = {
  vendor: "Widgetson",
  category: "Monitoring",
  tier: "Free",
  description: "Free for up to 5 hosts",
  url: "https://widgetson.example/pricing",
};

const PROSE =
  "Widgetson pricing. Pick the plan that fits your team." +
  " Every plan includes alerting, dashboards and single sign-on.".repeat(12);

function page(body: string) {
  return `<html><head><title>Widgetson pricing</title></head><body><main>${body}</main></body></html>`;
}

function ldBlock(value: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

const LADDER = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Widgetson",
  offers: [
    { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
    { "@type": "Offer", name: "Pro", price: "20", priceCurrency: "USD" },
    { "@type": "Offer", name: "Ultra", price: "200", priceCurrency: "USD" },
  ],
};

const ONLY_TYPED_PRICES = page(`<p>${PROSE}</p>`) + ldBlock(LADDER);
const MALFORMED_LD =
  page(`<p>${PROSE} The Pro plan is $20 per month.</p>`) +
  `<script type="application/ld+json">{"@type":"Offer","price":</script>`;
const NO_LD = page(`<p>${PROSE}</p>`);

async function readWith(body: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  try {
    return await fetchPageText(OFFER.url);
  } finally {
    globalThis.fetch = original;
  }
}

function gradeOf(page: { ok: boolean; text?: string }) {
  return classifySource(OFFER, page, page.ok ? priceSignals(page.text ?? "") : []);
}

describe("prices published as schema.org markup", () => {
  it("collects every typed node under a product's offer list", () => {
    const { blocks, parsed, prices } = readStructuredPrices(ONLY_TYPED_PRICES);
    assert.strictEqual(blocks, 1);
    assert.strictEqual(parsed, 1);
    assert.deepStrictEqual(
      prices.map((p) => `${p.name} ${p.price}`),
      ["Free 0", "Pro 20", "Ultra 200"],
    );
    assert.deepStrictEqual([...new Set(prices.map((p) => p.currency))], ["USD"]);
  });

  it("reads the shapes vendors publish: a graph, a bare array, a range and a unit rate", () => {
    const graph = ldBlock({ "@context": "https://schema.org", "@graph": [LADDER] });
    assert.strictEqual(readStructuredPrices(graph).prices.length, 3);

    const array = ldBlock([{ "@type": "Offer", name: "Team", price: 40, priceCurrency: "USD" }]);
    assert.deepStrictEqual(readStructuredPrices(array).prices[0].price, "40");

    const range = ldBlock({ "@type": "AggregateOffer", lowPrice: "9.99", priceCurrency: "EUR" });
    assert.deepStrictEqual(readStructuredPrices(range).prices, [
      { type: "AggregateOffer", name: null, price: "9.99", currency: "EUR" },
    ]);

    const rate = ldBlock({
      "@type": ["UnitPriceSpecification", "Thing"],
      name: "Per seat",
      price: "8",
      priceCurrency: "GBP",
    });
    assert.strictEqual(readStructuredPrices(rate).prices[0].type, "UnitPriceSpecification");
  });

  it("names the plan from the item a nameless offer is for", () => {
    const nested = ldBlock({
      "@type": "Offer",
      price: "15",
      priceCurrency: "USD",
      itemOffered: { "@type": "Service", name: "Starter" },
    });
    assert.strictEqual(readStructuredPrices(nested).prices[0].name, "Starter");
  });

  it("counts a ladder published twice on the same page once", () => {
    const twice = ONLY_TYPED_PRICES + ldBlock(LADDER);
    assert.strictEqual(jsonLdBlocks(twice).length, 2);
    assert.strictEqual(readStructuredPrices(twice).prices.length, 3);
  });

  it("counts one price however many ways the page spells the same amount", () => {
    const spellings = ldBlock([
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
      { "@type": "Offer", name: "Free", price: "0.00", priceCurrency: "USD" },
      { "@type": "Offer", price: "0", priceCurrency: "USD" },
    ]);
    assert.deepStrictEqual(readStructuredPrices(spellings).prices, [
      { type: "Offer", name: "Free", price: "0", currency: "USD" },
    ]);
  });

  it("counts an offer and the unit rate nested inside it as one price", () => {
    const nested = ldBlock({
      "@type": "Offer",
      name: "Pro",
      price: "20",
      priceCurrency: "USD",
      priceSpecification: { "@type": "UnitPriceSpecification", price: "20", priceCurrency: "USD" },
    });
    assert.deepStrictEqual(readStructuredPrices(nested).prices, [
      { type: "Offer", name: "Pro", price: "20", currency: "USD" },
    ]);
  });

  it("keeps an unnamed price the page states at no other plan's amount", () => {
    const mixed = ldBlock([
      { "@type": "Offer", name: "Pro", price: "20", priceCurrency: "USD" },
      { "@type": "Offer", price: "40", priceCurrency: "USD" },
    ]);
    assert.deepStrictEqual(
      readStructuredPrices(mixed).prices.map((p) => `${p.name ?? "—"} ${p.price}`),
      ["Pro 20", "— 40"],
    );
  });

  it("ignores typed nodes that carry no price and values that are not figures", () => {
    const priceless = ldBlock({ "@type": "Offer", name: "Contact us", availability: "InStock" });
    assert.deepStrictEqual(readStructuredPrices(priceless).prices, []);

    const wordy = ldBlock({ "@type": "Offer", name: "Free", price: "Free" });
    assert.deepStrictEqual(readStructuredPrices(wordy).prices, []);

    const untyped = ldBlock({ "@type": "Product", name: "Widgetson", price: "20" });
    assert.deepStrictEqual(readStructuredPrices(untyped).prices, []);
  });
});

describe("reading a page whose prices are only in its markup", () => {
  it("does not grade a page that states a typed price as stating no terms", async () => {
    const read = await readWith(ONLY_TYPED_PRICES);
    assert.ok(read.ok);
    assert.strictEqual(priceSignals(read.text).length, 0);
    const grade = gradeOf(read);
    assert.strictEqual(grade.outcome, "ok");
    assert.strictEqual(grade.read, READ_FROM_MARKUP);
    assert.match(grade.detail, /3 typed prices/);
    assert.match(grade.detail, /Pro USD 20/);
  });

  it("grades the same page as stating no terms when its markup is not read", async () => {
    const read = await readWith(ONLY_TYPED_PRICES);
    assert.strictEqual(gradeOf({ ...read, structured: null }).outcome, "states_no_terms");
  });

  it("keeps a page that renders a figure graded on what it renders", async () => {
    const read = await readWith(page(`<p>${PROSE} The Pro plan is $20 per month.</p>`) + ldBlock(LADDER));
    const grade = gradeOf(read);
    assert.strictEqual(grade.outcome, "ok");
    assert.strictEqual(grade.read, undefined);
  });

  it("lifts a page whose only rendered signal names a plan without an amount", async () => {
    const read = await readWith(page(`<p>${PROSE} Free forever for small teams.</p>`) + ldBlock(LADDER));
    assert.ok(priceSignals(read.text).length > 0);
    assert.strictEqual(gradeOf({ ...read, structured: null }).outcome, "states_no_amount");
    const grade = gradeOf(read);
    assert.strictEqual(grade.outcome, "ok");
    assert.strictEqual(grade.read, READ_FROM_MARKUP);
  });
});

describe("a malformed block does not cost us the page", () => {
  it("reads the page and its rendered price when a block will not parse", async () => {
    const read = await readWith(MALFORMED_LD);
    assert.ok(read.ok);
    assert.strictEqual(read.structured.blocks, 1);
    assert.strictEqual(read.structured.parsed, 0);
    assert.deepStrictEqual(read.structured.prices, []);
    assert.strictEqual(gradeOf(read).outcome, "ok");
  });

  it("says whether the markup was absent, present without a price, or unparsed", async () => {
    const none = await readWith(NO_LD);
    assert.strictEqual(structuredDetail(none.structured), NO_STRUCTURED_DATA);
    assert.match(gradeOf(none).detail, /carries no structured data/);

    const priceless = await readWith(page(`<p>${PROSE}</p>`) + ldBlock({ "@type": "Organization", name: "Widgetson" }));
    assert.match(structuredDetail(priceless.structured) ?? "", /1 structured-data block .* state no price/);
    assert.match(gradeOf(priceless).detail, /state no price/);

    assert.strictEqual(structuredDetail(null), null);
  });

  it("leaves a page read without a markup pass described as it was", () => {
    const grade = classifySource(OFFER, { ok: true, text: `${OFFER.vendor} pricing. Talk to us.` }, []);
    assert.strictEqual(grade.outcome, "states_no_terms");
    assert.strictEqual(grade.detail, "the page names Widgetson but states no amount, tier or rate we can read");
  });
});

describe("a typed price is evidence, not a correction", () => {
  it("keeps the markup out of the text the verifier reads", async () => {
    const read = await readWith(ONLY_TYPED_PRICES);
    for (const figure of ["20", "200", "USD"]) {
      assert.ok(!read.text.includes(figure), `the verifier's page text carries ${figure} from the markup`);
    }
  });

  it("records the prices a page publishes but never renders", async () => {
    const read = await readWith(page(`<p>${PROSE} Pro is $20 per month.</p>`) + ldBlock(LADDER));
    assert.deepStrictEqual(unrenderedPrices(read.structured, read.text).map(priceLabel), ["Ultra USD 200"]);
    const record = sourceCheckRecord(OFFER, read, priceSignals(read.text), "2026-09-03");
    assert.deepStrictEqual(record.unrendered_prices, ["Ultra USD 200"]);
  });

  it("does not count a rendered price or a zero as unrendered", async () => {
    const read = await readWith(
      page(`<p>${PROSE} Free is $0, Pro is $20 per month and Ultra is $200 per month.</p>`) + ldBlock(LADDER),
    );
    assert.deepStrictEqual(unrenderedPrices(read.structured, read.text), []);
    assert.strictEqual(sourceCheckRecord(OFFER, read, priceSignals(read.text), "2026-09-03").unrendered_prices, undefined);
  });

  it("does not read a longer figure on the page as the price it contains", async () => {
    const read = await readWith(
      page(`<p>${PROSE} Pro is $20 per month and ingests 2000 events.</p>`) + ldBlock(LADDER),
    );
    assert.deepStrictEqual(unrenderedPrices(read.structured, read.text).map(priceLabel), ["Ultra USD 200"]);
  });
});

describe("every check that grades a page reads its markup", () => {
  const writers = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f) => ({ file: f, source: readFileSync(path.join(SCRIPTS, f), "utf-8") }))
    .filter(({ source }) => /\bsourceCheckRecord\b/.test(source) && !/export function sourceCheckRecord/.test(source));

  it("finds the scripts that write a source check, so the assertion below has subjects", () => {
    assert.ok(writers.length >= 4, `expected several scripts to write a source check, found ${writers.length}`);
  });

  for (const { file, source } of writers) {
    it(`${file} reads the page's markup before grading it`, () => {
      const readsMarkup =
        /from "\.\/structured-prices\.js"/.test(source) || /fetchPageText/.test(source);
      assert.ok(readsMarkup, `${file} grades a page without reading the prices in its markup`);
    });
  }
});

describe("the rolling re-verification carries the markup reading through", () => {
  const NOW = new Date("2026-09-03T00:00:00Z");
  const offer = { ...OFFER, verifiedDate: "2026-04-12" };

  it("writes the reading and the unrendered prices onto the record", async () => {
    const read = await readWith(page(`<p>${PROSE} Pro is $20 per month.</p>`) + ldBlock(LADDER));
    const data = { offers: [{ ...offer }] };
    const result = await runUrlMode([{ index: 0, offer }], data, false, NOW, {
      batchFn: async (batch: any[]) => ({ verified: batch.map((b) => ({ index: b.index })), flagged: [] }),
      fetchFn: async () => read,
    });
    const check = data.offers[0].source_check;
    assert.strictEqual(check.outcome, "ok");
    assert.deepStrictEqual(check.unrendered_prices, ["Ultra USD 200"]);
    assert.strictEqual(result.sourceChecks.get("unrendered_prices"), 1);
  });

  it("counts a record graded on its markup alone in the run summary", async () => {
    const read = await readWith(ONLY_TYPED_PRICES);
    const data = { offers: [{ ...offer }] };
    const result = await runUrlMode([{ index: 0, offer }], data, false, NOW, {
      batchFn: async (batch: any[]) => ({ verified: batch.map((b) => ({ index: b.index })), flagged: [] }),
      fetchFn: async () => read,
    });
    assert.strictEqual(data.offers[0].source_check.read, READ_FROM_MARKUP);
    const lines = summaryLines(result, {
      useAi: false,
      checked: 1,
      oldestRemaining: "2026-07-13",
      total: 1,
    });
    assert.ok(lines.some((l: string) => /states in its markup, not its text: 1$/.test(l)), lines.join("\n"));
  });
});
