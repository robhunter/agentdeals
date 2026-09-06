import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  CATALOGUE_TEXT_FIELDS, PERTURBATION_SENTINEL, UNSOURCED_TIER_A_BASELINE,
  compiledClause, compiledNotice, dataProvenanceFor, freshnessSegmentFor, pageSourceViolations,
  parsePageReviews, perturbTextFields, unsourcedTierAPaths, vendorFactRows,
  type PageDataSource, type PageReviewRecord, type PageSourceMeasurement,
} from "../src/page-reviews.ts";

function page(overrides: Partial<PageReviewRecord> & { path: string }): PageReviewRecord {
  return {
    published: "2026-04-03",
    tier: "A",
    vendors_asserted: [],
    badge_subjects_unresolved: [],
    reviewed_at: null,
    reviewer: null,
    review_outcome: null,
    reads_index: false,
    reads_changes: false,
    data_source: "unsourced",
    data_source_reason: null,
    ...overrides,
  };
}

function seen(overrides: Partial<PageSourceMeasurement> = {}): PageSourceMeasurement {
  return { reads_index: false, reads_changes: false, vendor_fact_rows: 0, ...overrides };
}

function filled(count: number, source: PageDataSource = "unsourced"): PageReviewRecord[] {
  return Array.from({ length: count }, (_, i) => page({ path: `/filler-${i}`, data_source: source }));
}

function measurementsFor(pages: PageReviewRecord[]): Map<string, PageSourceMeasurement> {
  return new Map(pages.map(p => [p.path, seen({ reads_index: p.reads_index, reads_changes: p.reads_changes })]));
}

function problemsFor(pages: PageReviewRecord[], measured = measurementsFor(pages), budget = pages.filter(p => p.tier === "A" && p.data_source === "unsourced").length): string[] {
  return pageSourceViolations(pages, measured, budget).map(v => `${v.path} ${v.problem}`);
}

describe("what a page says its figures came from has to survive perturbing the store", () => {
  it("accepts a register whose every claim the measurement bears out", () => {
    const pages = [
      page({ path: "/reads", reads_index: true, data_source: "catalogue" }),
      page({ path: "/blind" }),
      page({ path: "/tool", tier: "B", data_source: "editorial", data_source_reason: "a calculator over what the reader typed" }),
    ];
    assert.deepStrictEqual(problemsFor(pages), []);
  });

  it("refuses a page claiming the catalogue that the perturbation leaves byte-identical", () => {
    const pages = [page({ path: "/claims-too-much", data_source: "catalogue" })];
    const problems = problemsFor(pages, new Map([["/claims-too-much", seen({ reads_index: false })]]), 0);
    assert.ok(problems.some(p => p.includes("byte-identical")), problems.join(" | "));
  });

  it("refuses a page the perturbation moves that declares any source but the catalogue", () => {
    for (const source of ["unsourced", "editorial"] as PageDataSource[]) {
      const pages = [page({ path: "/reads", reads_index: true, data_source: source, data_source_reason: "stated" })];
      const problems = problemsFor(pages, new Map([["/reads", seen({ reads_index: true })]]), 0);
      assert.ok(problems.some(p => p.includes("renders catalogue fields")), `${source}: ${problems.join(" | ")}`);
    }
  });

  it("reports a register entry nothing measured, rather than passing it", () => {
    const problems = pageSourceViolations([page({ path: "/ghost" })], new Map(), 1).map(v => v.problem);
    assert.deepStrictEqual(problems, ["on the register but not measured"]);
  });

  it("holds the register's reads_index and reads_changes to what the two perturbations found", () => {
    const pages = [page({ path: "/p", reads_index: true, reads_changes: false, data_source: "catalogue" })];
    const problems = problemsFor(pages, new Map([["/p", seen({ reads_index: true, reads_changes: true })]]), 0);
    assert.ok(problems.some(p => p.includes("reads_changes says false")), problems.join(" | "));
    const other = problemsFor(
      [page({ path: "/p", reads_index: false, reads_changes: true })],
      new Map([["/p", seen({ reads_index: true, reads_changes: true })]]),
      0
    );
    assert.ok(other.some(p => p.includes("reads_index says false")), other.join(" | "));
  });
});

describe("the editorial exemption has to be argued for", () => {
  it("refuses an exemption with no stated reason", () => {
    const pages = [page({ path: "/quiet", tier: "B", data_source: "editorial" })];
    assert.ok(problemsFor(pages).some(p => p.includes("no stated reason")), problemsFor(pages).join(" | "));
  });

  it("refuses an exemption on a page that puts a number beside a catalogued vendor", () => {
    const pages = [page({ path: "/table", tier: "B", data_source: "editorial", data_source_reason: "stated" })];
    const problems = problemsFor(pages, new Map([["/table", seen({ vendor_fact_rows: 12 })]]), 0);
    assert.ok(problems.some(p => p.includes("12 table rows")), problems.join(" | "));
  });

  it("refuses an exemption on a page whose verdict blocks name vendors", () => {
    const pages = [page({ path: "/verdict", tier: "B", data_source: "editorial", data_source_reason: "stated", vendors_asserted: ["neon", "supabase"] })];
    assert.ok(problemsFor(pages).some(p => p.includes("assert 2 vendors")), problemsFor(pages).join(" | "));
  });
});

describe("the number of tier-A pages asserting vendor facts from nowhere only goes down", () => {
  it("refuses one more than the budget", () => {
    const pages = filled(4);
    const problems = problemsFor(pages, measurementsFor(pages), 3);
    assert.ok(problems.some(p => p.includes("4 tier-A pages") && p.includes("does not rise")), problems.join(" | "));
  });

  it("refuses a budget left above what the register now holds, so a freed slot cannot be reused", () => {
    const pages = filled(3);
    const problems = problemsFor(pages, measurementsFor(pages), 4);
    assert.ok(
      problems.some(p => p.includes("set unsourced_tier_a to 3 in data/quality_budgets.json")),
      problems.join(" | ")
    );
  });

  it("counts only tier A, because the budget is a claim about pages that state a verdict", () => {
    const pages = [...filled(2), page({ path: "/b-page", tier: "B" })];
    assert.deepStrictEqual(unsourcedTierAPaths(pages), ["/filler-0", "/filler-1"]);
  });

  it("is the number the shipped register holds", () => {
    const shipped = parsePageReviews(
      readFileSync(new URL("../data/page-reviews.json", import.meta.url), "utf-8"),
    ).pages;
    assert.strictEqual(UNSOURCED_TIER_A_BASELINE, unsourcedTierAPaths(shipped).length);
    assert.ok(shipped.length > 60, `only ${shipped.length} pages on the register`);
  });
});

describe("a table row counts as a published vendor fact when it names a vendor and a number", () => {
  const slugFor = (text: string) => (text === "Backblaze B2" ? "backblaze-b2" : null);

  it("counts a row whose first cell names a vendor and whose cells carry a number", () => {
    const html = "<table><tr><td>Backblaze B2</td><td>10 GB</td></tr></table>";
    assert.deepStrictEqual(vendorFactRows(html, slugFor), [{ subject: "Backblaze B2", slug: "backblaze-b2" }]);
  });

  it("ignores a row about a vendor that asserts no number", () => {
    assert.deepStrictEqual(vendorFactRows("<table><tr><td>Backblaze B2</td><td>Object storage</td></tr></table>", slugFor), []);
  });

  it("ignores a row of numbers that names no vendor", () => {
    assert.deepStrictEqual(vendorFactRows("<table><tr><td>Bronze</td><td>10 codes/day</td></tr></table>", slugFor), []);
  });

  it("ignores a single-cell row, which states no fact about its subject", () => {
    assert.deepStrictEqual(vendorFactRows("<table><tr><td>Backblaze B2 10 GB</td></tr></table>", slugFor), []);
  });

  it("does not read a number out of the vendor's own name", () => {
    const html = "<table><tr><td>Backblaze B2</td><td>Object storage</td><td>Available</td></tr></table>";
    assert.deepStrictEqual(vendorFactRows(html, slugFor), []);
  });

  it("reads a vendor from a link when the cell text does not resolve", () => {
    const html = '<table><tr><td><a href="/vendor/cloudflare-r2">R2</a></td><td>10 GB</td></tr></table>';
    assert.deepStrictEqual(vendorFactRows(html, () => null), [{ subject: "R2", slug: "cloudflare-r2" }]);
  });

  it("finds the number in any cell of the row, not only the second", () => {
    const html = "<table><tr><td>Backblaze B2</td><td>Object storage</td><td>Free egress</td><td>3x stored</td></tr></table>";
    assert.strictEqual(vendorFactRows(html, slugFor).length, 1);
  });
});

describe("perturbing a store", () => {
  it("replaces the digits and marks the field, so a render that echoes it cannot look unchanged", () => {
    const records = [{ description: "10 GB free", tier: "free" }];
    const touched = perturbTextFields(records, CATALOGUE_TEXT_FIELDS);
    assert.strictEqual(touched, 2);
    assert.strictEqual(records[0]!.description, `${PERTURBATION_SENTINEL} 99 GB free`);
  });

  it("leaves a field that is not a string alone, and counts only what it changed", () => {
    const records = [{ description: null, notes: undefined, limits: 5, tier: "free" }];
    assert.strictEqual(perturbTextFields(records, CATALOGUE_TEXT_FIELDS), 1);
    assert.strictEqual(records[0]!.limits, 5);
  });
});

describe("a review date means a review happened, and the outcome says what it found", () => {
  it("keeps an outcome only where a review date supports it", () => {
    const parsed = parsePageReviews(JSON.stringify({
      pages: [
        { path: "/a", published: "2026-04-03", tier: "A", reviewed_at: "2026-08-26", review_outcome: "fail" },
        { path: "/b", published: "2026-04-03", tier: "A", reviewed_at: null, review_outcome: "pass" },
        { path: "/c", published: "2026-04-03", tier: "A", reviewed_at: "2026-08-26", review_outcome: "inconclusive" },
      ],
    }));
    assert.deepStrictEqual(parsed.pages.map(p => p.review_outcome), ["fail", null, null]);
  });

  it("treats a missing data source as the state that fails the ratchet, not as an exemption", () => {
    const parsed = parsePageReviews(JSON.stringify({
      pages: [{ path: "/a", published: "2026-04-03", tier: "A" }],
    }));
    assert.strictEqual(parsed.pages[0]!.data_source, "unsourced");
    assert.strictEqual(parsed.pages[0]!.data_source_reason, null);
  });

  it("drops a reason that is only whitespace, so an exemption cannot be claimed with an empty string", () => {
    const parsed = parsePageReviews(JSON.stringify({
      pages: [{ path: "/a", published: "2026-04-03", tier: "B", data_source: "editorial", data_source_reason: "   " }],
    }));
    assert.strictEqual(parsed.pages[0]!.data_source_reason, null);
  });

  it("names the date of the last check instead of claiming none has happened", () => {
    assert.strictEqual(compiledNotice("2026-04-03"), "Figures compiled 2026-04-03, not re-checked since");
    assert.strictEqual(compiledNotice("2026-04-03", "2026-08-26"), "Figures compiled 2026-04-03, last checked 2026-08-26");
  });

  it("says corrections are outstanding on a page whose review failed", () => {
    const failed = page({ path: "/p", reviewed_at: "2026-08-26", review_outcome: "fail" });
    assert.strictEqual(freshnessSegmentFor(failed, "2026-08-27"), " &middot; Reviewed 2026-08-26, corrections outstanding");
  });

  it("keeps saying so once that review is old enough to expire, because the corrections are still outstanding", () => {
    const failed = page({ path: "/p", reviewed_at: "2026-04-01", review_outcome: "fail" });
    const passed = page({ path: "/q", reviewed_at: "2026-04-01", review_outcome: "pass" });
    assert.match(freshnessSegmentFor(failed, "2026-08-27"), /corrections outstanding/);
    assert.strictEqual(freshnessSegmentFor(passed, "2026-08-27"), "");
  });

  it("claims no review date it cannot stand behind, on a page reviewed in the future", () => {
    const ahead = page({ path: "/p", reviewed_at: "2026-09-30", review_outcome: "fail" });
    assert.strictEqual(freshnessSegmentFor(ahead, "2026-08-27"), " &middot; Not yet reviewed");
  });

  it("does not name a future review date as the day the figures were last checked", () => {
    const ahead = page({ path: "/p", published: "2026-04-03", reviewed_at: "2026-09-30", review_outcome: "pass" });
    assert.strictEqual(dataProvenanceFor(ahead, 1580, "2026-08-27"), "Figures compiled 2026-04-03, not re-checked since");
    assert.strictEqual(compiledClause(ahead, "2026-08-27"), "Compiled 2026-04-03, not re-checked since");
  });

  it("names the check on both surfaces once that date has arrived", () => {
    const checked = page({ path: "/p", published: "2026-04-03", reviewed_at: "2026-08-26", review_outcome: "pass" });
    assert.strictEqual(dataProvenanceFor(checked, 1580, "2026-08-27"), "Figures compiled 2026-04-03, last checked 2026-08-26");
    assert.strictEqual(compiledClause(checked, "2026-08-27"), "Compiled 2026-04-03, last checked 2026-08-26");
  });

  it("cites the catalogue instead of a compilation date on a page that renders catalogue fields", () => {
    const reading = page({ path: "/p", reads_index: true, data_source: "catalogue", reviewed_at: "2026-08-26", review_outcome: "pass" });
    assert.strictEqual(dataProvenanceFor(reading, 1580, "2026-08-27"), "Data verified from our index of 1,580 developer tools");
  });
});
