import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forecastShutdownsWithoutACard } from "../dist/forecast-shutdowns.js";
import type { DealChange } from "../src/types.js";

const first: DealChange = {
  vendor: "OpenAI", date: "2026-12-11", recorded_date: "2026-10-10",
  change_type: "product_deprecated", summary: "The first product retires.",
  what_ends: "First product", source_url: "https://example.com/deprecations",
  previous_state: "Available", current_state: "Retired", impact: "high", category: "AI / ML",
};

const differences: [string, Partial<DealChange>][] = [
  ["description", { summary: "The second product retires." }],
  ["product", { what_ends: "Second product" }],
  ["source", { source_url: "https://example.com/second-notice" }],
  ["date", { date: "2026-12-12" }],
  ["vendor", { vendor: "AWS" }],
];

describe("forecast shutdown identity", () => {
  for (const [field, change] of differences) {
    it(`retains distinct ${field} values in either input order`, () => {
      const second = { ...first, ...change, recorded_date: "2026-11-12" };
      for (const records of [[first, second], [second, first]]) {
        const cards = forecastShutdownsWithoutACard(records, []);
        assert.equal(cards.length, 2);
        assert.deepEqual(new Set(cards.map(card => card.record)), new Set([first, second]));
      }
    });
  }

  it("an explicit source covers only its own record on the vendor page and date", () => {
    const aws = { ...first, vendor: "AWS" };
    const lambda = { ...aws, summary: "Another AWS product retires.", source_url: "https://example.com/lambda" };
    const cards = [{ vendorSlug: "aws", deadline: first.date, covers: [{ vendor: "AWS", deadline: first.date, sourceUrl: first.source_url }] }];
    for (const records of [[aws, lambda], [lambda, aws]]) {
      assert.deepEqual(forecastShutdownsWithoutACard(records, cards).map(card => card.record), [lambda]);
    }
  });

  it("prints repeated copies once and retains the latest recorded copy", () => {
    const latest = { ...first, recorded_date: "2026-11-12" };
    for (const records of [[first, latest, first], [latest, first, latest]]) {
      assert.deepEqual(forecastShutdownsWithoutACard(records, []).map(card => card.record), [latest]);
    }
  });

  it("keeps distinct records when neither names what ends", () => {
    const unnamed = { ...first, what_ends: undefined };
    const other = { ...unnamed, summary: "Another product retires." };
    assert.deepEqual(forecastShutdownsWithoutACard([unnamed, other, unnamed], []).map(card => card.record), [unnamed, other]);
  });
});
