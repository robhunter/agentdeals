import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, "..", "scripts");

const {
  fetchPageText,
  verifyOfferAgainstPage,
  readBodyWithin,
  pageTooLargeError,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_BYTES,
  VERIFIER_MODEL,
  VERIFIER_BASE_URL,
} = await import("../scripts/verify-freshness.js");
const { priceSignals } = await import("../scripts/change-gate.js");
const { classifySource, pageNamesVendor } = await import("../scripts/vendor-naming.js");

const nav = (vendor: string) => `${vendor} Docs Blog Careers Support Community Login Sign up `.repeat(300);

function pageStatingTermsAfterTheCut(vendor: string) {
  return `<html><body><nav>${nav(vendor)}</nav><main>${vendor} pricing. Free plan: $0 per month for up to 5 hosts.</main></body></html>`;
}

function pageStatingNoTermsAtAnyLength(vendor: string) {
  return `<html><body><nav>${nav(vendor)}</nav><main>${vendor} helps teams ship. Talk to our team about what you need.</main></body></html>`;
}

const SHORT_PAGE = `<html><body><p>Widgetson pricing. The free plan is $0 per month for up to 5 hosts, with 1-day retention.</p></body></html>`;

async function readWith(body: string, init: ResponseInit = {}, options = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, ...init })) as typeof fetch;
  try {
    return await fetchPageText("https://example.test/pricing", options);
  } finally {
    globalThis.fetch = original;
  }
}

const OFFER = {
  vendor: "Widgetson",
  category: "Monitoring",
  tier: "Free",
  description: "Free for up to 5 hosts",
  url: "https://example.test/pricing",
};

function outcomeFor(text: string) {
  const page = { ok: true, text };
  return classifySource(OFFER, page, priceSignals(text).length).outcome;
}

describe("a page is read to its end, not to a fixed number of characters", () => {
  it("returns every character of a page longer than the verifier's prompt limit", async () => {
    const page = await readWith(pageStatingTermsAfterTheCut(OFFER.vendor));
    assert.strictEqual(page.ok, true);
    assert.strictEqual(page.truncated, false);
    assert.ok(
      page.text.length > MAX_PAGE_TEXT_LENGTH,
      `the fixture must be longer than ${MAX_PAGE_TEXT_LENGTH} characters for this to mean anything, got ${page.text.length}`
    );
    assert.ok(page.text.includes("Free plan: $0 per month for up to 5 hosts"));
  });

  it("states the terms only past the character the reader used to stop at", async () => {
    const page = await readWith(pageStatingTermsAfterTheCut(OFFER.vendor));
    const at = page.text.indexOf("$0");
    assert.ok(
      at > MAX_PAGE_TEXT_LENGTH,
      `the fixture's first price signal must fall past the prompt limit, found at ${at}`
    );
  });

  it("names the vendor and reads its terms from the whole page", async () => {
    const page = await readWith(pageStatingTermsAfterTheCut(OFFER.vendor));
    assert.strictEqual(pageNamesVendor(page.text, OFFER.vendor, { url: OFFER.url }).named, true);
    assert.ok(priceSignals(page.text).length > 0);
    assert.strictEqual(outcomeFor(page.text), "ok");
  });

  it("would have called the same page one that states no terms, had it stopped at the limit", async () => {
    const page = await readWith(pageStatingTermsAfterTheCut(OFFER.vendor));
    assert.strictEqual(outcomeFor(page.text.slice(0, MAX_PAGE_TEXT_LENGTH)), "states_no_terms");
  });

  it("still finds no terms on a long page that states none", async () => {
    const page = await readWith(pageStatingNoTermsAtAnyLength(OFFER.vendor));
    assert.ok(page.text.length > MAX_PAGE_TEXT_LENGTH);
    assert.strictEqual(outcomeFor(page.text), "states_no_terms");
  });

  it("reads a short page whole, as it always did", async () => {
    const page = await readWith(SHORT_PAGE);
    assert.strictEqual(page.ok, true);
    assert.strictEqual(page.truncated, false);
    assert.strictEqual(outcomeFor(page.text), "ok");
  });
});

describe("the verifier prompt carries the limit, so the reader does not have to", () => {
  function promptCapturingClient() {
    const prompts: string[] = [];
    return {
      prompts,
      client: {
        model: VERIFIER_MODEL,
        baseUrl: VERIFIER_BASE_URL,
        complete: async (prompt: string) => {
          prompts.push(prompt);
          return '{"status":"confirmed"}';
        },
      },
    };
  }

  function pageTextIn(prompt: string) {
    const start = prompt.indexOf("CURRENT PRICING PAGE TEXT (truncated):\n");
    assert.ok(start !== -1, "the prompt must label the page text for this assertion to mean anything");
    const from = start + "CURRENT PRICING PAGE TEXT (truncated):\n".length;
    const end = prompt.indexOf("\n\nCompare the stored deal info", from);
    assert.ok(end !== -1, "the prompt must close the page text block");
    return prompt.slice(from, end);
  }

  it("sends no more page text than it ever did, however long the page is", async () => {
    const { prompts, client } = promptCapturingClient();
    const whole = `${"a".repeat(MAX_PAGE_TEXT_LENGTH)}TAIL`;
    await verifyOfferAgainstPage(client, OFFER, whole);
    const sent = pageTextIn(prompts[0]);
    assert.strictEqual(sent.length, MAX_PAGE_TEXT_LENGTH);
    assert.ok(!sent.includes("TAIL"));
  });

  it("sends a short page unchanged", async () => {
    const { prompts, client } = promptCapturingClient();
    await verifyOfferAgainstPage(client, OFFER, "Free plan: $0 per month.");
    assert.strictEqual(pageTextIn(prompts[0]), "Free plan: $0 per month.");
  });
});

describe("an unbounded read is refused rather than held", () => {
  it("refuses a body larger than the ceiling and names the size", async () => {
    const page = await readWith("x".repeat(5_000), {}, { maxBytes: 1_000 });
    assert.strictEqual(page.ok, false);
    assert.match(page.error, /^page too large: \d+ bytes$/);
  });

  it("refuses on a declared length without reading the body", async () => {
    const declared = MAX_PAGE_BYTES + 1;
    const page = await readWith(SHORT_PAGE, {
      headers: { "content-length": String(declared) },
    });
    assert.strictEqual(page.ok, false);
    assert.strictEqual(page.error, pageTooLargeError(declared));
  });

  it("accepts a body at the ceiling", async () => {
    const page = await readWith(SHORT_PAGE, {}, { maxBytes: Buffer.byteLength(SHORT_PAGE) });
    assert.strictEqual(page.ok, true);
  });

  it("counts bytes rather than characters", async () => {
    const body = `<html><body><p>Widgetson pricing — free plan ${"€".repeat(200)}</p></body></html>`;
    const chars = body.length;
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes > chars, "the fixture must be wider in bytes than in characters");
    const page = await readWith(body, {}, { maxBytes: chars });
    assert.strictEqual(page.ok, false);
  });

  it("sets a ceiling above every page in the index", () => {
    const LARGEST_PAGE_MEASURED = 4_764_715;
    assert.ok(
      MAX_PAGE_BYTES > LARGEST_PAGE_MEASURED * 2,
      `${MAX_PAGE_BYTES} leaves no room above the ${LARGEST_PAGE_MEASURED}-byte page we already read`
    );
  });

  describe("readBodyWithin", () => {
    it("returns the body when it fits", async () => {
      const result = await readBodyWithin(new Response("hello"), 100);
      assert.strictEqual(result.html, "hello");
      assert.strictEqual(result.tooLarge, undefined);
    });

    it("reports the size it stopped at", async () => {
      const result = await readBodyWithin(new Response("x".repeat(500)), 100);
      assert.strictEqual(result.tooLarge, true);
      assert.ok(result.bytes > 100);
    });
  });
});

describe("the character limit belongs to the verifier prompt alone", () => {
  const readers = ["change-gate.js", "vendor-naming.js", "reverify-rolling.js", "source-naming-audit.js"];

  for (const file of readers) {
    it(`${file} introduces no limit of its own`, () => {
      const source = readFileSync(path.join(SCRIPTS, file), "utf-8");
      assert.doesNotMatch(source, /MAX_PAGE_TEXT_LENGTH/);
    });
  }

  it("names the limit only where the prompt is built and where the old cut is measured", () => {
    const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".js"));
    const naming = files
      .filter((f) => readFileSync(path.join(SCRIPTS, f), "utf-8").includes("MAX_PAGE_TEXT_LENGTH"))
      .sort();
    assert.deepStrictEqual(naming, ["verify-freshness.js", "whole-page-census.js"]);
  });

  it("applies the limit inside the function that builds the prompt", () => {
    const source = readFileSync(path.join(SCRIPTS, "verify-freshness.js"), "utf-8");
    const from = source.indexOf("export async function verifyOfferAgainstPage");
    const to = source.indexOf("export function sleep", from) >= 0 ? source.indexOf("export function sleep", from) : source.length;
    assert.ok(from !== -1);
    assert.match(source.slice(from, to), /slice\(0,\s*MAX_PAGE_TEXT_LENGTH\)/);
  });

  it("does not apply it where the page is fetched", () => {
    const source = readFileSync(path.join(SCRIPTS, "verify-freshness.js"), "utf-8");
    const from = source.indexOf("export async function fetchPageText");
    const to = source.indexOf("export function createVerifierClient", from);
    assert.ok(from !== -1 && to > from);
    assert.doesNotMatch(source.slice(from, to), /MAX_PAGE_TEXT_LENGTH/);
  });
});
