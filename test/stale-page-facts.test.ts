import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_FACT_PAGES_BASELINE, factsOutdatedBy, newestChangeBySlug, parsePageReviews, reviewStatus,
  staleFactPages, staleFactViolations, utcToday, vendorsStatedBy,
  type PageReviewRecord,
} from "../src/page-reviews.ts";
import { toSlug } from "../dist/vendor-slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const REGISTRY = parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));
const CHANGES = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes as Array<{ vendor?: string; date?: string }>;

const TODAY = utcToday();
const CHANGE_DATE = newestChangeBySlug(CHANGES, TODAY, toSlug);
const changeDateFor = (slug: string) => CHANGE_DATE.get(slug) ?? null;

function page(over: Partial<PageReviewRecord> & { path: string }): PageReviewRecord {
  return {
    published: "2026-04-03",
    tier: "A",
    vendors_asserted: [],
    vendors_tabulated: [],
    badge_subjects_unresolved: [],
    reviewed_at: null,
    reviewer: null,
    review_outcome: null,
    review_note: null,
    reads_index: false,
    reads_changes: false,
    data_source: "unsourced",
    data_source_reason: null,
    ...over,
  };
}

function statusOf(over: Partial<PageReviewRecord> = {}) {
  return reviewStatus(page({ path: "/p", ...over }), "2026-09-02");
}

describe("what a page states a fact about is more than what its verdict awards", () => {
  it("unions both surfaces, dedupes and sorts", () => {
    assert.deepStrictEqual(
      vendorsStatedBy({ vendors_asserted: ["neon", "supabase"], vendors_tabulated: ["supabase", "firebase"] }),
      ["firebase", "neon", "supabase"]
    );
  });

  it("names the surface each stale fact came from, and calls a vendor on both a verdict", () => {
    const status = statusOf({ vendors_asserted: ["neon"], vendors_tabulated: ["neon", "firebase"] });
    const stale = factsOutdatedBy(status, slug => (slug === "neon" ? "2026-08-01" : "2026-07-01"));
    assert.deepStrictEqual(stale, [
      { slug: "neon", changed: "2026-08-01", surface: "verdict" },
      { slug: "firebase", changed: "2026-07-01", surface: "table" },
    ]);
  });

  it("reports a table fact on a page whose verdict blocks name no vendor at all", () => {
    const status = statusOf({ vendors_asserted: [], vendors_tabulated: ["render"] });
    assert.deepStrictEqual(factsOutdatedBy(status, () => "2026-08-01"), [
      { slug: "render", changed: "2026-08-01", surface: "table" },
    ]);
  });

  it("holds a change on the day the clock starts to be answered by the reading, not outstanding", () => {
    const status = statusOf({ published: "2026-04-03", vendors_tabulated: ["render"] });
    assert.deepStrictEqual(factsOutdatedBy(status, () => "2026-04-03"), []);
    assert.strictEqual(factsOutdatedBy(status, () => "2026-04-04").length, 1);
  });

  it("measures from the review where one happened and from publication where none did", () => {
    const reviewed = statusOf({ published: "2026-04-03", reviewed_at: "2026-08-01", review_outcome: "pass", vendors_tabulated: ["render"] });
    assert.deepStrictEqual(factsOutdatedBy(reviewed, () => "2026-07-01"), []);
    const never = statusOf({ published: "2026-04-03", vendors_tabulated: ["render"] });
    assert.strictEqual(factsOutdatedBy(never, () => "2026-07-01").length, 1);
  });

  it("says nothing about a vendor the change log has never moved", () => {
    assert.deepStrictEqual(factsOutdatedBy(statusOf({ vendors_tabulated: ["render"] }), () => null), []);
  });
});

describe("the newest change per vendor", () => {
  it("takes the latest of several and ignores one dated after the day asked about", () => {
    const newest = newestChangeBySlug(
      [
        { vendor: "Render", date: "2026-04-01" },
        { vendor: "Render", date: "2026-08-01" },
        { vendor: "Render", date: "2026-10-07" },
      ],
      "2026-09-02",
      toSlug
    );
    assert.strictEqual(newest.get("render"), "2026-08-01");
  });

  it("skips a record carrying no vendor or no date", () => {
    const newest = newestChangeBySlug([{ date: "2026-08-01" }, { vendor: "Render" }], "2026-09-02", toSlug);
    assert.strictEqual(newest.size, 0);
  });
});

describe("the number of pages resting on a record that has moved under them only goes down", () => {
  const moved = () => "2026-08-01";

  it("refuses one more than the budget, and names the cohort so the entrant can be found", () => {
    const pages = [
      page({ path: "/a", vendors_asserted: ["neon"] }),
      page({ path: "/b", vendors_tabulated: ["render"] }),
    ];
    const problems = staleFactViolations(pages, "2026-09-02", moved, 1).map(v => v.problem);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0]!, /2 pages state a vendor fact/);
    assert.match(problems[0]!, /1 more than the budget allows, and the budget does not rise/);
    assert.match(problems[0]!, /\/a, \/b/);
  });

  it("refuses a budget left above what the register now holds, so a reviewed page's slot cannot be reused", () => {
    const pages = [page({ path: "/a", vendors_asserted: ["neon"] })];
    const problems = staleFactViolations(pages, "2026-09-02", moved, 4).map(v => v.problem);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0]!, /lower STALE_FACT_PAGES_BASELINE to 1/);
  });

  it("is silent when the cohort is exactly the budget", () => {
    const pages = [page({ path: "/a", vendors_asserted: ["neon"] }), page({ path: "/quiet" })];
    assert.deepStrictEqual(staleFactViolations(pages, "2026-09-02", moved, 1), []);
  });

  it("counts a page once however many of its facts have moved", () => {
    const pages = [page({ path: "/a", vendors_asserted: ["neon", "supabase"], vendors_tabulated: ["render"] })];
    const stale = staleFactPages(pages, "2026-09-02", moved);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0]!.facts.length, 3);
  });

  it("orders the cohort by how many facts have moved under each page", () => {
    const pages = [
      page({ path: "/one", vendors_asserted: ["neon"] }),
      page({ path: "/three", vendors_asserted: ["neon", "supabase", "render"] }),
    ];
    assert.deepStrictEqual(staleFactPages(pages, "2026-09-02", moved).map(p => p.path), ["/three", "/one"]);
  });
});

describe("the register the site ships", () => {
  it("holds a cohort the baseline matches exactly", () => {
    const stale = staleFactPages(REGISTRY.pages, TODAY, changeDateFor);
    assert.deepStrictEqual(
      staleFactViolations(REGISTRY.pages, TODAY, changeDateFor).map(v => v.problem),
      [],
      `${stale.length} pages state a vendor fact whose record has moved since the page was last read; STALE_FACT_PAGES_BASELINE is ${STALE_FACT_PAGES_BASELINE}`
    );
  });

  it("states every flagged fact from a record dated after the page was last read", () => {
    for (const p of staleFactPages(REGISTRY.pages, TODAY, changeDateFor)) {
      for (const fact of p.facts) {
        assert.ok(fact.changed > p.clock_starts, `${p.path}/${fact.slug} ${fact.changed} is not after ${p.clock_starts}`);
      }
    }
  });

  it("finds facts on the table surface that the verdict surface never sees", () => {
    const stale = staleFactPages(REGISTRY.pages, TODAY, changeDateFor);
    const tableOnly = stale.flatMap(p => p.facts.filter(f => f.surface === "table").map(f => `${p.path}/${f.slug}`));
    const pagesOnlyTable = stale.filter(p => p.facts.every(f => f.surface === "table"));
    assert.ok(tableOnly.length > 0, "no page states a stale fact in a table its verdict blocks do not also name");
    assert.ok(pagesOnlyTable.length > 0, "no page is in the cohort on its table alone");
  });

  it("counts a vendor a comparison table prices but no verdict awards", () => {
    const page = REGISTRY.pages.find(p => p.path === "/ai-coding-pricing-2026");
    assert.ok(page, "/ai-coding-pricing-2026 is not on the register");
    assert.ok(page.vendors_tabulated.includes("augment-code"), JSON.stringify(page.vendors_tabulated));
    assert.ok(!page.vendors_asserted.includes("augment-code"), JSON.stringify(page.vendors_asserted));
    assert.ok(vendorsStatedBy(page).includes("augment-code"));
  });

  it("gives every page a tabulated list, so a missing field cannot read as a page that tabulates nothing", () => {
    const withTable = REGISTRY.pages.filter(p => p.vendors_tabulated.length > 0);
    assert.ok(withTable.length >= 40, `only ${withTable.length} pages record a tabulated vendor`);
  });
});

describe("a reviewer's note survives a regeneration of what is derived", () => {
  it("keeps a note left against a review", () => {
    const parsed = parsePageReviews(JSON.stringify({
      pages: [{ path: "/a", published: "2026-04-03", tier: "A", reviewed_at: "2026-08-27", review_outcome: "fail", review_note: "  the table is stale  " }],
    }));
    assert.strictEqual(parsed.pages[0]!.review_note, "the table is stale");
  });

  it("drops a note no review date supports, and one that is only whitespace", () => {
    const parsed = parsePageReviews(JSON.stringify({
      pages: [
        { path: "/a", published: "2026-04-03", tier: "A", review_note: "unattributed" },
        { path: "/b", published: "2026-04-03", tier: "A", reviewed_at: "2026-08-27", review_outcome: "fail", review_note: "   " },
      ],
    }));
    assert.deepStrictEqual(parsed.pages.map(p => p.review_note), [null, null]);
  });

  it("carries the note the shipped register holds", () => {
    const noted = REGISTRY.pages.filter(p => p.review_note !== null);
    assert.ok(noted.length >= 1, "no page on the register carries a review note");
    for (const p of noted) assert.ok(p.reviewed_at !== null, `${p.path} carries a note with no review date`);
  });

  it("reports the note beside the page's status, so what the reading found travels with it", () => {
    const noted = REGISTRY.pages.find(p => p.review_note !== null)!;
    assert.strictEqual(reviewStatus(noted, TODAY).review_note, noted.review_note);
  });

  it("claims no note from a review the register dates in the future", () => {
    const ahead = page({ path: "/p", reviewed_at: "2026-12-01", review_outcome: "fail", review_note: "found a stale row" });
    assert.strictEqual(reviewStatus(ahead, "2026-09-02").review_note, null);
  });
});
