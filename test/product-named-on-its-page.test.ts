import { describe, it } from "node:test";
import assert from "node:assert";
import {
  hostRestatement,
  productHalf,
  pageNamesVendor,
  pageNamesOnlyTheHost,
  classifySource,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NOT_THE_PRODUCT,
  SOURCE_CHECK_OUTCOMES,
} from "../scripts/vendor-naming.js";
import { priceSignals } from "../scripts/change-gate.js";
import {
  LEVEL_WITHHOLDING_OUTCOMES,
  cannotVouchForLevel,
  levelWithheldReason,
  withheldLevelClause,
  withheldLevelSentence,
  unconfirmedTermsClause,
} from "../dist/source-check.js";
import { loadOffers } from "../dist/data.js";
import { openapiSpec } from "../dist/openapi.js";
import { assertPopulationFloor } from "./population-floor.ts";

const VERTEX_MODEL_REFERENCE = "https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference/overview";
const A_GOOGLE_PAGE_ABOUT_GEMINI =
  "Use the Model API for Gemini in Gemini Enterprise Agent Platform to create custom applications. " +
  "Google Cloud samples video at 10 frames per second. Gemini 3 Pro costs $2 per 1M input tokens.";

describe("a page that names the platform and not the product", () => {
  it("does not confirm a record whose name is the platform plus a product", () => {
    const result = pageNamesVendor(A_GOOGLE_PAGE_ABOUT_GEMINI, "Google GLM 5", { url: VERTEX_MODEL_REFERENCE });
    assert.strictEqual(result.named, false);
  });

  it("confirms the same record once the page writes the product", () => {
    const page = `${A_GOOGLE_PAGE_ABOUT_GEMINI} GLM 5 is available in preview.`;
    assert.strictEqual(pageNamesVendor(page, "Google GLM 5", { url: VERTEX_MODEL_REFERENCE }).named, true);
  });

  it("reads the product off a page that writes it without the platform", () => {
    const page = "ECR Public repositories include 50 GB per month of always-free storage.";
    assert.strictEqual(pageNamesVendor(page, "Amazon ECR Public", { url: "https://aws.amazon.com/ecr/pricing/" }).named, true);
  });

  it("separates it from a page belonging to another company", () => {
    const check = classifySource(
      { vendor: "Google GLM 5", url: VERTEX_MODEL_REFERENCE },
      { ok: true, text: A_GOOGLE_PAGE_ABOUT_GEMINI },
      priceSignals(A_GOOGLE_PAGE_ABOUT_GEMINI),
    );
    assert.strictEqual(check.outcome, SOURCE_CHECK_NOT_THE_PRODUCT);
    assert.notStrictEqual(check.outcome, SOURCE_CHECK_NOT_NAMED);
    assert.match(check.detail, /never names GLM 5/);
  });

  it("stays does_not_name_vendor where the page writes neither the platform nor the product", () => {
    const text = "Langit77 Pusat Situs Resmi Online Slot. Bonus $107.50 setiap hari.";
    const check = classifySource(
      { vendor: "Amazon ECR Public", url: "https://aws.amazon.com/ecr/pricing/" },
      { ok: true, text },
      priceSignals(text),
    );
    assert.strictEqual(check.outcome, SOURCE_CHECK_NOT_NAMED);
  });

  it("passes a page that states terms and writes the whole name", () => {
    const text = "Amazon ECR Public gives 50 GB per month of always-free storage.";
    const check = classifySource(
      { vendor: "Amazon ECR Public", url: "https://aws.amazon.com/ecr/pricing/" },
      { ok: true, text },
      priceSignals(text),
    );
    assert.strictEqual(check.outcome, SOURCE_CHECK_OK);
  });
});

describe("which names the rule reaches", () => {
  const cases: [string, string, boolean][] = [
    ["Google GLM 5", VERTEX_MODEL_REFERENCE, true],
    ["Amazon ECR Public", "https://aws.amazon.com/ecr/pricing/", true],
    ["Zoho Docs", "https://www.zoho.com/workdrive/pricing.html", true],
    ["Vercel", "https://vercel.com/pricing", false],
    ["zoom.us", "https://zoom.us/", false],
    ["Bolt.new", "https://bolt.new/pricing", false],
    ["Cloudflare KV", "https://developers.cloudflare.com/kv/platform/pricing/", false],
    ["Google Cloud Run", "https://cloud.google.com/run/pricing", false],
    ["Sevalla (formerly Kinsta)", "https://sevalla.com/static-site-hosting/", false],
    ["Cloudflare WARP", "https://one.one.one.one/", false],
    ["Google Gemini Code Assist", "https://codeassist.google", true],
    ["Google Antigravity", "https://antigravity.google", false],
    ["Val Town", "https://www.val.town/pricing", false],
  ];

  for (const [vendor, url, restated] of cases) {
    it(`${restated ? "reads" : "leaves alone"} ${vendor} cited from ${new URL(url).hostname}`, () => {
      assert.strictEqual(hostRestatement(vendor, url).tokens.length > 0, restated);
    });
  }

  it("reads a brand that is the suffix of the host as well as one that is not", () => {
    assert.deepStrictEqual(hostRestatement("Google Gemini Code Assist", "https://codeassist.google").tokens, ["google"]);
    assert.deepStrictEqual(hostRestatement("Google GLM 5", VERTEX_MODEL_REFERENCE).tokens, ["google"]);
  });

  it("asks for nothing more where the host says the whole name already", () => {
    for (const [vendor, url] of [
      ["Google Antigravity", "https://antigravity.google"],
      ["Val Town", "https://www.val.town/pricing"],
      ["Icon Horse", "https://icon.horse"],
    ] as [string, string][]) {
      assert.deepStrictEqual(hostRestatement(vendor, url), { tokens: [], labels: [], remainder: [] }, vendor);
    }
  });

  it("names the half of the record the page has to carry", () => {
    assert.strictEqual(productHalf("Google GLM 5", hostRestatement("Google GLM 5", VERTEX_MODEL_REFERENCE)), "GLM 5");
    assert.strictEqual(
      productHalf("Amazon ECR Public", hostRestatement("Amazon ECR Public", "https://aws.amazon.com/ecr/pricing/")),
      "ECR Public",
    );
  });
});

describe("deleting the host brand from a name does not change the verdict", () => {
  const offers = loadOffers();
  const exposed = offers
    .map((offer) => ({ offer, restated: hostRestatement(offer.vendor, offer.url) }))
    .filter(({ restated }) => restated.tokens.length > 0);

  it("reads a real population of records, not an empty one", () => {
    assertPopulationFloor(exposed.length, 100, "catalogue records whose name restates the host we cite them from");
  });

  it("accepts no form that a page could match without writing past the host brand", () => {
    let checked = 0;
    for (const { offer, restated } of exposed) {
      for (const form of pageNamesVendor("", offer.vendor, { url: offer.url }).forms) {
        const beyondTheHost = restated.tokens.reduce((written, token) => written.split(token).join(""), form.replace(/ /g, ""));
        checked++;
        assert.ok(
          beyondTheHost.length > 0,
          `${offer.vendor} can be confirmed by a page writing "${form}", which says no more than ${restated.tokens.join(" ")} (${offer.url})`,
        );
      }
    }
    assertPopulationFloor(checked, 200, "name forms checked for a token the cited host does not already say");
  });

  it("still confirms the whole name wherever the shortened name is confirmed", () => {
    for (const { offer, restated } of exposed) {
      const product = productHalf(offer.vendor, restated);
      for (const form of pageNamesVendor("", product, { url: offer.url }).forms) {
        const page = `Pricing and plans. ${form} from $0 per month.`;
        assert.strictEqual(
          pageNamesVendor(page, offer.vendor, { url: offer.url }).named,
          true,
          `${offer.vendor} is refused by a page writing "${form}", which confirms ${product} (${offer.url})`,
        );
      }
    }
  });

  it("refuses every record on a page that writes only the host brand", () => {
    for (const { offer, restated } of exposed) {
      const page = `Pricing and plans. ${restated.tokens.join(" ")} from $0 per month.`;
      assert.strictEqual(
        pageNamesVendor(page, offer.vendor, { url: offer.url }).named,
        false,
        `${offer.vendor} is confirmed by a page writing only ${restated.tokens.join(" ")} (${offer.url})`,
      );
      assert.strictEqual(pageNamesOnlyTheHost(page, offer.vendor, offer.url), true);
    }
  });
});

describe("what the catalogue publishes for a record whose product is unnamed", () => {
  const offers = loadOffers();
  const withheld = offers.filter((offer) => offer.source_check?.outcome === SOURCE_CHECK_NOT_THE_PRODUCT);

  it("carries records, so the rules below read something", () => {
    assert.ok(withheld.length > 0, "no record in the catalogue records the new outcome");
  });

  it("publishes no rating for any of them", () => {
    for (const offer of withheld) {
      assert.strictEqual(cannotVouchForLevel(offer, null), true, offer.vendor);
      assert.strictEqual(levelWithheldReason(offer, null), SOURCE_CHECK_NOT_THE_PRODUCT, offer.vendor);
    }
  });

  it("says why in a sentence a reader gets, not only in an API field", () => {
    const sentence = withheldLevelSentence(SOURCE_CHECK_NOT_THE_PRODUCT, "Zoho Docs");
    assert.match(sentence, /Zoho Docs/);
    assert.match(sentence, /platform/);
    assert.match(withheldLevelClause(SOURCE_CHECK_NOT_THE_PRODUCT), /platform/);
    assert.match(unconfirmedTermsClause(SOURCE_CHECK_NOT_THE_PRODUCT), /platform/);
  });

  it("keeps the records that name nobody at all on the older outcome", () => {
    const nobody = offers.filter((offer) => offer.source_check?.outcome === SOURCE_CHECK_NOT_NAMED);
    assertPopulationFloor(nobody.length, 75, "records whose cited page names no part of the vendor");
  });

  it("belongs to the vocabulary every side of the pipeline shares", () => {
    assert.ok(SOURCE_CHECK_OUTCOMES.includes(SOURCE_CHECK_NOT_THE_PRODUCT));
    assert.ok(LEVEL_WITHHOLDING_OUTCOMES.includes(SOURCE_CHECK_NOT_THE_PRODUCT));
    const documented = (openapiSpec as unknown as {
      components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
    }).components.schemas.SourceCheck.properties.outcome.enum!;
    assert.ok(documented.includes(SOURCE_CHECK_NOT_THE_PRODUCT));
  });
});
