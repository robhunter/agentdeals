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

  // #1038: these two tests used to assert the count-based rule directly — "1
  // change = caution, 2+ = risky". That rule is the defect: it counted records
  // we happened to have written, so `limits_increased` demoted a vendor and a
  // vendor we had never examined rendered stable. What replaces them asserts
  // the property the rule is supposed to have.
  it("counts nothing — the number of records a vendor has cannot move its risk level", async () => {
    const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const offers = loadOffers();

    const counts = new Map<string, number>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // A vendor with several records, none of them demoting, must stay stable.
    const FAVOURABLE = new Set(["limits_increased", "new_free_tier", "new_tier", "startup_program_expanded", "pricing_postponed", "rebranded"]);
    const byVendor = new Map<string, { change_type: string }[]>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(c);
    }

    let checked = 0;
    for (const [vendor, vendorChanges] of byVendor) {
      if (!vendorChanges.every((c) => FAVOURABLE.has(c.change_type))) continue;
      const offer = offers.find((o: { vendor: string }) => o.vendor.toLowerCase() === vendor);
      if (!offer) continue;
      const enriched = enrichOffers([offer])[0];
      assert.strictEqual(
        enriched.risk_level,
        "stable",
        `${offer.vendor} has ${vendorChanges.length} record(s), all favourable or neutral (${vendorChanges.map((c) => c.change_type).join(", ")}), and must not be warned`,
      );
      assert.strictEqual(enriched.risk_cause, null);
      checked++;
    }
    assert.ok(checked > 0, "expected at least one vendor whose whole history is favourable");
  });

  it("a vendor whose only record is limits_increased renders stable", async () => {
    const { enrichOffers } = await import("../dist/data.js");
    const offer = {
      vendor: "Testing Vendor 1038", category: "Databases", tier: "Free", description: "d",
      url: "https://example.com", verifiedDate: "2026-08-01", tags: [],
    };
    // enrichOffers reads the live change file, so assert through the function
    // that decides, with the record the issue is named for.
    const { vendorRiskAssessment } = await import("../dist/data.js");
    const assessment = vendorRiskAssessment([
      { vendor: "Testing Vendor 1038", change_type: "limits_increased", date: "2026-08-01", summary: "Free tier expanded", previous_state: "", current_state: "", impact: "high", source_url: "", category: "Databases", alternatives: [] },
    ]);
    assert.strictEqual(assessment.level, "stable");
    assert.strictEqual(assessment.cause, null);
    assert.strictEqual(enrichOffers([offer])[0].risk_level, "stable");
  });

  it("never publishes a risk level it cannot name a cause for", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const enriched = enrichOffers(loadOffers());
    const uncaused = enriched.filter((o: { risk_level: string | null; risk_cause: unknown }) => o.risk_level !== "stable" && !o.risk_cause);
    assert.strictEqual(uncaused.length, 0, `${uncaused.length} offers carry a warning with no cause`);
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
