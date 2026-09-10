import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  advisoryGroups,
  blockingGroups,
  formatMarkdown,
  loadMergeRegistry,
  normalizePricingUrl,
  sharedPageGroups,
} = await import("../scripts/lint-shared-pages.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const registry = loadMergeRegistry();

const named = (vendors: string[]) => vendors.slice().sort().join(", ");

function withoutAllowlistEntry(vendors: string[]) {
  return {
    ...registry,
    sharedPricingPages: registry.sharedPricingPages.filter(
      (entry: { vendors: string[] }) => named(entry.vendors) !== named(vendors),
    ),
  };
}

function withoutMerge(retired: string) {
  return {
    ...registry,
    merges: registry.merges.filter((m: { retired: string }) => m.retired !== retired),
  };
}

function catalogueHolding(vendors: string[]): Offer[] {
  return vendors.map(
    (vendor) => ({ vendor, category: "Databases", tier: "Free", url: "https://one-product.example/pricing" }) as Offer,
  );
}

describe("normalizePricingUrl", () => {
  it("reads one page through the spellings a record can use for it", () => {
    const forms = [
      "https://arize.com/pricing",
      "http://arize.com/pricing",
      "https://www.arize.com/pricing/",
      "https://Arize.com/pricing?ref=agentdeals",
      "https://arize.com/pricing#free",
    ];
    for (const form of forms) {
      assert.strictEqual(normalizePricingUrl(form), "arize.com/pricing", `${form} reads as a different page`);
    }
  });

  it("keeps distinct paths on one host apart", () => {
    assert.notStrictEqual(normalizePricingUrl("https://aws.amazon.com/s3/pricing"), normalizePricingUrl("https://aws.amazon.com/ec2/pricing"));
  });

  it("reads a missing url as no page rather than as the empty page", () => {
    assert.strictEqual(normalizePricingUrl(undefined), "");
    assert.strictEqual(normalizePricingUrl(null), "");
  });
});

describe("two records citing one pricing page in one category", () => {
  const pair = (over: Partial<Offer>[] = [{}, {}]): Offer[] =>
    [
      { vendor: "Arize AI", category: "AI / ML", tier: "Free", url: "https://arize.com/pricing" },
      { vendor: "Arize AX", category: "AI / ML", tier: "Free", url: "https://arize.com/pricing" },
    ].map((o, i) => ({ ...o, ...over[i] })) as Offer[];

  it("is reported", () => {
    const groups = sharedPageGroups(pair(), { withinCategory: true });
    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0].vendors, ["Arize AI", "Arize AX"]);
    assert.strictEqual(groups[0].url, "arize.com/pricing");
  });

  it("is not reported when a member cites a page that does not name it", () => {
    const groups = sharedPageGroups(pair([{ source_check: { checked: "2026-09-01", outcome: "does_not_name_vendor", detail: "text" } }, {}]), {
      withinCategory: true,
    });
    assert.deepStrictEqual(groups, []);
  });

  it("is not reported when one of the two is registered for merging", () => {
    const groups = sharedPageGroups(pair(), { withinCategory: true, retired: ["Arize AI"] });
    assert.deepStrictEqual(groups, []);
  });

  it("is not reported when the two records carry one name", () => {
    const groups = sharedPageGroups(pair([{ vendor: "PostHog" }, { vendor: "PostHog" }]), { withinCategory: true });
    assert.deepStrictEqual(groups, []);
  });

  it("is not reported when the pair is registered as a shared page", () => {
    const groups = sharedPageGroups(pair(), {
      withinCategory: true,
      allowlist: [{ vendors: ["Arize AI", "Arize AX"], reason: "under test" }],
    });
    assert.deepStrictEqual(groups, []);
  });

  it("is reported again when a third record joins a registered shared page", () => {
    const three = [...pair(), { vendor: "Arize Phoenix", category: "AI / ML", tier: "Free", url: "https://arize.com/pricing" } as Offer];
    const groups = sharedPageGroups(three, {
      withinCategory: true,
      allowlist: [{ vendors: ["Arize AI", "Arize AX"], reason: "under test" }],
    });
    assert.strictEqual(groups.length, 1, "a registered pair still covers the page after a third record joins it");
  });

  it("separates one page's categories, which the advisory rule joins", () => {
    const split = pair([{ category: "AI / ML" }, { category: "Monitoring" }]);
    assert.deepStrictEqual(sharedPageGroups(split, { withinCategory: true }), []);
    assert.strictEqual(sharedPageGroups(split, { withinCategory: false }).length, 1);
  });
});

describe("the catalogue as it stands", () => {
  it("reports no unreviewed group under the blocking rule", () => {
    const groups = blockingGroups(offers, registry);
    assert.deepStrictEqual(
      groups.map((g: { vendors: string[] }) => named(g.vendors)),
      [],
    );
  });

  it("reports no unreviewed group under the advisory rule", () => {
    const groups = advisoryGroups(offers, registry);
    assert.deepStrictEqual(
      groups.map((g: { vendors: string[] }) => named(g.vendors)),
      [],
    );
  });

  it("reports the group behind every registered shared page when that page is unregistered", () => {
    for (const entry of registry.sharedPricingPages) {
      const groups = advisoryGroups(offers, withoutAllowlistEntry(entry.vendors));
      assert.deepStrictEqual(
        groups.map((g: { vendors: string[] }) => named(g.vendors)),
        [named(entry.vendors)],
        `unregistering ${named(entry.vendors)} does not report it`,
      );
    }
  });

  it("holds one registered shared page that the blocking rule needs, and it is the two Google One products", () => {
    const loadBearing = registry.sharedPricingPages.filter(
      (entry: { vendors: string[] }) => blockingGroups(offers, withoutAllowlistEntry(entry.vendors)).length > 0,
    );
    assert.deepStrictEqual(
      loadBearing.map((entry: { vendors: string[] }) => named(entry.vendors)),
      ["Google Drive, Google Photos"],
    );
  });
});

describe("a catalogue holding both records of a registered merge", () => {
  it("is silent while the merge is registered and reports the pair when it is not", () => {
    for (const merge of registry.merges) {
      const catalogue = catalogueHolding([merge.retired, merge.survivor]);
      assert.deepStrictEqual(
        advisoryGroups(catalogue, registry).map((g: { vendors: string[] }) => named(g.vendors)),
        [],
        `the registered ${merge.retired} merge does not silence its own pair`,
      );
      assert.deepStrictEqual(
        advisoryGroups(catalogue, withoutMerge(merge.retired)).map((g: { vendors: string[] }) => named(g.vendors)),
        [named([merge.retired, merge.survivor])],
        `unregistering the ${merge.retired} merge does not report it`,
      );
    }
  });

  it("reports a pair no merge and no shared page names", () => {
    const catalogue = catalogueHolding(["Kept One", "Kept Two"]);
    assert.deepStrictEqual(
      advisoryGroups(catalogue, registry).map((g: { vendors: string[] }) => named(g.vendors)),
      ["Kept One, Kept Two"],
    );
  });
});

describe("the merge registry", () => {
  it("names a survivor the catalogue still carries", () => {
    const live = new Set(offers.map((o) => o.vendor.trim().toLowerCase()));
    for (const merge of registry.merges) {
      assert.ok(live.has(merge.survivor.trim().toLowerCase()), `${merge.survivor} survives a merge but is not in the catalogue`);
    }
  });

  it("retires no name that another merge keeps", () => {
    const retired = new Set(registry.merges.map((m: { retired: string }) => m.retired.trim().toLowerCase()));
    for (const merge of registry.merges) {
      assert.ok(!retired.has(merge.survivor.trim().toLowerCase()), `${merge.survivor} is both kept and retired`);
    }
  });

  it("pairs each retiring record with a survivor citing the same page", () => {
    const byName = new Map(offers.map((o) => [o.vendor.trim().toLowerCase(), o]));
    for (const merge of registry.merges) {
      const retiring = byName.get(merge.retired.trim().toLowerCase());
      if (!retiring) continue;
      const survivor = byName.get(merge.survivor.trim().toLowerCase())!;
      assert.strictEqual(
        normalizePricingUrl(retiring.url),
        normalizePricingUrl(survivor.url),
        `${merge.retired} and ${merge.survivor} do not cite one page, so a merge cannot silence them`,
      );
    }
  });

  it("registers no name as both a merge and a shared page", () => {
    const merged = new Set(registry.merges.flatMap((m: { retired: string; survivor: string }) => [m.retired, m.survivor].map((v) => v.trim().toLowerCase())));
    for (const entry of registry.sharedPricingPages) {
      for (const vendor of entry.vendors) {
        assert.ok(!merged.has(vendor.trim().toLowerCase()), `${vendor} is registered as both a shared page and a merge`);
      }
    }
  });

  it("gives every registered shared page a reason", () => {
    for (const entry of registry.sharedPricingPages) {
      assert.ok(entry.reason && entry.reason.length > 10, `${named(entry.vendors)} is registered without a reason`);
    }
  });
});

describe("the report the advisory check prints", () => {
  it("says so when nothing is unreviewed", () => {
    assert.match(formatMarkdown([]), /No unreviewed group of records shares a pricing page/);
  });

  it("names the page, every record on it, and where the judgement is recorded", () => {
    const out = formatMarkdown([
      {
        url: "arize.com/pricing",
        category: null,
        vendors: ["Arize AI", "Arize AX"],
        entries: [
          { vendor: "Arize AI", category: "AI / ML", tier: "Free" },
          { vendor: "Arize AX", category: "AI / ML", tier: "Free" },
        ],
      },
    ]);
    assert.match(out, /### arize\.com\/pricing/);
    assert.match(out, /- Arize AI — AI \/ ML — Free/);
    assert.match(out, /- Arize AX — AI \/ ML — Free/);
    assert.match(out, /data\/vendor_merges\.json/);
  });
});
