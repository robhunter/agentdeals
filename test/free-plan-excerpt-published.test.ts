import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Offer = import("../src/types.ts").Offer;
type FreePlanExcerpt = import("../src/types.ts").FreePlanExcerpt;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

function listing(vendor: string, marker: string, fields: Partial<Offer> = {}): Offer {
  const slug = vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const url = `https://${slug}.example/pricing`;
  return {
    vendor,
    category: "Databases",
    description: `${vendor} free plan: 3 databases and 1 GB of storage.`,
    tier: "Free",
    url,
    tags: ["database"],
    verifiedDate: TODAY,
    source_check: { checked: TODAY, outcome: "ok", detail: `the page names ${vendor} as "${slug}"` },
    free_plan_excerpt: { text: `Free $0/month: 3 databases & 1 GB <${marker}> storage`, url, read_on: TODAY },
    ...fields,
  } as Offer;
}

const EARLIER_READ = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
const LONG_REACHABLE_AGO = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);

const QUOTED = listing("Quoted Excerpt Co", "quoted-excerpt-marker");
const STATES_NO_TERMS = listing("States No Terms Excerpt Co", "states-no-terms-excerpt-marker", {
  source_check: { checked: TODAY, outcome: "states_no_terms", detail: "the page states no plan terms" },
});
const UNREADABLE = listing("Unreadable Excerpt Co", "unreadable-excerpt-marker", {
  source_check: { checked: TODAY, outcome: "unreadable", detail: "the page rendered no text we could read" },
});
UNREADABLE.free_plan_excerpt = { ...UNREADABLE.free_plan_excerpt!, read_on: EARLIER_READ };
const ENDED = listing("Ended Excerpt Co", "ended-excerpt-marker", { tier: "Retired" });
const PAID = listing("Paid Excerpt Co", "paid-excerpt-marker", { tier: "Paid" });
const USAGE_BILLED = listing("Usage Billed Excerpt Co", "usage-billed-excerpt-marker", { tier: "Pay-as-you-go" });
const CLOSED_TO_NEW_ACCOUNTS = listing("Closed Tier Excerpt Co", "closed-tier-excerpt-marker", { tier: "Legacy Free" });
const TRIAL = listing("Trial Excerpt Co", "trial-excerpt-marker", { tier: "Free Trial" });
const SUPERSEDED = listing("Superseded Excerpt Co", "superseded-excerpt-marker");
const REPOINTED = listing("Repointed Excerpt Co", "repointed-excerpt-marker");
REPOINTED.free_plan_excerpt = { ...REPOINTED.free_plan_excerpt!, url: "https://old-address.example/pricing" };
const UNREACHABLE = listing("Unreachable Excerpt Co", "unreachable-excerpt-marker");
const NAMES_NO_VENDOR = listing("Names No Vendor Excerpt Co", "names-no-vendor-excerpt-marker", {
  source_check: { checked: TODAY, outcome: "does_not_name_vendor", detail: "the page names another company" },
});
const NAMES_NO_PRODUCT = listing("Names No Product Excerpt Co", "names-no-product-excerpt-marker", {
  source_check: { checked: TODAY, outcome: "does_not_name_product", detail: "the page names another of the vendor's products" },
});
const HELD_BY_HAND = listing("Held By Hand Excerpt Co", "held-by-hand-excerpt-marker", {
  free_plan_excerpt_hold: { record_date: TODAY, change_type: "restriction", reason: "The page still states the quota this record says ended." },
});

const QUOTED_ON_A_TIER_THAT_RUNS_OUT: [string, Offer, string][] = [
  ["the listed tier is a trial", TRIAL, "trial-excerpt-marker"],
];

const PUBLISHED_THOUGH_UNCONFIRMED: [string, Offer, string][] = [
  ["our last read found no plan terms on the page", STATES_NO_TERMS, "states-no-terms-excerpt-marker"],
  ["our last read could not read the page", UNREADABLE, "unreadable-excerpt-marker"],
];

const WITHHELD: [string, Offer, string][] = [
  ["the listing has ended", ENDED, "ended-excerpt-marker"],
  ["the listed tier is paid", PAID, "paid-excerpt-marker"],
  ["the listed tier is billed by use from the first request", USAGE_BILLED, "usage-billed-excerpt-marker"],
  ["the listed tier is closed to new accounts", CLOSED_TO_NEW_ACCOUNTS, "closed-tier-excerpt-marker"],
  ["a recorded change has superseded the terms", SUPERSEDED, "superseded-excerpt-marker"],
  ["the excerpt was read from a page the record no longer cites", REPOINTED, "repointed-excerpt-marker"],
  ["the cited page is unreachable", UNREACHABLE, "unreachable-excerpt-marker"],
  ["our last read found the page does not name the vendor", NAMES_NO_VENDOR, "names-no-vendor-excerpt-marker"],
  ["our last read found the page does not name the product", NAMES_NO_PRODUCT, "names-no-product-excerpt-marker"],
  ["a hold on the listing names a record the page has outlived", HELD_BY_HAND, "held-by-hand-excerpt-marker"],
];

const SUPERSEDING_CHANGE = {
  vendor: SUPERSEDED.vendor,
  change_type: "limits_reduced",
  date: TODAY,
  summary: `${SUPERSEDED.vendor} cut its free plan to 1 database.`,
  tier: "Free",
  previous_state: SUPERSEDED.description,
  current_state: "1 database and 500 MB of storage",
  impact: "medium",
  source_url: SUPERSEDED.url,
  category: "Databases",
  alternatives: [],
  recorded_date: TODAY,
  date_source: "vendor_page",
};

const UNREACHABLE_LINK = {
  url: UNREACHABLE.url,
  checked: TODAY,
  outcome: "unreachable",
  detail: "GET ENOTFOUND",
  terminal: false,
  last_reachable: LONG_REACHABLE_AGO,
  consecutive_unreachable: 3,
};

const dir = mkdtempSync(path.join(tmpdir(), "free-plan-excerpt-"));
const indexPath = path.join(dir, "index.json");
const changesPath = path.join(dir, "deal_changes.json");
const linkHealthPath = path.join(dir, "link_health.json");
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const SYNTHETIC = [QUOTED, STATES_NO_TERMS, UNREADABLE, ENDED, PAID, USAGE_BILLED, CLOSED_TO_NEW_ACCOUNTS, TRIAL, SUPERSEDED, REPOINTED, UNREACHABLE, NAMES_NO_VENDOR, NAMES_NO_PRODUCT, HELD_BY_HAND];
writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers: [...catalogue.offers, ...SYNTHETIC] }));
const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
writeFileSync(changesPath, JSON.stringify({ ...log, changes: [...log.changes, SUPERSEDING_CHANGE] }));
const linkHealth = JSON.parse(readFileSync(path.join(REPO, "data", "link_health.json"), "utf-8"));
writeFileSync(linkHealthPath, JSON.stringify({ ...linkHealth, links: [...linkHealth.links, UNREACHABLE_LINK] }));

process.env.AGENTDEALS_INDEX_PATH = indexPath;
process.env.AGENTDEALS_CHANGES_PATH = changesPath;
process.env.AGENTDEALS_LINK_HEALTH_PATH = linkHealthPath;
const { loadOffers, freePlanExcerptHeldFor, freePlanExcerptHoldOn } = await import("../dist/data.js");

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, port: parseInt(found[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const slugOf = (offer: Offer) => offer.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");

describe("a free-plan excerpt is published only where the vendor page publishes our terms", () => {
  let proc: ChildProcess;
  let base: string;

  before(async () => {
    const started = await startServer();
    proc = started.proc;
    base = `http://localhost:${started.port}`;
  });

  after(() => {
    proc?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  const page = async (offer: Offer) => {
    const res = await fetch(`${base}/vendor/${slugOf(offer)}`);
    assert.strictEqual(res.status, 200, `/vendor/${slugOf(offer)} answered ${res.status}, so it says nothing about the excerpt`);
    return await res.text();
  };
  const offered = async (offer: Offer) => {
    const body = await (await fetch(`${base}/api/offers?q=${encodeURIComponent(offer.vendor)}&limit=50`)).json() as { offers: (Offer & { free_plan_excerpt: FreePlanExcerpt | null })[] };
    const found = body.offers.find((o) => o.vendor === offer.vendor);
    assert.ok(found, `/api/offers did not return ${offer.vendor}`);
    return found;
  };

  it("holds every excerpt and every hold aside when the catalogue loads, so no door serves one unless it asks", () => {
    const loaded = loadOffers() as Offer[];
    assert.deepStrictEqual(loaded.filter((offer) => "free_plan_excerpt" in offer || "free_plan_excerpt_hold" in offer).map((offer) => offer.vendor), []);
    assert.deepStrictEqual(freePlanExcerptHeldFor(QUOTED), QUOTED.free_plan_excerpt);
    assert.deepStrictEqual(freePlanExcerptHoldOn(HELD_BY_HAND), HELD_BY_HAND.free_plan_excerpt_hold);
    assert.strictEqual(freePlanExcerptHoldOn(QUOTED), null);
  });

  it("serves no hold in /api/offers", async () => {
    assert.ok(!("free_plan_excerpt_hold" in await offered(HELD_BY_HAND)), "/api/offers serves the hold");
  });

  it("quotes the vendor's own words on its page, attributed to the page and the day we read it", async () => {
    const html = await page(QUOTED);
    assert.ok(html.includes(`From quoted-excerpt-co.example/pricing, read ${TODAY}:`), "the excerpt is not attributed to the page and the day we read it");
    assert.ok(html.includes("Free $0/month: 3 databases &amp; 1 GB &lt;quoted-excerpt-marker&gt; storage"), "the excerpt is not quoted as the page words it");
    assert.ok(!html.includes("<quoted-excerpt-marker>"), "the excerpt reaches the page unescaped");
  });

  it("places the quotation after the line that says our figures are from our own record", async () => {
    const html = await page(QUOTED);
    const sourceLine = html.indexOf('class="free-tier-source-line"');
    const quotation = html.indexOf('class="free-plan-excerpt"');
    assert.ok(sourceLine > 0 && quotation > sourceLine, "the quotation sits between our figures and the line that says where they come from");
  });

  it("carries the excerpt as a field on the offer in /api/offers", async () => {
    assert.deepStrictEqual((await offered(QUOTED)).free_plan_excerpt, QUOTED.free_plan_excerpt);
  });

  for (const [reason, offer, marker] of QUOTED_ON_A_TIER_THAT_RUNS_OUT) {
    it(`quotes the excerpt where ${reason}`, async () => {
      assert.ok((await page(offer)).includes(`&lt;${marker}&gt;`), `/vendor/${slugOf(offer)} withholds the excerpt where ${reason}`);
      assert.deepStrictEqual((await offered(offer)).free_plan_excerpt, offer.free_plan_excerpt);
    });
  }

  for (const [reason, offer, marker] of PUBLISHED_THOUGH_UNCONFIRMED) {
    it(`quotes the excerpt under the day it was read where ${reason}, and leaves our own figures uncited`, async () => {
      const html = await page(offer);
      const excerpt = offer.free_plan_excerpt!;
      assert.ok(html.includes(`&lt;${marker}&gt;`), `/vendor/${slugOf(offer)} withholds the excerpt where ${reason}`);
      assert.ok(html.includes(`, read ${excerpt.read_on}:`), `/vendor/${slugOf(offer)} does not attribute the excerpt to the day it was read`);
      assert.ok(!html.includes('class="free-tier-source-line"'), `/vendor/${slugOf(offer)} cites a source for terms its last read could not confirm`);
      assert.deepStrictEqual((await offered(offer)).free_plan_excerpt, excerpt);
    });
  }

  for (const [reason, offer, marker] of WITHHELD) {
    it(`withholds the excerpt from the page and from /api/offers where ${reason}`, async () => {
      assert.ok(!(await page(offer)).includes(marker), `/vendor/${slugOf(offer)} quotes an excerpt where ${reason}`);
      assert.strictEqual((await offered(offer)).free_plan_excerpt, null);
    });
  }

  it("serves the excerpt through no other door", async () => {
    const doors = [
      `/api/details/${encodeURIComponent(QUOTED.vendor)}`,
      `/api/vendor-risk/${encodeURIComponent(QUOTED.vendor)}`,
      `/api/compare?a=${encodeURIComponent(QUOTED.vendor)}&b=${encodeURIComponent(REPOINTED.vendor)}`,
    ];
    for (const door of doors) {
      const res = await fetch(`${base}${door}`);
      assert.strictEqual(res.status, 200, `${door} answered ${res.status}, so it says nothing about the excerpt`);
      assert.ok((await res.text()).includes(QUOTED.vendor), `${door} does not answer for ${QUOTED.vendor}`);
    }
    const serving: string[] = [];
    for (const door of doors) {
      if ((await (await fetch(`${base}${door}`)).text()).includes("quoted-excerpt-marker")) serving.push(door);
    }
    assert.deepStrictEqual(serving, [], "doors that serve the excerpt");
  });
});
