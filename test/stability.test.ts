import { describe, it } from "node:test";
import assert from "node:assert";
import { assertCoversPopulation, vendorsInTheCatalogue } from "./population-floor.ts";

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
      change_type: "rebranded",
      date: "2026-01-15",
      summary: "Rebranded to NewName, URL changed",
      previous_state: "OldName",
      current_state: "NewName",
      impact: "low",
      source_url: "https://example.com",
      category: "CI/CD",
      alternatives: [],
    }];
    assert.strictEqual(classifyStability(changes), "stable");
  });

  it("a pricing model change that retires a free tier is not neutral", async () => {
    const { classifyStability } = await import("../dist/data.js");
    const changes = [{
      vendor: "TestVendor",
      change_type: "pricing_model_change",
      date: "2026-04-19",
      summary: "Pivoted to open source; SaaS free tier retired",
      previous_state: "Free tier",
      current_state: "Self-host only",
      impact: "high",
      source_url: "https://example.com",
      category: "Databases",
      alternatives: [],
    }];
    assert.strictEqual(classifyStability(changes), "watch");
  });
});

describe("publishedStabilityIndex", () => {
  it("classifies every vendor we hold a change history for", async () => {
    const { publishedStabilityIndex } = await import("../dist/data.js");
    const index = publishedStabilityIndex();
    assert.ok(index.vendorsWithChanges.length > 0, "Should have entries for vendors with changes");

    for (const { vendor, stability } of index.vendorsWithChanges) {
      assert.ok(typeof vendor === "string", "Vendor names should be strings");
      assert.ok(
        ["stable", "watch", "volatile", "improving", "unrated"].includes(stability),
        `Stability should be valid class, got: ${stability} for ${vendor}`
      );
    }
  });

  it("answers a lookup for a vendor it has never heard of without inventing a class", async () => {
    const { publishedStabilityIndex } = await import("../dist/data.js");
    assert.strictEqual(publishedStabilityIndex().of("a-vendor-we-do-not-list"), "unrated");
  });

  it("answers by slug as well as by vendor name, for every listed offer", async () => {
    const { publishedStabilityIndex, loadOffers, loadDealChanges, publishedRisk } = await import("../dist/data.js");
    const { toSlug } = await import("../dist/slug.js");
    const index = publishedStabilityIndex();
    const byVendor = new Map<string, unknown[]>();
    for (const c of loadDealChanges()) {
      const key = c.vendor.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(c);
    }
    const seen = new Set<string>();
    const disagree: string[] = [];
    for (const offer of loadOffers()) {
      const key = offer.vendor.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const expected = publishedRisk(offer, (byVendor.get(key) ?? []) as never).stability ?? "unrated";
      for (const lookup of [offer.vendor, toSlug(offer.vendor)]) {
        if (index.of(lookup) !== expected) disagree.push(`${lookup}: index says ${index.of(lookup)}, the record publishes ${expected}`);
      }
    }
    assert.deepStrictEqual(disagree.slice(0, 10), []);
    assertCoversPopulation(seen.size, vendorsInTheCatalogue(), "vendors swept for a lookup by name and by slug");
  });

  it("counts published offers by class, and the counts add up to the catalogue", async () => {
    const { publishedStabilityIndex, loadOffers } = await import("../dist/data.js");
    const byClass = publishedStabilityIndex().offersByClass;
    const total = Object.values(byClass).reduce((sum, n) => sum + n, 0);
    assert.strictEqual(total, loadOffers().length);
  });
});

describe("enrichOffers includes stability", () => {
  it("adds stability field to enriched offers", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");
    const results = searchOffers("database");
    assert.ok(results.length > 0);

    const enriched = enrichOffers(results);
    for (const offer of enriched) {
      assert.ok("stability" in offer, "Should have stability field");
      if (offer.stability === null) {
        assert.ok(
          offer.link_unreachable || offer.rating_withheld || offer.refused_read || offer.gate ||
            (offer.source_check && offer.source_check.outcome !== "ok"),
          `${offer.vendor} publishes no stability class and nothing on the row says why`
        );
        continue;
      }
      assert.ok(
        ["stable", "watch", "volatile", "improving"].includes(offer.stability),
        `stability should be valid, got: ${offer.stability}`
      );
    }
  });
});

describe("searchOffers stability filter", () => {
  it("returns only records whose own row publishes the class that was asked for", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");

    for (const asked of ["stable", "watch", "volatile", "improving"] as const) {
      const results = searchOffers(undefined, undefined, undefined, undefined, asked);
      assert.ok(results.length > 0, `no record matches ${asked}, so this asserts nothing`);
      const contradicts = enrichOffers(results)
        .filter((o) => o.stability !== asked)
        .map((o) => `${o.vendor}: matched ${asked}, publishes ${o.stability}`);
      assert.deepStrictEqual(contradicts.slice(0, 10), []);
    }
  });
});
