import { describe, it } from "node:test";
import assert from "node:assert";

describe("classifyStability", () => {
  it("returns stable for vendor with no changes", async () => {
    const { classifyStability } = await import("../dist/data.js");
    assert.strictEqual(classifyStability([]), "stable");
  });

  it("returns volatile for vendor with free_tier_removed", async () => {
    const { classifyStability } = await import("../dist/data.js");
    const changes = [{
      vendor: "TestVendor",
      change_type: "free_tier_removed",
      date: "2026-01-15",
      summary: "Free tier removed",
      previous_state: "Free plan available",
      current_state: "No free plan",
      impact: "high",
      source_url: "https://example.com",
      category: "Databases",
      alternatives: [],
    }];
    assert.strictEqual(classifyStability(changes), "volatile");
  });

  it("returns volatile for vendor with multiple negative changes", async () => {
    const { classifyStability } = await import("../dist/data.js");
    const changes = [
      {
        vendor: "TestVendor",
        change_type: "limits_reduced",
        date: "2026-01-15",
        summary: "Limits reduced",
        previous_state: "100GB",
        current_state: "10GB",
        impact: "medium",
        source_url: "https://example.com",
        category: "Storage",
        alternatives: [],
      },
      {
        vendor: "TestVendor",
        change_type: "restriction",
        date: "2026-02-15",
        summary: "New restriction added",
        previous_state: "No restrictions",
        current_state: "Requires credit card",
        impact: "low",
        source_url: "https://example.com",
        category: "Storage",
        alternatives: [],
      },
    ];
    assert.strictEqual(classifyStability(changes), "volatile");
  });

  it("returns watch for vendor with one negative change", async () => {
    const { classifyStability } = await import("../dist/data.js");
    const changes = [{
      vendor: "TestVendor",
      change_type: "limits_reduced",
      date: "2026-01-15",
      summary: "Storage limits reduced",
      previous_state: "100GB",
      current_state: "50GB",
      impact: "medium",
      source_url: "https://example.com",
      category: "Storage",
      alternatives: [],
    }];
    assert.strictEqual(classifyStability(changes), "watch");
  });

  it("returns improving for vendor with only positive changes", async () => {
    const { classifyStability } = await import("../dist/data.js");
    const changes = [
      {
        vendor: "TestVendor",
        change_type: "limits_increased",
        date: "2026-01-15",
        summary: "Limits increased",
        previous_state: "10GB",
        current_state: "50GB",
        impact: "medium",
        source_url: "https://example.com",
        category: "Storage",
        alternatives: [],
      },
      {
        vendor: "TestVendor",
        change_type: "new_free_tier",
        date: "2026-02-15",
        summary: "New free tier added",
        previous_state: "No free tier",
        current_state: "Free tier available",
        impact: "high",
        source_url: "https://example.com",
        category: "Storage",
        alternatives: [],
      },
    ];
    assert.strictEqual(classifyStability(changes), "improving");
  });

  it("returns stable for vendor with only neutral changes", async () => {
    const { classifyStability } = await import("../dist/data.js");
    const changes = [{
      vendor: "TestVendor",
      change_type: "pricing_model_change",
      date: "2026-01-15",
      summary: "Pricing model restructured",
      previous_state: "Old model",
      current_state: "New model",
      impact: "low",
      source_url: "https://example.com",
      category: "CI/CD",
      alternatives: [],
    }];
    assert.strictEqual(classifyStability(changes), "stable");
  });
});

describe("getStabilityMap", () => {
  it("returns a Map with stability classes for vendors with changes", async () => {
    const { getStabilityMap } = await import("../dist/data.js");
    const map = getStabilityMap();
    assert.ok(map instanceof Map, "Should return a Map");
    assert.ok(map.size > 0, "Should have entries for vendors with changes");

    for (const [vendor, stability] of map) {
      assert.ok(typeof vendor === "string", "Keys should be strings");
      assert.ok(
        ["stable", "watch", "volatile", "improving"].includes(stability),
        `Stability should be valid class, got: ${stability} for ${vendor}`
      );
    }
  });
});

describe("enrichOffers includes stability", () => {
  it("adds stability field to enriched offers", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");
    const results = searchOffers("database");
    assert.ok(results.length > 0);

    const enriched = enrichOffers(results.slice(0, 5));
    for (const offer of enriched) {
      assert.ok("stability" in offer, "Should have stability field");
      assert.ok(
        ["stable", "watch", "volatile", "improving"].includes(offer.stability),
        `stability should be valid, got: ${offer.stability}`
      );
    }
  });
});

describe("searchOffers stability filter", () => {
  it("filters results by stability class", async () => {
    const { searchOffers, enrichOffers, getStabilityMap } = await import("../dist/data.js");

    // Get results filtered to stable only
    const stableResults = searchOffers(undefined, undefined, undefined, undefined, "stable");
    assert.ok(stableResults.length > 0, "Should find stable vendors");

    // Verify all returned results are actually stable
    const stabilityMap = getStabilityMap();
    for (const offer of stableResults) {
      const stability = stabilityMap.get(offer.vendor.toLowerCase()) ?? "stable";
      assert.strictEqual(stability, "stable", `${offer.vendor} should be stable`);
    }
  });
});
