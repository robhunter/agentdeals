import { describe, it } from "node:test";
import assert from "node:assert";

describe("enrichOffers", () => {
  it("adds risk_level, recent_change, and expires_soon fields to offers", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");
    const results = searchOffers("database");
    assert.ok(results.length > 0, "Should find database offers");

    const enriched = enrichOffers(results.slice(0, 5));
    assert.strictEqual(enriched.length, Math.min(5, results.length));

    for (const offer of enriched) {
      assert.ok("recent_change" in offer, "Should have recent_change field");
      assert.ok("expires_soon" in offer, "Should have expires_soon field");
      assert.ok("risk_level" in offer, "Should have risk_level field");

      // risk_level should be one of the valid values or null
      assert.ok(
        offer.risk_level === null || ["stable", "caution", "risky"].includes(offer.risk_level),
        `risk_level should be stable/caution/risky/null, got: ${offer.risk_level}`
      );

      // recent_change should be string or null
      assert.ok(
        offer.recent_change === null || typeof offer.recent_change === "string",
        "recent_change should be string or null"
      );

      // expires_soon should be string or null
      assert.ok(
        offer.expires_soon === null || typeof offer.expires_soon === "string",
        "expires_soon should be string or null"
      );
    }
  });

  it("returns stable for vendor with no deal changes", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const offers = loadOffers();

    // Find a vendor with no deal changes — most vendors have none
    const { loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const changedVendors = new Set(changes.map((c: { vendor: string }) => c.vendor.toLowerCase()));

    const stableOffer = offers.find((o: { vendor: string }) => !changedVendors.has(o.vendor.toLowerCase()));
    assert.ok(stableOffer, "Should find at least one vendor with no changes");

    const enriched = enrichOffers([stableOffer]);
    assert.strictEqual(enriched[0].risk_level, "stable");
    assert.strictEqual(enriched[0].recent_change, null);
  });

  it("returns caution for vendor with exactly 1 deal change", async () => {
    const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const offers = loadOffers();

    // Count changes per vendor
    const counts = new Map<string, number>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Find vendor with exactly 1 change
    const singleChangeVendor = [...counts.entries()].find(([, count]) => count === 1);
    if (!singleChangeVendor) return; // Skip if no such vendor

    const offer = offers.find((o: { vendor: string }) => o.vendor.toLowerCase() === singleChangeVendor[0]);
    if (!offer) return;

    const enriched = enrichOffers([offer]);
    assert.strictEqual(enriched[0].risk_level, "caution");
  });

  it("returns risky for vendor with 2+ deal changes", async () => {
    const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const offers = loadOffers();

    // Count changes per vendor
    const counts = new Map<string, number>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Find vendor with 2+ changes
    const multiChangeVendor = [...counts.entries()].find(([, count]) => count >= 2);
    if (!multiChangeVendor) return; // Skip if no such vendor

    const offer = offers.find((o: { vendor: string }) => o.vendor.toLowerCase() === multiChangeVendor[0]);
    if (!offer) return;

    const enriched = enrichOffers([offer]);
    assert.strictEqual(enriched[0].risk_level, "risky");
  });

  it("preserves original offer fields in enriched result", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");
    const results = searchOffers("vercel");
    assert.ok(results.length > 0);

    const enriched = enrichOffers([results[0]]);
    assert.strictEqual(enriched[0].vendor, results[0].vendor);
    assert.strictEqual(enriched[0].category, results[0].category);
    assert.strictEqual(enriched[0].description, results[0].description);
    assert.strictEqual(enriched[0].tier, results[0].tier);
    assert.strictEqual(enriched[0].url, results[0].url);
    assert.deepStrictEqual(enriched[0].tags, results[0].tags);
  });

  it("handles empty offers array", async () => {
    const { enrichOffers } = await import("../dist/data.js");
    const enriched = enrichOffers([]);
    assert.strictEqual(enriched.length, 0);
  });

  it("recent_change includes date and summary for vendor with changes", async () => {
    const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const offers = loadOffers();

    if (changes.length === 0) return;

    // Find a vendor that has a recent change (within 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentChange = changes.find((c: { date: string }) => c.date >= ninetyDaysAgo);
    if (!recentChange) return;

    const offer = offers.find((o: { vendor: string }) => o.vendor.toLowerCase() === recentChange.vendor.toLowerCase());
    if (!offer) return;

    const enriched = enrichOffers([offer]);
    assert.ok(enriched[0].recent_change !== null, "Should have recent_change");
    assert.ok(enriched[0].recent_change!.includes(recentChange.date), "Should include change date");
  });
});
