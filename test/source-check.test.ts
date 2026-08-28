import { describe, it } from "node:test";
import assert from "node:assert";
import {
  SOURCE_CHECK_OUTCOMES,
  sourceDoesNotNameVendor,
  cannotVouchForLevel,
  sourceCheckNotice,
} from "../dist/source-check.js";
import { enrichOffers, loadOffers, checkVendorRisk } from "../dist/data.js";

const { SOURCE_CHECK_OUTCOMES: WRITTEN_OUTCOMES } = await import("../scripts/vendor-naming.js");

const CITED_PAGE_NAMES_SOMEBODY_ELSE = {
  checked: "2026-08-28",
  outcome: "does_not_name_vendor",
  detail: "the page never names Cloudways and is not served from its domain",
};

describe("an offer whose cited page cannot verify it", () => {
  it("uses the same outcome vocabulary as the job that writes it", () => {
    assert.deepStrictEqual([...SOURCE_CHECK_OUTCOMES].sort(), [...WRITTEN_OUTCOMES].sort());
  });

  it("withholds a favourable risk level rather than publishing one", () => {
    assert.strictEqual(cannotVouchForLevel({ source_check: CITED_PAGE_NAMES_SOMEBODY_ELSE }, null), true);
    assert.strictEqual(cannotVouchForLevel({}, null), false);
  });

  it("does not withhold on an outcome that only says the page was thin", () => {
    const thin = { checked: "2026-08-28", outcome: "states_no_terms", detail: "no amount, tier or rate" };
    assert.strictEqual(sourceDoesNotNameVendor({ source_check: thin }), false);
    assert.strictEqual(cannotVouchForLevel({ source_check: thin }, null), false);
    assert.ok(sourceCheckNotice({ source_check: thin }));
  });

  it("reports nothing to a caller when the page checked out", () => {
    assert.strictEqual(sourceCheckNotice({ source_check: { checked: "2026-08-28", outcome: "ok", detail: "text" } }), null);
  });
});

describe("what the enriched record publishes for an unverifiable source", () => {
  const base = {
    vendor: "Examplebase",
    category: "Databases",
    tier: "Free",
    description: "500 MB storage",
    url: "https://dealmarket.example/offers",
    tags: [],
    verifiedDate: "2026-08-01",
  };

  it("renders no risk level where a page about other companies is the only source", () => {
    const [withCheck, withoutCheck] = enrichOffers([
      { ...base, source_check: CITED_PAGE_NAMES_SOMEBODY_ELSE },
      { ...base, vendor: "Otherbase" },
    ]);
    assert.strictEqual(withoutCheck.risk_level, "stable");
    assert.strictEqual(withCheck.risk_level, null);
  });

  it("says so in the risk summary instead of claiming a stable history", () => {
    const offers = loadOffers() as any[];
    const withheld = enrichOffers(offers).filter(
      (o: any) => o.source_check?.outcome === "does_not_name_vendor" && o.risk_level === null
    );
    if (withheld.length === 0) {
      assert.ok(true, "no record in the index has a stable level withheld for its source");
      return;
    }
    for (const offer of withheld.slice(0, 5)) {
      const { result } = checkVendorRisk(offer.vendor) as any;
      assert.strictEqual(result.risk_level, null, `${offer.vendor} still publishes a level`);
      assert.doesNotMatch(result.summary, /has a stable pricing history/);
    }
  });
});

describe("two offers may not share a source that states only one of their terms", () => {
  it("holds every record whose source does not name it back from a stable badge", () => {
    const offers = loadOffers() as any[];
    const unnamed = offers.filter((o) => o.source_check?.outcome === "does_not_name_vendor");
    const enriched = enrichOffers(offers) as any[];
    const byKey = new Map(enriched.map((o) => [`${o.vendor}|${o.url}`, o]));
    for (const offer of unnamed) {
      assert.notStrictEqual(
        byKey.get(`${offer.vendor}|${offer.url}`).risk_level,
        "stable",
        `${offer.vendor} is badged stable from a page that does not name it`
      );
    }
  });

  it("records a verdict for every URL more than one offer cites", () => {
    const shared = sharedUrlGroups().flat();
    const unchecked = shared.filter((o) => !o.source_check);
    assert.deepStrictEqual(
      unchecked.map((o) => `${o.vendor} (${o.url})`),
      [],
      "a URL cited by more than one offer must carry a source verdict for each of them"
    );
  });

  const SHARED_SOURCES_THAT_NAME_NOBODY = [
    "https://brex.com/rewards/",
    "https://www.joinsecret.com/offers",
  ];

  it("adds no new shared source that fails to name the offers it carries", () => {
    const failing = sharedUrlGroups()
      .filter((group) => group.some((o) => o.source_check?.outcome === "does_not_name_vendor"))
      .map((group) => group[0].url)
      .sort();
    assert.deepStrictEqual(failing, SHARED_SOURCES_THAT_NAME_NOBODY);
  });
});

function sharedUrlGroups(): any[][] {
  const byUrl = new Map<string, any[]>();
  for (const offer of loadOffers() as any[]) {
    if (!byUrl.has(offer.url)) byUrl.set(offer.url, []);
    byUrl.get(offer.url)!.push(offer);
  }
  return [...byUrl.values()].filter((group) => group.length > 1);
}
