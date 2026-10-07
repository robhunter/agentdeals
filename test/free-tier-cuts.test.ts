import { describe, it } from "node:test";
import assert from "node:assert";
import type { DealChange } from "../src/types.ts";
import { FREE_TIER_CUT_TYPES, cutsByQuarterNewestFirst, cutsWindow, freeTierCutsIn, quarterOf } from "../dist/free-tier-cuts.js";
import { CUT_KIND_NOUNS, changeTypesAmong, cutsThisYearSummary } from "../dist/free-tier-tracker.js";

const TODAY = "2026-10-06";

function record(vendor: string, date: string, over: Record<string, unknown> = {}): DealChange {
  return {
    vendor,
    change_type: "free_tier_removed",
    date,
    date_source: "vendor_page",
    recorded_date: date,
    summary: `${vendor} ended its free plan.`,
    previous_state: "A free plan.",
    current_state: "No free plan.",
    impact: "high",
    category: "Developer Tools",
    alternatives: [],
    source_url: `https://example.com/${vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    ...over,
  } as DealChange;
}

const vendorsOf = (records: readonly DealChange[]) => records.map((r) => r.vendor);

describe("free tiers removed and cut in a year, computed from the change records", () => {
  it("lists a removal, a limit cut and a deprecation that ends a listed product, each dated by the vendor", () => {
    const changes = [
      record("Removed Fixture", "2026-05-04"),
      record("Reduced Fixture", "2026-05-03", { change_type: "limits_reduced" }),
      record("Ended Fixture", "2026-05-02", { change_type: "product_deprecated", listing_effect: "ends" }),
      record("Narrowed Fixture", "2026-05-01", { change_type: "product_deprecated", listing_effect: "narrows", date_source: "hand_written", recorded_date: "2026-04-20" }),
    ];
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, TODAY)), ["Removed Fixture", "Reduced Fixture", "Ended Fixture", "Narrowed Fixture"]);
  });

  it("leaves out records withdrawn as our error, changes the vendor reversed, unconfirmed readings and records citing no source", () => {
    const changes = [
      record("Kept Fixture", "2026-06-10"),
      record("Retracted Fixture", "2026-06-09", { resolution: { state: "retracted", date: "2026-06-20", detail: "Withdrawn as our error." } }),
      record("Reversed Fixture", "2026-06-08", { resolution: { state: "reversed", date: "2026-06-20", detail: "The vendor restored the plan." } }),
      record("Unconfirmed Fixture", "2026-06-07", { archive_check: { checked: "2026-06-20", outcome: "no_usable_capture" } }),
      record("Unsourced Fixture", "2026-06-06", { source_url: "" }),
    ];
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, TODAY)), ["Kept Fixture"]);
  });

  it("leaves out records dated only by the day we recorded them", () => {
    const changes = [
      record("Kept Fixture", "2026-07-10"),
      record("Discovered Fixture", "2026-07-09", { date_source: "discovered" }),
      record("Typed On The Day Fixture", "2026-07-08", { date_source: "hand_written", recorded_date: "2026-07-08" }),
    ];
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, TODAY)), ["Kept Fixture"]);
  });

  it("lists a change our archive copies bracket inside the year, in the quarter of the date we hold for it", () => {
    const bracketed = (vendor: string, date: string, lastOld: string, over: Record<string, unknown> = {}) =>
      record(vendor, date, {
        date_source: "discovered",
        recorded_date: date,
        archive_check: { checked: "2026-10-03", outcome: "vendor_changed", brackets: [{ last_old: lastOld, first_new: date }] },
        ...over,
      });
    const changes = [
      record("Dated Fixture", "2026-08-30"),
      bracketed("Bracketed Fixture", "2026-08-28", "2026-05-10"),
      bracketed("New Year Bracket Fixture", "2026-02-02", "2026-01-01"),
      bracketed("Last Year Bracket Fixture", "2026-03-12", "2025-12-31"),
      bracketed("Two Brackets Fixture", "2026-07-01", "2026-06-01", {
        archive_check: { checked: "2026-10-03", outcome: "vendor_changed", brackets: [{ last_old: "2026-02-01", first_new: "2026-03-01" }, { last_old: "2026-06-01", first_new: "2026-07-01" }] },
      }),
      bracketed("Text Day Unknown Fixture", "2026-06-15", "2026-04-01", {
        archive_check: { checked: "2026-10-03", outcome: "text_day_unknown", brackets: [{ last_old: "2026-04-01", first_new: "2026-06-15" }] },
      }),
    ];
    const cuts = freeTierCutsIn(2026, changes, TODAY);
    assert.deepStrictEqual(vendorsOf(cuts), ["Dated Fixture", "Bracketed Fixture", "New Year Bracket Fixture"]);
    assert.deepStrictEqual(
      cutsByQuarterNewestFirst(2026, cuts).map((group) => [group.quarter, vendorsOf(group.records)]),
      [[3, ["Dated Fixture", "Bracketed Fixture"]], [1, ["New Year Bracket Fixture"]]],
    );
  });

  it("leaves out medium- and low-impact records, other change types and retirements that change no listing", () => {
    const changes = [
      record("Kept Fixture", "2026-08-10"),
      record("Medium Fixture", "2026-08-09", { impact: "medium" }),
      record("Low Fixture", "2026-08-08", { impact: "low" }),
      record("Restructured Fixture", "2026-08-07", { change_type: "pricing_restructured" }),
      record("Expanded Fixture", "2026-08-06", { change_type: "limits_increased" }),
      record("Model Retirement Fixture", "2026-08-05", { change_type: "product_deprecated", listing_effect: "none" }),
    ];
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, TODAY)), ["Kept Fixture"]);
  });

  it("covers the first day of the year to today, so later records join on their date and other years stay out", () => {
    const changes = [
      record("New Year Fixture", "2026-01-01"),
      record("Today Fixture", TODAY),
      record("Tomorrow Fixture", "2026-10-07"),
      record("Last Year Fixture", "2025-12-31"),
      record("Next Year Fixture", "2027-01-01"),
    ];
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, TODAY)), ["Today Fixture", "New Year Fixture"]);
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, "2026-10-07")), ["Tomorrow Fixture", "Today Fixture", "New Year Fixture"]);
    assert.deepStrictEqual(vendorsOf(freeTierCutsIn(2026, changes, "2027-03-01")), ["Tomorrow Fixture", "Today Fixture", "New Year Fixture"]);
  });

  it("orders the year newest first and groups it by quarter, newest quarter first, with no empty quarter", () => {
    const changes = [
      record("January Fixture", "2026-01-15"),
      record("September Fixture", "2026-09-30"),
      record("March Fixture", "2026-03-31"),
      record("July Fixture", "2026-07-01"),
    ];
    const cuts = freeTierCutsIn(2026, changes, TODAY);
    assert.deepStrictEqual(vendorsOf(cuts), ["September Fixture", "July Fixture", "March Fixture", "January Fixture"]);
    assert.deepStrictEqual(
      cutsByQuarterNewestFirst(2026, cuts).map((group) => [group.quarter, vendorsOf(group.records)]),
      [[3, ["September Fixture", "July Fixture"]], [1, ["March Fixture", "January Fixture"]]],
    );
  });

  it("puts each month in its calendar quarter", () => {
    assert.deepStrictEqual(
      ["2026-01-01", "2026-03-31", "2026-04-01", "2026-06-30", "2026-07-01", "2026-09-30", "2026-10-01", "2026-12-31"].map(quarterOf),
      [1, 1, 2, 2, 3, 3, 4, 4],
    );
  });
});

describe("the sentence that opens the year's list", () => {
  const ofKinds = (removals: number, cuts: number, endings: number) => [
    ...Array.from({ length: removals }, () => ({ change_type: "free_tier_removed" })),
    ...Array.from({ length: cuts }, () => ({ change_type: "limits_reduced" })),
    ...Array.from({ length: endings }, () => ({ change_type: "product_deprecated" })),
  ];

  it("states the span the list covers and how many of each kind of change it holds", () => {
    assert.strictEqual(
      cutsThisYearSummary(cutsWindow(2026, "2026-10-07"), ofKinds(13, 11, 6)),
      "This list holds high-impact changes from January 1 to October 7, 2026. It includes 13 free tier removals, 11 cuts, and 6 deprecations or shutdowns.",
    );
  });

  it("names a kind it holds one of in the singular and leaves out a kind it holds none of", () => {
    assert.strictEqual(
      cutsThisYearSummary(cutsWindow(2026, "2026-02-03"), ofKinds(1, 0, 1)),
      "This list holds high-impact changes from January 1 to February 3, 2026. It includes 1 free tier removal and 1 deprecation or shutdown.",
    );
    assert.strictEqual(cutsThisYearSummary(cutsWindow(2026, "2026-02-03"), ofKinds(0, 1, 0)), "This list holds high-impact changes from January 1 to February 3, 2026. It includes 1 cut.");
  });

  it("says nothing when the list is empty", () => {
    assert.strictEqual(cutsThisYearSummary(cutsWindow(2026, "2026-10-07"), []), null);
  });

  it("ends the span on the last day of the year once the year is over", () => {
    assert.match(cutsThisYearSummary(cutsWindow(2026, "2027-03-01"), ofKinds(1, 0, 0)) ?? "", /^This list holds high-impact changes from January 1 to December 31, 2026\. /);
  });

  it("has a noun for every kind of change the list can hold", () => {
    assert.deepStrictEqual([...CUT_KIND_NOUNS.keys()].sort(), [...FREE_TIER_CUT_TYPES].sort());
  });
});

describe("the change types the tracker's methodology names", () => {
  it("are each type the records carry, once, in alphabetical order", () => {
    assert.deepStrictEqual(
      changeTypesAmong([{ change_type: "rebranded" }, { change_type: "free_tier_removed" }, { change_type: "rebranded" }]),
      ["free_tier_removed", "rebranded"],
    );
  });
});
