import { describe, it } from "node:test";
import assert from "node:assert";
import { assertCoversPopulation, recordsInTheCatalogue } from "./population-floor.ts";

const CLASSES = ["stable", "watch", "volatile", "improving"] as const;

async function catalogue() {
  const { loadOffers, loadDealChanges, enrichOffers } = await import("../dist/data.js");
  return { offers: loadOffers(), changes: loadDealChanges(), rows: enrichOffers(loadOffers()) };
}

describe("a record we decline to rate cannot be returned as one we rate", () => {
  it("returns nothing whose own row publishes no stability class", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");
    let matched = 0;
    for (const asked of CLASSES) {
      const rows = enrichOffers(searchOffers(undefined, undefined, undefined, undefined, asked));
      matched += rows.length;
      const withheld = rows.filter((o) => o.stability === null).map((o) => o.vendor);
      assert.deepStrictEqual(withheld.slice(0, 10), [], `${asked} returned ${withheld.length} records whose row publishes no class`);
    }
    assert.ok(matched > 0, "no record matches any class, so this asserts nothing");
  });

  it("returns no record whose pricing page we cannot reach", async () => {
    const { searchOffers, enrichOffers } = await import("../dist/data.js");
    const unreachable: string[] = [];
    for (const asked of CLASSES) {
      for (const row of enrichOffers(searchOffers(undefined, undefined, undefined, undefined, asked))) {
        if (row.link_unreachable) unreachable.push(`${row.vendor} (${asked})`);
      }
    }
    assert.deepStrictEqual(unreachable.slice(0, 10), []);
  });

  it("never matches a vendor on the strength of holding no change record for it", async () => {
    const { searchOffers, publishedRisk } = await import("../dist/data.js");
    const { changes } = await catalogue();
    const held = new Set(changes.map((c) => c.vendor.toLowerCase()));
    const byVendor = new Map<string, typeof changes>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(c);
    }
    const wrong: string[] = [];
    let checked = 0;
    for (const offer of searchOffers(undefined, undefined, undefined, undefined, "stable")) {
      if (held.has(offer.vendor.toLowerCase())) continue;
      checked++;
      const risk = publishedRisk(offer, byVendor.get(offer.vendor.toLowerCase()) ?? []);
      if (risk.stability === null || risk.risk_level === null) {
        wrong.push(`${offer.vendor} holds no change record and is withheld, yet matched stable`);
      }
    }
    assert.ok(checked > 0, "every stable match holds a change record, so this asserts nothing");
    assert.deepStrictEqual(wrong.slice(0, 10), []);
  });
});

describe("the class we publish and the level we publish are withheld by the same reasons", () => {
  it("publishes no favourable class on a record whose level we withhold", async () => {
    const { rows } = await catalogue();
    const favourable = rows
      .filter((row) => row.risk_level === null && (row.stability === "stable" || row.stability === "improving"))
      .map((row) => `${row.vendor}: no rating published, stability ${row.stability}`);
    assertCoversPopulation(rows.length, recordsInTheCatalogue(), "records swept for a withheld level");
    assert.deepStrictEqual(favourable.slice(0, 10), []);
  });

  it("keeps publishing an adverse class, which names a dated change a reader can check", async () => {
    const { rows } = await catalogue();
    const adverse = rows.filter((row) => row.stability === "watch" || row.stability === "volatile");
    assert.ok(adverse.length > 0, "no record publishes an adverse class, so this asserts nothing");
    for (const row of adverse) {
      assert.ok(row.recent_change !== undefined, `${row.vendor} publishes ${row.stability} with no change field`);
    }
  });

  it("withholds a favourable class from a vendor whose only narrowing cites no source", async () => {
    const { withheldStability } = await import("../dist/data.js");
    const nothingWithheld = { link_unreachable: null, refused_read: null, rating_withheld: null, source_check: null, gate: null };
    const uncitedNarrowing = [{
      vendor: "V", change_type: "limits_reduced", date: "2026-06-01",
      summary: "The free plan's limit came down.", source_url: "",
      previous_state: "100GB", current_state: "10GB", impact: "medium", category: "Storage", alternatives: [],
    }];
    assert.strictEqual(withheldStability(nothingWithheld as never, "stable", uncitedNarrowing as never), null);
    assert.strictEqual(withheldStability(nothingWithheld as never, "improving", uncitedNarrowing as never), null);
    assert.strictEqual(withheldStability(nothingWithheld as never, "volatile", uncitedNarrowing as never), "volatile");
  });

  it("says why, on every record whose class is withheld", async () => {
    const { loadOffers, loadDealChanges, publishedRisk } = await import("../dist/data.js");
    const byVendor = new Map<string, ReturnType<typeof loadDealChanges>>();
    for (const c of loadDealChanges()) {
      const key = c.vendor.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(c);
    }
    const silent: string[] = [];
    let withheld = 0;
    for (const offer of loadOffers()) {
      const risk = publishedRisk(offer, byVendor.get(offer.vendor.toLowerCase()) ?? []);
      if (risk.stability !== null) {
        assert.strictEqual(risk.stability_withheld_because, null, `${offer.vendor} publishes a class and a reason it was withheld`);
        continue;
      }
      withheld++;
      if (!risk.stability_withheld_because) silent.push(offer.vendor);
    }
    assert.ok(withheld > 0, "no record withholds its class, so this asserts nothing");
    assert.deepStrictEqual(silent.slice(0, 10), []);
  });
});

describe("the response says how much it held back", () => {
  it("counts the records a stability filter could not return, and says why", async () => {
    const { searchOffers, stabilityWithheldDisclosure, enrichOffers } = await import("../dist/data.js");
    const everything = searchOffers();
    const disclosure = stabilityWithheldDisclosure(everything);
    const withheld = enrichOffers(everything).filter((row) => row.stability === null).length;
    assert.strictEqual(disclosure.stability_withheld, withheld);
    assert.match(disclosure.stability_withheld_summary ?? "", /publish no stability class/);
  });

  it("holds nothing back on a query whose every match publishes a class", async () => {
    const { searchOffers, stabilityWithheldDisclosure } = await import("../dist/data.js");
    const rated = searchOffers(undefined, undefined, undefined, undefined, "watch");
    assert.strictEqual(stabilityWithheldDisclosure(rated).stability_withheld, 0);
    assert.strictEqual(stabilityWithheldDisclosure(rated).stability_withheld_summary, undefined);
  });
});

describe("the filter's other answers are unchanged", () => {
  it("returns the whole catalogue when no class is asked for", async () => {
    const { searchOffers, loadOffers } = await import("../dist/data.js");
    assert.strictEqual(searchOffers().length, loadOffers().length);
  });

  it("returns every record that publishes a class, across the four classes", async () => {
    const { searchOffers, enrichOffers, loadOffers } = await import("../dist/data.js");
    const matched = CLASSES.reduce((sum, asked) => sum + searchOffers(undefined, undefined, undefined, undefined, asked).length, 0);
    const publishing = enrichOffers(loadOffers()).filter((row) => row.stability !== null).length;
    assert.strictEqual(matched, publishing);
  });
});

describe("the tool description describes the filter that ships", () => {
  it("does not promise that an absent change history means no negative changes", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of ["src/server.ts", "src/server-remote.ts"]) {
      const source = readFileSync(path, "utf-8");
      assert.ok(!source.includes("stable=no negative changes,"), `${path} still describes the default this filter no longer applies`);
      assert.match(source, /Offers whose class we withhold/, `${path} does not tell the caller that withheld records match no value`);
    }
  });
});
