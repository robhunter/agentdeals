import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECLARED_FIGURE_READS, FRONTIER_PRICES_READ_ON, HETZNER_PLAN_TABLE_READ_ON,
  READ_DATES_THAT_ARE_NOT_FIGURE_READS, STORAGE_RATE_CARD_READ_ON, TABLE_STALENESS_DISCLOSURES,
  declaredFigureReadsFor, factsOutdatedBy, newestChangeBySlug, parsePageReviews, referenceDateFor,
  reviewStatus, staleFactPages, utcToday,
  type DeclaredFigureRead, type PageReviewRecord,
} from "../src/page-reviews.ts";
import { toSlug, vendorSlugMap } from "../dist/vendor-slug.js";
import { HETZNER_PRICES_READ } from "../dist/hetzner-pricing.js";
import { STORAGE_RATES_READ } from "../dist/storage-cost-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const REGISTRY = parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));
const CHANGES = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes as Array<{ vendor?: string; date?: string }>;

const TODAY = utcToday();
const CHANGE_DATE = newestChangeBySlug(CHANGES, TODAY, toSlug);
const changeDateFor = (slug: string) => CHANGE_DATE.get(slug) ?? null;

function statusFor(pagePath: string) {
  const record = REGISTRY.pages.find(p => p.path === pagePath);
  assert.ok(record, `${pagePath} is not in the page register this measurement is taken over`);
  return reviewStatus(record as PageReviewRecord, TODAY);
}

function flagsOn(pagePath: string, reads: readonly DeclaredFigureRead[] = DECLARED_FIGURE_READS) {
  return factsOutdatedBy(statusFor(pagePath), changeDateFor, reads);
}

function tableFlagSlugs(pagePath: string, reads: readonly DeclaredFigureRead[] = DECLARED_FIGURE_READS) {
  return flagsOn(pagePath, reads).filter(f => f.surface === "table").map(f => f.slug).sort();
}

describe("a declared figure read dates the cell it covers", () => {
  const page = { path: "/p", clock_starts: "2026-04-03" };
  const reads: DeclaredFigureRead[] = [
    { path: "/p", read_on: "2026-09-04", vendors: ["hetzner"], cited_from: "example.test", covers: "section 1" },
  ];

  it("takes the declared read for a vendor the read names", () => {
    assert.deepStrictEqual(referenceDateFor(page, { slug: "hetzner", surface: "table" }, reads), {
      date: "2026-09-04",
      source: "figures_read",
    });
  });

  it("takes the page clock for a vendor on the same page the read does not name", () => {
    assert.deepStrictEqual(referenceDateFor(page, { slug: "render", surface: "table" }, reads), {
      date: "2026-04-03",
      source: "page_clock",
    });
  });

  it("takes the page clock for a vendor the read names on a different page", () => {
    assert.deepStrictEqual(referenceDateFor({ path: "/other", clock_starts: "2026-04-03" }, { slug: "hetzner", surface: "table" }, reads), {
      date: "2026-04-03",
      source: "page_clock",
    });
  });

  it("leaves a verdict on the page clock, because reading a price does not restate a verdict", () => {
    assert.deepStrictEqual(referenceDateFor(page, { slug: "hetzner", surface: "verdict" }, reads), {
      date: "2026-04-03",
      source: "page_clock",
    });
  });

  it("never dates a cell earlier than the page clock", () => {
    const older: DeclaredFigureRead[] = [{ ...reads[0]!, read_on: "2026-01-01" }];
    assert.deepStrictEqual(referenceDateFor(page, { slug: "hetzner", surface: "table" }, older), {
      date: "2026-04-03",
      source: "page_clock",
    });
  });

  it("takes the newest of two declared reads covering the same cell", () => {
    const both: DeclaredFigureRead[] = [
      reads[0]!,
      { ...reads[0]!, read_on: "2026-09-10", covers: "section 6" },
    ];
    assert.strictEqual(referenceDateFor(page, { slug: "hetzner", surface: "table" }, both).date, "2026-09-10");
  });
});

function constructedStatus(over: Partial<PageReviewRecord> = {}) {
  return reviewStatus({
    path: "/p",
    published: "2026-04-03",
    tier: "A",
    vendors_asserted: [],
    vendors_tabulated: [],
    badge_subjects_unresolved: [],
    stat_card_subjects_unresolved: [],
    reviewed_at: null,
    reviewer: null,
    review_outcome: null,
    review_note: null,
    reads_index: false,
    tables_read_index: false,
    table_figures: 0,
    table_figures_from_records: 0,
    tables: [],
    reads_changes: false,
    data_source: "unsourced",
    data_source_reason: null,
    ...over,
  }, "2026-09-20");
}

const A_READ_AFTER_THE_PAGE_WAS_PUBLISHED: DeclaredFigureRead[] = [
  { path: "/p", read_on: "2026-06-01", vendors: ["hetzner"], cited_from: "example.test", covers: "section 1" },
];

describe("a flag left standing by a declared read names that read as its reference date", () => {
  it("carries the read date and the read as its source", () => {
    const status = constructedStatus({ vendors_tabulated: ["hetzner"] });
    assert.deepStrictEqual(factsOutdatedBy(status, () => "2026-07-01", A_READ_AFTER_THE_PAGE_WAS_PUBLISHED), [
      {
        slug: "hetzner",
        changed: "2026-07-01",
        surface: "table",
        compared_against: "2026-06-01",
        compared_against_source: "figures_read",
      },
    ]);
  });

  it("reports no flag at all where the record predates the read", () => {
    const status = constructedStatus({ vendors_tabulated: ["hetzner"] });
    assert.deepStrictEqual(factsOutdatedBy(status, () => "2026-05-01", A_READ_AFTER_THE_PAGE_WAS_PUBLISHED), []);
    assert.strictEqual(factsOutdatedBy(status, () => "2026-05-01", []).length, 1);
  });

  it("measures a second vendor on the same page from the page clock in the same call", () => {
    const status = constructedStatus({ vendors_tabulated: ["hetzner", "render"] });
    const flags = factsOutdatedBy(status, () => "2026-07-01", A_READ_AFTER_THE_PAGE_WAS_PUBLISHED);
    assert.deepStrictEqual(
      flags.map(f => [f.slug, f.compared_against, f.compared_against_source]),
      [["hetzner", "2026-06-01", "figures_read"], ["render", "2026-04-03", "page_clock"]],
    );
  });
});

describe("a fact names the date it was measured against and where that date came from", () => {
  it("carries the page clock on a flag no declared read reaches", () => {
    const flag = flagsOn("/hetzner-pricing-2026").find(f => f.slug === "render");
    assert.ok(flag, "render is no longer flagged on /hetzner-pricing-2026");
    assert.strictEqual(flag!.compared_against_source, "page_clock");
    assert.strictEqual(flag!.compared_against, statusFor("/hetzner-pricing-2026").clock_starts);
  });

  it("every flag on every page names a reference date the registry can account for", () => {
    for (const record of REGISTRY.pages) {
      const status = reviewStatus(record, TODAY);
      for (const flag of factsOutdatedBy(status, changeDateFor)) {
        assert.match(flag.compared_against, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(["page_clock", "figures_read"].includes(flag.compared_against_source));
        assert.ok(flag.compared_against >= status.clock_starts, `${record.path} measured ${flag.slug} from before its own clock`);
        assert.ok(flag.changed > flag.compared_against, `${record.path} flags ${flag.slug} on a record no newer than the date it was measured against`);
      }
    }
  });
});

describe("the hetzner plan table is dated by the read that produced it", () => {
  const PAGE = "/hetzner-pricing-2026";

  it("flags the vendor its plan table states a read for only where the record is newer than the read", () => {
    const declared = declaredFigureReadsFor(PAGE).find(read => read.vendors.includes("hetzner"));
    assert.ok(declared);
    const moved = changeDateFor("hetzner");
    assert.ok(moved, "the change log holds nothing for hetzner");
    assert.strictEqual(tableFlagSlugs(PAGE).includes("hetzner"), moved! > declared!.read_on);
    assert.ok(tableFlagSlugs(PAGE, []).includes("hetzner"));
  });

  it("moves no flag on the page except one a declared read names", () => {
    const named = new Set(declaredFigureReadsFor(PAGE).flatMap(read => read.vendors));
    const before = tableFlagSlugs(PAGE, []);
    const after = tableFlagSlugs(PAGE);
    assert.deepStrictEqual(after.filter(slug => !before.includes(slug)), []);
    assert.deepStrictEqual(
      before.filter(slug => !after.includes(slug) && !named.has(slug)),
      [],
    );
  });

  it("keeps the four rows the section-one read does not cover", () => {
    const declared = declaredFigureReadsFor(PAGE);
    assert.strictEqual(declared.length, 1);
    const uncovered = tableFlagSlugs(PAGE, []).filter(slug => !declared[0]!.vendors.includes(slug));
    assert.ok(uncovered.length >= 4);
    for (const slug of uncovered) assert.ok(tableFlagSlugs(PAGE).includes(slug));
  });
});

describe("a page whose dates are source checks keeps every flag", () => {
  const PAGE = "/monitoring-comparison-2026";

  it("declares no figure read", () => {
    assert.deepStrictEqual(declaredFigureReadsFor(PAGE), []);
  });

  it("reports the same table flags with and without the registry", () => {
    assert.deepStrictEqual(tableFlagSlugs(PAGE), tableFlagSlugs(PAGE, []));
  });

  it("names the sentence shape it is not read from", () => {
    const named = READ_DATES_THAT_ARE_NOT_FIGURE_READS.map(entry => entry.rendered_by);
    assert.ok(named.some(by => by.includes("cited-source-read")));
  });
});

describe("the registry is a classification a reader can check", () => {
  it("declares a vendor slug the catalogue knows for every read", () => {
    for (const read of DECLARED_FIGURE_READS) {
      assert.ok(read.vendors.length > 0, `${read.path} declares a read covering no vendor`);
      for (const slug of read.vendors) {
        assert.ok(vendorSlugMap.has(slug), `${read.path} declares a read over ${slug}, which is not a vendor slug`);
      }
    }
  });

  it("binds the reads whose date is a constant to the constant their page renders", () => {
    assert.strictEqual(HETZNER_PLAN_TABLE_READ_ON, HETZNER_PRICES_READ);
    assert.strictEqual(STORAGE_RATE_CARD_READ_ON, STORAGE_RATES_READ);
  });

  it("returns every read it holds from the lookup keyed on the page", () => {
    for (const read of DECLARED_FIGURE_READS) {
      const declared = declaredFigureReadsFor(read.path);
      assert.ok(
        declared.some(entry => entry.read_on === read.read_on),
        `${read.path} declares a read on ${read.read_on} its own lookup does not return`,
      );
    }
  });

  it("declares a page the register holds", () => {
    const known = new Set(REGISTRY.pages.map(p => p.path));
    for (const read of DECLARED_FIGURE_READS) {
      assert.ok(known.has(read.path), `${read.path} declares a figure read and is not in the page register`);
    }
  });

  it("dates every read within the catalogue's own calendar", () => {
    for (const read of DECLARED_FIGURE_READS) {
      assert.match(read.read_on, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(read.read_on <= TODAY, `${read.path} declares a read dated after today`);
    }
  });

  it("holds a declared read that clears nothing, so the registry is not a suppression list", () => {
    const clearsNothing = DECLARED_FIGURE_READS.filter(read => {
      const before = tableFlagSlugs(read.path, []);
      const after = tableFlagSlugs(read.path);
      return before.length === after.length;
    });
    assert.ok(clearsNothing.length > 0);
  });

  it("gives every excluded read-date shape a reason", () => {
    assert.ok(READ_DATES_THAT_ARE_NOT_FIGURE_READS.length >= 3);
    for (const entry of READ_DATES_THAT_ARE_NOT_FIGURE_READS) {
      assert.ok(entry.states.length > 0);
      assert.ok(entry.rendered_by.length > 0);
      assert.ok(entry.why.length > 40, `${entry.states} is excluded without a reason a reviewer can read`);
    }
  });

  it("names every disclosure a table cell can carry in one list", () => {
    assert.deepStrictEqual(
      TABLE_STALENESS_DISCLOSURES.map(d => d.name).sort(),
      ["changed_marker", "dated_vendor_quote", "row_level_provenance"],
    );
    for (const disclosure of TABLE_STALENESS_DISCLOSURES) {
      assert.ok(disclosure.signature.length > 0);
      assert.ok(disclosure.states.length > 0);
    }
  });
});

describe("the register the ratchet reads does not move", () => {
  it("keeps the same pages in the stale-fact cohort", () => {
    const withRegistry = staleFactPages(REGISTRY.pages, TODAY, changeDateFor).map(p => p.path).sort();
    const withoutRegistry = REGISTRY.pages
      .filter(record => factsOutdatedBy(reviewStatus(record, TODAY), changeDateFor, []).length > 0)
      .map(record => record.path)
      .sort();
    assert.deepStrictEqual(withRegistry, withoutRegistry);
  });

  it("leaves no page in the register with every flag cleared by a declared read", () => {
    for (const read of DECLARED_FIGURE_READS) {
      const before = flagsOn(read.path, []).length;
      if (before === 0) continue;
      assert.ok(flagsOn(read.path).length > 0, `${read.path} lost every flag to a declared read`);
    }
  });
});
