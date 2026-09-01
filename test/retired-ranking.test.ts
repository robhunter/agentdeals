import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { offerEnded, offerRetired, ENDED_TIERS } = await import("../dist/retirement.js");
const { classifyTier, gateFor, rankOffers } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const dealChanges: DealChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

const TODAY = "2026-09-01";

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function baseOffer(over: Partial<Offer> = {}): Offer {
  return {
    vendor: "Acme",
    category: "Databases",
    description: "A free tier.",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: [],
    verifiedDate: TODAY,
    ...over,
  };
}

function rankCategory(categoryName: string) {
  return rankOffers(offers.filter(o => o.category === categoryName), {
    queryKey: `best-of:${categoryName}`,
    changes: dealChanges,
    date: TODAY,
  });
}

const endedRecords = offers.filter(o => offerEnded(o));
const categoriesWithAnEndedRecord = [...new Set(endedRecords.map(o => o.category))];

let port = 0;
let proc: ChildProcess | null = null;
const pages = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function page(pathname: string): Promise<string> {
  const cached = pages.get(pathname);
  if (cached !== undefined) return cached;
  const res = await fetch(`http://localhost:${port}${pathname}`);
  const body = await res.text();
  pages.set(pathname, body);
  return body;
}

let bestOfPaths: string[] = [];

before(async () => {
  proc = await startServer();
  const index = await page("/best");
  bestOfPaths = [...new Set([...index.matchAll(/href="(\/best\/[a-z0-9-]+)"/g)].map(m => m[1]))].sort();
  for (const p of bestOfPaths) await page(p);
  for (const o of endedRecords) await page(`/vendor/${slugOf(o.vendor)}`);
  await page("/sitemap-vendors.xml");
  await page("/criteria");
});

after(() => { proc?.kill(); });

describe("a tier that records the offer as ended is gated, not ranked", () => {
  it("has a subject in the index", () => {
    assert.ok(endedRecords.length > 0, "no record carries an ended tier, so this file has no subject");
  });

  it("gives the ended tier its own class instead of the free fall-through", () => {
    for (const tier of ENDED_TIERS) {
      assert.strictEqual(classifyTier(tier).class, "retired", `${tier} still reaches a rule table or the default`);
    }
    assert.strictEqual(classifyTier("Free").class, "free");
  });

  it("gates a record whose tier records the offer as ended", () => {
    const gate = gateFor(baseOffer({ tier: "Retired" }), TODAY);
    assert.strictEqual(gate?.code, "offer_retired");
    assert.match(gate!.reason, /Retired/);
  });

  it("does not gate a deprecated offer that is still being served", () => {
    assert.strictEqual(gateFor(baseOffer({ tier: "Free (Deprecated)" }), TODAY), null);
    assert.strictEqual(classifyTier("Free (Deprecated)").class, "free");
  });

  it("reads the ended tier ahead of an eligibility restriction on the same record", () => {
    const both = baseOffer({ tier: "Retired", eligibility: { type: "student", conditions: ["enrolled"] } });
    assert.strictEqual(gateFor(both, TODAY)?.code, "offer_retired");
    assert.strictEqual(gateFor(baseOffer({ eligibility: { type: "student", conditions: ["enrolled"] } }), TODAY)?.code, "eligibility_restricted");
  });

  it("reads the whole tier string, not a word inside it", () => {
    assert.ok(offerEnded({ tier: "Retired" }));
    assert.ok(offerEnded({ tier: "  retired  " }));
    for (const tier of ["Free (Sunset 2026)", "Free until sunset", "Retired Plan Migration Credit", "Not Discontinued"]) {
      assert.ok(!offerEnded({ tier }), `"${tier}" was read as an ended offer`);
      assert.notStrictEqual(gateFor(baseOffer({ tier }), TODAY)?.code, "offer_retired");
    }
  });

  it("is narrower than the predicate the vendor page uses to withhold a link", () => {
    const withheldFromLinking = offers.filter(o => offerRetired(o));
    const gated = offers.filter(o => offerEnded(o));
    assert.ok(gated.length < withheldFromLinking.length, "the gate predicate is not narrower than offerRetired");
    for (const o of gated) {
      assert.ok(offerRetired(o), `${o.vendor} is gated but not read as retired on its own page`);
    }
  });
});

describe("the ended records leave the ranked set and nothing else does", () => {
  it("excludes every ended record from its category's qualified set", () => {
    for (const record of endedRecords) {
      const ranking = rankCategory(record.category);
      const qualified = ranking.qualified.map(e => e.offer.vendor);
      assert.ok(!qualified.includes(record.vendor), `${record.vendor} still qualifies in ${record.category}`);
      const excluded = ranking.excluded.find(e => e.offer.vendor === record.vendor);
      assert.strictEqual(excluded?.gate.code, "offer_retired", `${record.vendor} left qualified for another reason`);
    }
  });

  it("gates no record the ended vocabulary does not name", () => {
    for (const categoryName of [...new Set(offers.map(o => o.category))]) {
      for (const entry of rankCategory(categoryName).excluded) {
        if (entry.gate.code !== "offer_retired") continue;
        assert.ok(
          offerEnded(entry.offer),
          `${entry.offer.vendor} was gated as retired on tier "${entry.offer.tier}"`,
        );
      }
    }
  });

  it("demerits a still-served deprecated offer rather than gating it", () => {
    const deprecated = offers.find(o => o.tier === "Free (Deprecated)");
    assert.ok(deprecated, "no record carries a deprecated-but-served tier, so this control has no subject");
    const ranking = rankCategory(deprecated!.category);
    assert.ok(
      !ranking.excluded.some(e => e.offer.vendor === deprecated!.vendor),
      `${deprecated!.vendor} was gated with the ended records`,
    );
    const entry = ranking.demoted.find(e => e.offer.vendor === deprecated!.vendor);
    assert.ok(entry, `${deprecated!.vendor} carries no demerit for its deprecation`);
    assert.ok(entry!.demerits.some(d => d.code === "free_tier_withdrawn"));
  });

  it("removes exactly one record from each affected category and none from the others", () => {
    for (const categoryName of [...new Set(offers.map(o => o.category))]) {
      const ranking = rankCategory(categoryName);
      const retiredHere = ranking.excluded.filter(e => e.gate.code === "offer_retired").length;
      const endedHere = offers.filter(o => o.category === categoryName && offerEnded(o)).length;
      assert.strictEqual(retiredHere, endedHere, `${categoryName} gated ${retiredHere} records as retired, data holds ${endedHere}`);
      assert.strictEqual(
        ranking.qualified.length + ranking.demoted.length + ranking.excluded.length,
        offers.filter(o => o.category === categoryName).length,
      );
    }
  });
});

describe("the best-of pages count what they list", () => {
  it("names no ended record on any best-of page", async () => {
    for (const p of bestOfPaths) {
      const html = await page(p);
      for (const record of endedRecords) {
        assert.ok(!html.includes(`>${record.vendor}</a>`), `${p} still lists ${record.vendor}`);
      }
    }
  });

  it("ledes with the number of picks it actually renders", async () => {
    let checked = 0;
    for (const p of bestOfPaths) {
      const html = await page(p);
      const lede = /<div class="tie-note">.*?<strong>(\d+) offers? meets? our criteria/s.exec(html);
      assert.ok(lede, `${p} has no count in its lede`);
      const cards = [...html.matchAll(/<div class="best-pick">/g)].length;
      assert.strictEqual(Number(lede![1]), cards, `${p} ledes ${lede![1]} and renders ${cards} picks`);
      checked++;
    }
    assert.ok(checked >= categoriesWithAnEndedRecord.length, `only ${checked} best-of pages were checked`);
  });

  it("keeps the vendor page and the sitemap entry for every ended record", async () => {
    const sitemap = await page("/sitemap-vendors.xml");
    for (const record of endedRecords) {
      const slug = slugOf(record.vendor);
      const res = await fetch(`http://localhost:${port}/vendor/${slug}`);
      assert.strictEqual(res.status, 200, `/vendor/${slug} no longer answers`);
      assert.ok(sitemap.includes(`/vendor/${slug}<`), `/vendor/${slug} left sitemap-vendors.xml`);
    }
  });

  it("publishes the new gate code in the criteria page table", async () => {
    const criteria = await page("/criteria");
    assert.match(criteria, /<code>offer_retired<\/code>/);
  });

  it("names every value of the ended vocabulary in the published gate row", async () => {
    const criteria = await page("/criteria");
    const row = /<code>offer_retired<\/code><\/td><td>(.*?)<\/td>/s.exec(criteria);
    assert.ok(row, "the criteria table has no offer_retired row");
    for (const tier of ENDED_TIERS) {
      assert.ok(row![1].includes(tier), `the published row does not name ${tier}`);
    }
  });
});
