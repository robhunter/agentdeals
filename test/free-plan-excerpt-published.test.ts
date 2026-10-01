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

const QUOTED = listing("Quoted Excerpt Co", "quoted-excerpt-marker");
const UNCONFIRMED = listing("Unconfirmed Excerpt Co", "unconfirmed-excerpt-marker", {
  source_check: { checked: TODAY, outcome: "states_no_terms", detail: "the page states no plan terms" },
});
const SUPERSEDED = listing("Superseded Excerpt Co", "superseded-excerpt-marker");
const REPOINTED = listing("Repointed Excerpt Co", "repointed-excerpt-marker");
REPOINTED.free_plan_excerpt = { ...REPOINTED.free_plan_excerpt!, url: "https://old-address.example/pricing" };

const WITHHELD: [string, Offer, string][] = [
  ["our last read could not confirm the terms", UNCONFIRMED, "unconfirmed-excerpt-marker"],
  ["a recorded change has superseded the terms", SUPERSEDED, "superseded-excerpt-marker"],
  ["the excerpt was read from a page the record no longer cites", REPOINTED, "repointed-excerpt-marker"],
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

const dir = mkdtempSync(path.join(tmpdir(), "free-plan-excerpt-"));
const indexPath = path.join(dir, "index.json");
const changesPath = path.join(dir, "deal_changes.json");
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers: [...catalogue.offers, QUOTED, UNCONFIRMED, SUPERSEDED, REPOINTED] }));
const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
writeFileSync(changesPath, JSON.stringify({ ...log, changes: [...log.changes, SUPERSEDING_CHANGE] }));

process.env.AGENTDEALS_INDEX_PATH = indexPath;
process.env.AGENTDEALS_CHANGES_PATH = changesPath;
const { loadOffers, freePlanExcerptHeldFor } = await import("../dist/data.js");

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

  const page = async (offer: Offer) => await (await fetch(`${base}/vendor/${slugOf(offer)}`)).text();
  const offered = async (offer: Offer) => {
    const body = await (await fetch(`${base}/api/offers?q=${encodeURIComponent(offer.vendor)}&limit=50`)).json() as { offers: (Offer & { free_plan_excerpt: FreePlanExcerpt | null })[] };
    const found = body.offers.find((o) => o.vendor === offer.vendor);
    assert.ok(found, `/api/offers did not return ${offer.vendor}`);
    return found;
  };

  it("holds every excerpt aside when the catalogue loads, so no door serves one unless it asks", () => {
    const loaded = loadOffers() as Offer[];
    assert.deepStrictEqual(loaded.filter((offer) => "free_plan_excerpt" in offer).map((offer) => offer.vendor), []);
    assert.deepStrictEqual(freePlanExcerptHeldFor(QUOTED), QUOTED.free_plan_excerpt);
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
    for (const door of doors) {
      assert.ok(!(await (await fetch(`${base}${door}`)).text()).includes("quoted-excerpt-marker"), `${door} serves the excerpt`);
    }
  });
});
