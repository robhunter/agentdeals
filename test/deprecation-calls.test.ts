import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import type { DealChange } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { deprecationCall, deprecationCallIsRecorded, endsAFreeTier } = await import("../dist/product-deprecation.js");
const { demotionForChange, demotionWithheldForNoSource, isSevereChange, loadDealChanges } = await import("../dist/data.js");
const { narrowingChanges } = await import("../dist/vendor-verdict.js");
const { isNoLongerInForce } = await import("../dist/change-resolution.js");
const { toSlug } = await import("../dist/vendor-slug.js");

function deprecation(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Fixture Cloud",
    change_type: "product_deprecated",
    date: "2026-06-01",
    date_source: "vendor_page",
    summary: "Fixture Cloud's Sidecar service is being retired.",
    previous_state: "Sidecar available",
    current_state: "Sidecar retired",
    impact: "medium",
    source_url: "https://fixture.example/changelog",
    category: "Cloud Hosting",
    alternatives: [],
    ...over,
  } as DealChange;
}

function demotionOf(change: DealChange): "risky" | "caution" | null {
  return demotionForChange(change) ?? demotionWithheldForNoSource(change);
}

describe("a deprecation's effect on the listing is one call, read the same way everywhere", () => {
  it("counts a deprecation called as ending the listing as a free tier removed", () => {
    const ends = deprecation({ listing_effect: "ends" });
    assert.strictEqual(endsAFreeTier(ends), true);
    assert.strictEqual(demotionForChange(ends), "risky");
    assert.strictEqual(isSevereChange(ends), true);
    assert.strictEqual(narrowingChanges([ends], null).length, 1);
  });

  it("counts a deprecation called as narrowing the listing as a narrowing, never as a removal", () => {
    const narrows = deprecation({ listing_effect: "narrows" });
    assert.strictEqual(endsAFreeTier(narrows), false);
    assert.strictEqual(demotionForChange(narrows), "caution");
    assert.strictEqual(isSevereChange(narrows), false);
    assert.strictEqual(narrowingChanges([narrows], null).length, 1);
  });

  it("counts a deprecation called as touching nothing the listing states as neither", () => {
    const none = deprecation({ listing_effect: "none", summary: "Fixture Cloud is being shut down." });
    assert.strictEqual(deprecationCall({ ...none, listing_effect: undefined }), "ends", "the text alone reads as an ending, so this proves nothing");
    assert.strictEqual(endsAFreeTier(none), false);
    assert.strictEqual(demotionForChange(none), null);
    assert.strictEqual(narrowingChanges([none], null).length, 0);
  });

  it("falls back to the record's own text when no call is recorded", () => {
    const retiresTheProduct = deprecation({ summary: "Fixture Cloud is being shut down." });
    const retiresAnother = deprecation();
    assert.strictEqual(deprecationCallIsRecorded(retiresTheProduct), false);
    assert.strictEqual(deprecationCall(retiresTheProduct), "ends");
    assert.strictEqual(deprecationCall(retiresAnother), "none");
    assert.strictEqual(narrowingChanges([retiresAnother], null).length, 0);
  });

  it("ignores a call that is not one of the three", () => {
    const misspelt = deprecation({ listing_effect: "ended" as never });
    assert.strictEqual(deprecationCallIsRecorded(misspelt), false);
    assert.strictEqual(deprecationCall(misspelt), "none");
  });
});

describe("every deprecation in the change log gets the same answer from the narrowing count and the verdict", () => {
  it("agrees for each in-force product_deprecated record, and states how many carry no call", (t) => {
    const deprecations = loadDealChanges().filter(
      (c: DealChange) => c.change_type === "product_deprecated" && !isNoLongerInForce(c),
    );
    assertPopulationFloor(deprecations.length, 1, "in-force product_deprecated records");
    const disagreeing = deprecations
      .filter((c: DealChange) => (narrowingChanges([c], null).length === 1) !== (demotionOf(c) !== null))
      .map((c: DealChange) => `${c.vendor} ${c.date}`);
    assert.deepStrictEqual(disagreeing, [], "the narrowing count and the verdict disagree on a deprecation");
    const uncalled = deprecations.filter((c: DealChange) => !deprecationCallIsRecorded(c));
    t.diagnostic(`${deprecations.length} in-force deprecations; ${uncalled.length} carry no call and are read from their text`);
  });
});

describe("a vendor page counts no deprecation called as touching nothing the listing states", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    proc = child;
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
  });

  after(() => { proc?.kill(); });

  it("dates no narrowing sentence to a deprecation of another product", async () => {
    const log = loadDealChanges();
    const calledNone = log.filter(
      (c: DealChange) => c.change_type === "product_deprecated" && c.listing_effect === "none" && !isNoLongerInForce(c),
    );
    const vendors = [...new Set(calledNone.map((c: DealChange) => c.vendor))] as string[];
    assertPopulationFloor(vendors.length, 1, "vendors holding a deprecation called as touching nothing the listing states");

    const misdated: string[] = [];
    let sentences = 0;
    for (const vendor of vendors) {
      for (const route of [`/vendor/${toSlug(vendor)}`, `/alternative-to/${toSlug(vendor)}`]) {
        const res = await fetch(`http://localhost:${port}${route}`);
        if (res.status !== 200) continue;
        const text = (await res.text()).replace(/<[^>]+>/g, " ");
        const sentence = text.match(/(?:One recorded [^.]*|\d+ recorded changes) narrowed the terms[^.]*\./)?.[0];
        if (!sentence) continue;
        sentences++;
        for (const c of calledNone.filter((r: DealChange) => r.vendor === vendor)) {
          if (sentence.includes(c.date) && !log.some((r: DealChange) => r.vendor === vendor && r.date === c.date && r !== c && r.change_type !== "product_deprecated")) {
            misdated.push(`${route}: ${sentence}`);
          }
        }
      }
    }
    assertPopulationFloor(sentences, 1, "narrowing sentences read on those vendors' pages");
    assert.deepStrictEqual(misdated, [], "a narrowing sentence is dated by a deprecation of another product");
  });
});
