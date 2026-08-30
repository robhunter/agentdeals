import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

interface CatalogueOffer {
  vendor: string;
  description: string;
  url: string;
}

const FROZEN_AT_PUBLICATION =
  /^(index|blog|news|press|announcement|announcements|post|posts|update|updates|release|releases|story|stories|article|articles|changelog)$/i;

const SOURCES_STILL_FROZEN_AT_PUBLICATION = new Set([
  "https://www.userlike.com/en/blog/startup-deals",
]);

function datedPostSegment(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    if (FROZEN_AT_PUBLICATION.test(segments[i])) return segments[i];
  }
  return null;
}

function unbaselinedFrozenSources(list: CatalogueOffer[]): string[] {
  return list
    .filter((o) => datedPostSegment(o.url) !== null)
    .filter((o) => !SOURCES_STILL_FROZEN_AT_PUBLICATION.has(o.url))
    .map((o) => `${o.vendor} -> ${o.url}`);
}

const offers: CatalogueOffer[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf8"),
).offers;

function offerFor(vendor: string): CatalogueOffer {
  const offer = offers.find((o) => o.vendor === vendor);
  assert.ok(offer, `${vendor} is no longer in the catalogue`);
  return offer;
}

describe("a page frozen at publication cannot report a price set after it", () => {
  it("reads the post out of the path vendors publish posts under", () => {
    assert.strictEqual(
      datedPostSegment("https://openai.com/index/codex-flexible-pricing-for-teams/"),
      "index",
    );
    assert.strictEqual(datedPostSegment("https://vendor.example/blog/we-cut-our-prices"), "blog");
    assert.strictEqual(datedPostSegment("https://vendor.example/en/news/2026/free-tier"), "news");
    assert.strictEqual(datedPostSegment("https://vendor.example/changelog/v4"), "changelog");
  });

  it("leaves a page that is rewritten when the price changes", () => {
    assert.strictEqual(datedPostSegment("https://developers.openai.com/codex/pricing/"), null);
    assert.strictEqual(datedPostSegment("https://vendor.example/pricing"), null);
    assert.strictEqual(datedPostSegment("https://vendor.example/plans/team"), null);
  });

  it("does not read a listing page as one of its own entries", () => {
    assert.strictEqual(datedPostSegment("https://vendor.example/blog"), null);
    assert.strictEqual(datedPostSegment("https://vendor.example/blog/"), null);
  });

  it("survives a url the catalogue cannot parse", () => {
    assert.strictEqual(datedPostSegment("not a url"), null);
  });

  it("adds no record verified against a page that can never move", () => {
    assert.deepStrictEqual(unbaselinedFrozenSources(offers), []);
  });

  it("would report one that was added, which is the only reason the line above means anything", () => {
    const added = {
      vendor: "Examplecorp",
      description: "A record whose cited page is a post.",
      url: "https://examplecorp.example/blog/we-changed-our-pricing",
    };
    assert.deepStrictEqual(unbaselinedFrozenSources([...offers, added]), [
      "Examplecorp -> https://examplecorp.example/blog/we-changed-our-pricing",
    ]);
  });

  it("carries a baseline every entry of which the catalogue still contains and still cites", () => {
    for (const url of SOURCES_STILL_FROZEN_AT_PUBLICATION) {
      assert.ok(
        offers.some((o) => o.url === url),
        `${url} is baselined but no record cites it, so the baseline should lose it`,
      );
      assert.ok(datedPostSegment(url), `${url} is baselined but is not a post`);
    }
  });

  it("no longer verifies OpenAI Codex against one", () => {
    assert.strictEqual(datedPostSegment(offerFor("OpenAI Codex").url), null);
  });
});

describe("what the OpenAI Codex record tells a team pricing a coding agent", () => {
  const description = offerFor("OpenAI Codex").description;

  it("names both ChatGPT Business seat types, each with a per-user price", () => {
    assert.match(description, /Standard at \$\d+(\.\d+)?\/user\/mo/);
    assert.match(description, /Premium at \$\d+(\.\d+)?\/user\/mo/);
  });

  it("says what the more expensive seat buys, which is why anyone would pay it", () => {
    assert.match(description, /Premium buys \d+x more usage than Standard/);
    assert.match(description, /removes the five-hour usage limit/);
  });

  it("holds subscription access and token billing open at the same time", () => {
    assert.match(description, /subscription/i);
    assert.match(description, /billed on token use/i);
    assert.doesNotMatch(description, /switched to pay-as-you-go/i);
  });

  it("does not offer a team a Business route that closed to new workspaces", () => {
    assert.doesNotMatch(description, /Teams can add Codex-only seats/i);
  });
});
