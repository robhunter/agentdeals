import { describe, it } from "node:test";
import assert from "node:assert";

const { findStaleOffers, reverifyBatch } = await import("../scripts/reverify.js");

describe("reverify pipeline", () => {
  const now = new Date("2026-03-16T00:00:00Z");

  it("skips fresh entries", () => {
    const offers = [
      { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
      { vendor: "AlsoFresh", category: "CI/CD", url: "https://example.com", verifiedDate: "2026-03-15" },
    ];
    const { stale, freshCount } = findStaleOffers(offers, 25, now);
    assert.strictEqual(stale.length, 0);
    assert.strictEqual(freshCount, 2);
  });

  it("identifies stale entries beyond threshold", () => {
    const offers = [
      { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
      { vendor: "Stale", category: "Databases", url: "https://example.com", verifiedDate: "2026-02-01" },
      { vendor: "VeryStale", category: "CI/CD", url: "https://example.com", verifiedDate: "2025-12-01" },
    ];
    const { stale, freshCount } = findStaleOffers(offers, 25, now);
    assert.strictEqual(stale.length, 2);
    assert.strictEqual(freshCount, 1);
    assert.strictEqual(stale[0].offer.vendor, "Stale");
    assert.strictEqual(stale[1].offer.vendor, "VeryStale");
  });

  it("treats missing verifiedDate as stale", () => {
    const offers = [
      { vendor: "NoDate", category: "Auth", url: "https://example.com" },
    ];
    const { stale } = findStaleOffers(offers, 25, now);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].offer.vendor, "NoDate");
  });

  it("respects custom threshold parameter", () => {
    const offers = [
      { vendor: "A", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
      { vendor: "B", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-14" },
    ];
    // threshold=5: A is 6 days old (stale), B is 2 days old (fresh)
    const { stale, freshCount } = findStaleOffers(offers, 5, now);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].offer.vendor, "A");
    assert.strictEqual(freshCount, 1);
  });

  it("preserves original index for data updates", () => {
    const offers = [
      { vendor: "Fresh", category: "A", url: "https://example.com", verifiedDate: "2026-03-15" },
      { vendor: "Stale", category: "B", url: "https://example.com", verifiedDate: "2026-01-01" },
      { vendor: "AlsoStale", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
    ];
    const { stale } = findStaleOffers(offers, 25, now);
    assert.strictEqual(stale[0].index, 1);
    assert.strictEqual(stale[1].index, 2);
  });

  it("flags unreachable URLs in batch", async () => {
    const entries = [
      { index: 0, offer: { vendor: "Bad", url: "http://localhost:19999/nonexistent", category: "Test" } },
    ];
    const results = await reverifyBatch(entries, "2026-03-16");
    assert.strictEqual(results.flagged.length, 1);
    assert.strictEqual(results.verified.length, 0);
    assert.strictEqual(results.flagged[0].vendor, "Bad");
    assert.ok(results.flagged[0].error);
  });
});
