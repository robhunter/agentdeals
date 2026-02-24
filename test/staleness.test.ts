import { describe, it } from "node:test";
import assert from "node:assert";

// Import the exported function from the JS script
const { findStaleEntries } = await import("../scripts/check-staleness.js");

describe("staleness detection", () => {
  const now = new Date("2026-03-15T00:00:00Z");

  it("returns empty array when all entries are fresh", () => {
    const offers = [
      { vendor: "Vercel", category: "Cloud Hosting", verifiedDate: "2026-03-10" },
      { vendor: "Render", category: "Cloud Hosting", verifiedDate: "2026-03-01" },
    ];
    const stale = findStaleEntries(offers, 30, now);
    assert.strictEqual(stale.length, 0);
  });

  it("identifies entries older than threshold", () => {
    const offers = [
      { vendor: "Fresh", category: "Hosting", verifiedDate: "2026-03-10" },
      { vendor: "Stale", category: "Databases", verifiedDate: "2026-01-01" },
      { vendor: "VeryStale", category: "CI/CD", verifiedDate: "2025-12-01" },
    ];
    const stale = findStaleEntries(offers, 30, now);
    assert.strictEqual(stale.length, 2);
    assert.strictEqual(stale[0].vendor, "VeryStale");
    assert.strictEqual(stale[1].vendor, "Stale");
  });

  it("handles missing verifiedDate as infinitely stale", () => {
    const offers = [
      { vendor: "NoDate", category: "Auth" },
    ];
    const stale = findStaleEntries(offers, 30, now);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].vendor, "NoDate");
    assert.strictEqual(stale[0].daysSince, Infinity);
  });

  it("respects configurable threshold", () => {
    const offers = [
      { vendor: "A", category: "Hosting", verifiedDate: "2026-03-10" },
      { vendor: "B", category: "Hosting", verifiedDate: "2026-03-14" },
    ];
    // With threshold 2, entries older than 2 days from March 15 are stale
    // A is 5 days old (stale), B is 1 day old (fresh)
    const stale = findStaleEntries(offers, 2, now);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].vendor, "A");
    assert.strictEqual(stale[0].daysSince, 5);
  });

  it("returns entries sorted by staleness descending", () => {
    const offers = [
      { vendor: "MedStale", category: "A", verifiedDate: "2026-02-01" },
      { vendor: "MostStale", category: "B", verifiedDate: "2025-12-01" },
      { vendor: "LeastStale", category: "C", verifiedDate: "2026-02-10" },
    ];
    const stale = findStaleEntries(offers, 30, now);
    assert.strictEqual(stale[0].vendor, "MostStale");
    assert.strictEqual(stale[1].vendor, "MedStale");
    assert.strictEqual(stale[2].vendor, "LeastStale");
  });

  it("includes correct daysSince calculation", () => {
    const offers = [
      { vendor: "Test", category: "X", verifiedDate: "2026-02-13" },
    ];
    const stale = findStaleEntries(offers, 0, now);
    assert.strictEqual(stale[0].daysSince, 30);
  });
});
