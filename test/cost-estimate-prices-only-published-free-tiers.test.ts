import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { estimateCosts } from "../dist/costs.js";
import { loadOffers, loadDealChanges, enrichOffers } from "../dist/data.js";
import { classifyTier, rankForListing } from "../dist/ranking.js";
import { supersededTermsRecordFor } from "../dist/superseded-description.js";
import { substitutesListedFor } from "../dist/vendor-substitutes.js";

const offers = loadOffers();
const changes = loadDealChanges();
const listingOf = new Map<string, any>();
for (const offer of offers) if (!listingOf.has(offer.vendor.toLowerCase())) listingOf.set(offer.vendor.toLowerCase(), offer);
const listings = [...listingOf.values()].sort((a, b) => a.vendor.localeCompare(b.vendor));
const changesNaming = (vendor: string) => changes.filter((c: any) => c.vendor.toLowerCase() === vendor.toLowerCase());
const withheldRecordOf = (offer: any) => supersededTermsRecordFor(offer, changesNaming(offer.vendor));
const tierClassOf = (offer: any) => classifyTier(offer.tier);
const isFree = (offer: any) => tierClassOf(offer).class === "free";
const freeWithPublishedTerms = listings.filter((o) => isFree(o) && !withheldRecordOf(o));
const freeWithWithheldTerms = listings.filter((o) => isFree(o) && withheldRecordOf(o));
const ofClass = (tierClass: string) => listings.filter((o) => tierClassOf(o).class === tierClass);
const UNLISTED = "NoSuchVendorInTheIndex";
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_CONDITION = { text: "Free projects pause after 7 days idle.", quote: "Free projects pause after 7 days idle.", url: "https://example.com/terms", read_on: "2026-09-01" };

function estimateWithConditionsAddedTo(vendors: string[]): any {
  const shipped = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
  const pending = new Set(vendors);
  const offersWithConditions = shipped.offers.map((offer: any) => {
    if (!pending.delete(offer.vendor)) return offer;
    return { ...offer, conditions: [FIXTURE_CONDITION] };
  });
  const dir = mkdtempSync(path.join(tmpdir(), "cost-estimate-conditions-"));
  try {
    const indexPath = path.join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify({ ...shipped, offers: offersWithConditions }));
    const script = `import { estimateCosts } from ${JSON.stringify(path.join(REPO, "dist", "costs.js"))}; process.stdout.write(JSON.stringify(estimateCosts(${JSON.stringify(vendors)})));`;
    return JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { env: { ...process.env, AGENTDEALS_INDEX_PATH: indexPath }, encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const SAVINGS_BESIDE_ALTERNATIVES = "Not estimated. free_alternative names a substitute with an ongoing free tier where we list one.";

function expectedEstimate(offer: any, scale: string): string {
  const tierClass = tierClassOf(offer);
  if (tierClass.class !== "free") return `Not estimated: tier "${offer.tier}" is ${tierClass.note}.`;
  if (withheldRecordOf(offer)) return `Not estimated: we are not publishing our stored ${offer.vendor} terms.`;
  if (scale === "hobby") return "$0 (within free tier)";
  return `Not estimated: we do not price usage above the free tier. Prices: ${offer.url}`;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function untiedBestFreeSubstitute(vendor: string): string | undefined {
  const ranked = rankForListing(enrichOffers(substitutesListedFor(vendor, changes, offers)), { queryKey: `alternative-to:${vendor}`, changes })
    .entries.filter((e: any) => !e.gate && isFree(e.offer) && !withheldRecordOf(e.offer));
  if (ranked.length === 0) return undefined;
  const fewest = Math.min(...ranked.map((e: any) => e.demerit_total));
  const best = ranked.filter((e: any) => e.demerit_total === fewest);
  return best.length === 1 ? best[0].offer.vendor : undefined;
}

describe("the cost estimate prices only an ongoing free tier whose terms we publish", () => {
  it("states every listing's estimate from its tier class and whether we withhold its terms, at every scale", () => {
    assertPopulationFloor(freeWithPublishedTerms.length, 1000, "listings with an ongoing free tier and published terms");
    assertPopulationFloor(freeWithWithheldTerms.length, 10, "listings with an ongoing free tier whose terms we withhold");
    assertPopulationFloor(ofClass("not_free").length, 10, "listings with no free tier");
    assertPopulationFloor(ofClass("time_limited").length, 10, "listings whose free offer runs out");
    assertPopulationFloor(ofClass("retired").length, 10, "listings the vendor has ended");
    for (const scale of ["hobby", "startup", "growth"]) {
      const wrong = estimateCosts(listings.map((o) => o.vendor), scale as any).services
        .filter((s: any) => s.estimated_monthly_cost !== expectedEstimate(listingOf.get(s.vendor.toLowerCase()), scale))
        .map((s: any) => `${scale} ${s.vendor}: ${s.estimated_monthly_cost}`);
      assert.deepEqual(wrong.slice(0, 10), []);
    }
  });

  it("totals a mixed stack as $0 for the services it prices and names the reason for each one it does not", () => {
    const free = freeWithPublishedTerms[0];
    const notFree = ofClass("not_free")[0];
    const trial = ofClass("time_limited")[0];
    const ended = ofClass("retired")[0];
    const storedWithheld = freeWithWithheldTerms[0];
    const result = estimateCosts([free.vendor, notFree.vendor, trial.vendor, ended.vendor, storedWithheld.vendor, UNLISTED]);
    assert.equal(
      result.total_estimated_cost,
      `$0/mo for 1 of 6 services (${free.vendor}), within their free tiers. Not estimated: ` +
        `${notFree.vendor} (${tierClassOf(notFree).note}), ${trial.vendor} (${tierClassOf(trial).note}), ` +
        `${ended.vendor} (${tierClassOf(ended).note}), ${storedWithheld.vendor} (stored terms withheld), ${UNLISTED} (not in our index).`,
    );
    assert.equal(result.savings_available, SAVINGS_BESIDE_ALTERNATIVES);
  });

  it("gives only the not-estimated sentence when it prices no service at $0", () => {
    const notFree = ofClass("not_free")[0];
    const trial = ofClass("time_limited")[0];
    const result = estimateCosts([notFree.vendor, trial.vendor]);
    assert.equal(result.total_estimated_cost, `Not estimated: ${notFree.vendor} (${tierClassOf(notFree).note}), ${trial.vendor} (${tierClassOf(trial).note}).`);
    assert.equal(result.savings_available, SAVINGS_BESIDE_ALTERNATIVES);
  });

  it("keeps the all-free lines when it prices every service at $0", () => {
    const result = estimateCosts(freeWithPublishedTerms.slice(0, 2).map((o) => o.vendor));
    assert.equal(result.total_estimated_cost, "$0/mo (all within free tiers)");
    assert.equal(result.savings_available, "$0 — already on free tiers");
  });

  it("states no price range at startup or growth scale", () => {
    const stack = [freeWithPublishedTerms[0].vendor, ofClass("not_free")[0].vendor, UNLISTED];
    for (const scale of ["startup", "growth"]) {
      const result = estimateCosts(stack, scale as any);
      assert.equal(result.total_estimated_cost, `Not estimated at ${scale} scale: we do not price usage above free tiers.`);
      assert.equal(result.savings_available, "Not estimated.");
      assert.doesNotMatch(JSON.stringify(result), /\$\d+\s*-\s*\d+/);
    }
  });

  it("withholds the stored terms of every listing whose terms we do not publish", () => {
    const withheld = listings.filter((o) => withheldRecordOf(o));
    assertPopulationFloor(withheld.length, 10, "listings whose stored terms we withhold");
    for (const scale of ["hobby", "startup"]) {
      const result = estimateCosts(withheld.map((o) => o.vendor), scale as any);
      const leaked = result.services.filter((s: any) => {
        const offer = listingOf.get(s.vendor.toLowerCase());
        const { free_alternative: _substitute, ...ownFields } = s;
        return s.free_tier_limits !== withheldRecordOf(offer)!.notice || "conditions" in s || stringsIn(ownFields).some((text) => text.includes(offer.description.slice(0, 120)));
      }).map((s: any) => `${scale} ${s.vendor}`);
      assert.deepEqual(leaked.slice(0, 10), []);
      const warnedFromStoredTerms = result.warnings.filter((w: string) => /free tier has low|free tier limited to|storage is under 1 GB/.test(w));
      assert.deepEqual(warnedFromStoredTerms, []);
    }
  });

  it("prints no conditions beside a listing whose terms it withholds, even when the listing holds some", () => {
    const withheld = freeWithWithheldTerms[0];
    const published = freeWithPublishedTerms.find((o) => !o.conditions?.length)!;
    const [withheldService, publishedService] = estimateWithConditionsAddedTo([withheld.vendor, published.vendor]).services;
    assert.equal(withheldService.free_tier_limits, withheldRecordOf(withheld)!.notice);
    assert.ok(!("conditions" in withheldService), JSON.stringify(withheldService.conditions));
    assert.equal(publishedService.conditions?.[0]?.text, FIXTURE_CONDITION.text);
  });

  it("warns about free-tier limits only for a free tier it prices", () => {
    const unpriced = listings.filter((o) => !isFree(o));
    const warned = estimateCosts(unpriced.map((o) => o.vendor), "growth").warnings
      .filter((w: string) => /free tier has low|free tier limited to|storage is under 1 GB/.test(w));
    assert.deepEqual(warned, []);
  });

  it("names a free alternative only when it is the single best-ranked free substitute with published terms", () => {
    const withSubstitutes = listings.filter((o) => substitutesListedFor(o.vendor, changes, offers).length > 0);
    const mismatched: string[] = [];
    let named = 0;
    let tiedOrNone = 0;
    for (const offer of withSubstitutes) {
      const expected = untiedBestFreeSubstitute(offer.vendor);
      const got = estimateCosts([offer.vendor], "startup").services[0].free_alternative?.vendor;
      if (expected === undefined) tiedOrNone++; else named++;
      if (got !== expected) mismatched.push(`${offer.vendor}: named ${got ?? "none"}, expected ${expected ?? "none"}`);
    }
    assertPopulationFloor(named, 10, "listings whose best free substitute is untied");
    assertPopulationFloor(tiedOrNone, 50, "listings whose best free substitutes tie");
    assert.deepEqual(mismatched.slice(0, 10), []);
  });

  it("offers no alternative at hobby scale beside a service it prices at $0", () => {
    const named = estimateCosts(freeWithPublishedTerms.map((o) => o.vendor)).services.filter((s: any) => s.free_alternative);
    assert.deepEqual(named.map((s: any) => s.vendor), []);
  });
});
