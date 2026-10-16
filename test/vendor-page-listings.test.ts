import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { listingBlocksOf } from "./vendor-listing-blocks.ts";
import { vendorsNamedAsUncontradicted } from "./snippet-order.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { vendorsWhoseEveryListingHolds } = await import("../dist/vendor-listings.js");
const { LAST_READ_LABEL, WHAT_THE_LAST_READ_FOUND, lastReadDate, publishedDateValue } = await import("../dist/read-date.js");

const FOUND_A_DIFFERENCE = WHAT_THE_LAST_READ_FOUND.changed;

interface CatalogueListing {
  vendor: string;
  category: string;
  url: string;
  tier: string;
  description: string;
  verifiedDate: string;
}

const listings: CatalogueListing[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const listingsByVendor = new Map<string, CatalogueListing[]>();
for (const listing of listings) {
  const held = listingsByVendor.get(listing.vendor);
  if (held) held.push(listing);
  else listingsByVendor.set(listing.vendor, [listing]);
}

const otherListings = [...listingsByVendor.values()].flatMap(([, ...others]) => others);

const TIER_CARD = /<div class="detail-label">Tier<\/div>\s*<div class="detail-value"[^>]*>([^<]*)<\/div>/;

const termsCellsOf = (categoryPage: string, vendor: string): string[] =>
  categoryPage
    .split("<tr")
    .filter((row) => row.includes(`/vendor/${slugOf(vendor)}"`))
    .map((row) => row.split('<td style="color:var(--text-muted)">')[1]?.split("</td>")[0] ?? "");

const withoutTheContradictionNotice = (cell: string) => cell.split('<span class="listing-read-contradicts"')[0];

interface RunningServer {
  child: ChildProcess;
  port: number;
}

function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function fetchPage(server: RunningServer, p: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${server.port}${p}`);
  return { status: res.status, body: await res.text() };
}

let live: RunningServer | null = null;
const pages = new Map<string, { status: number; body: string }>();

async function get(p: string): Promise<{ status: number; body: string }> {
  const held = pages.get(p);
  if (held) return held;
  const page = await fetchPage(live!, p);
  pages.set(p, page);
  return page;
}

describe("naming the vendors whose every listing passes", () => {
  const listed = [
    { vendor: "Alpha", ok: true },
    { vendor: "Beta", ok: true },
    { vendor: "Alpha", ok: false },
    { vendor: "Gamma", ok: true },
    { vendor: "Gamma", ok: true },
  ];

  it("leaves out a vendor when any one of its listings fails", () => {
    assert.deepStrictEqual(vendorsWhoseEveryListingHolds(listed, (l: { ok: boolean }) => l.ok), ["Beta", "Gamma"]);
  });

  it("names each vendor once, in the order its first listing comes", () => {
    assert.deepStrictEqual(vendorsWhoseEveryListingHolds(listed, () => true), ["Alpha", "Beta", "Gamma"]);
  });

  it("names nobody when nothing passes", () => {
    assert.deepStrictEqual(vendorsWhoseEveryListingHolds(listed, () => false), []);
  });
});

describe("a vendor page holding more than one listing", () => {
  before(async () => { if (!live) live = await startServer(); });
  after(() => { live?.child.kill(); live = null; });

  it("prints every listing the catalogue holds on its vendor's page", async () => {
    const unprinted: string[] = [];
    const stray: string[] = [];
    let blocksRead = 0;
    for (const [vendor, [first, ...others]] of listingsByVendor) {
      const page = await get(`/vendor/${slugOf(vendor)}`);
      if (page.status !== 200) {
        unprinted.push(`${vendor}: /vendor/${slugOf(vendor)} answers ${page.status}`);
        continue;
      }
      const subject = page.body.match(TIER_CARD)?.[1];
      if (subject !== escaped(first.tier)) {
        unprinted.push(`${vendor} ${first.tier}: the page's tier is ${subject ?? "missing"}`);
      }
      const blocks = listingBlocksOf(page.body);
      for (const other of others) {
        const block = blocks.get(escaped(other.url));
        if (!block || block.match(TIER_CARD)?.[1] !== escaped(other.tier)) {
          unprinted.push(`${vendor} ${other.tier} (${other.url})`);
        } else {
          blocksRead++;
        }
      }
      for (const url of blocks.keys()) {
        if (!others.some((other) => escaped(other.url) === url)) stray.push(`/vendor/${slugOf(vendor)} prints ${url}`);
      }
    }
    assert.deepStrictEqual(unprinted, [], `listings that appear on no vendor page: ${unprinted.join("; ")}`);
    assert.deepStrictEqual(stray, [], `vendor pages print a listing the vendor does not hold: ${stray.join("; ")}`);
    assertPopulationFloor(blocksRead, 4, "listings printed beside another listing of the same vendor");
  });

  it("states each other listing's terms, conditions and notices as its category row does", async () => {
    const differ: string[] = [];
    let compared = 0;
    for (const listing of otherListings) {
      const block = listingBlocksOf((await get(`/vendor/${slugOf(listing.vendor)}`)).body).get(escaped(listing.url));
      if (!block) continue;
      const category = await get(`/category/${slugOf(listing.category)}`);
      assert.strictEqual(category.status, 200, `/category/${slugOf(listing.category)} answers ${category.status}`);
      const cells = termsCellsOf(category.body, listing.vendor).map(withoutTheContradictionNotice);
      const own = cells.filter((cell) => cell.startsWith(escaped(listing.description)));
      const candidates = own.length > 0 ? own : cells;
      compared++;
      if (!candidates.some((cell) => cell !== "" && block.includes(`<div class="desc-text">${cell}</div>`))) {
        differ.push(`${listing.vendor} ${listing.tier} (${listing.url})`);
      }
    }
    assertPopulationFloor(compared, 4, "other listings compared with their category rows");
    assert.deepStrictEqual(differ, [], `vendor pages state these listings otherwise than their category rows: ${differ.join("; ")}`);
  });

  it("gives each other listing its own read and catalogue dates", async () => {
    const wrong: string[] = [];
    let dated = 0;
    for (const listing of otherListings) {
      const block = listingBlocksOf((await get(`/vendor/${slugOf(listing.vendor)}`)).body).get(escaped(listing.url));
      if (!block) continue;
      dated++;
      const read = lastReadDate(listing);
      const lastRead = block.split(`<div class="detail-label">${LAST_READ_LABEL}</div>`)[1] ?? "";
      if (!lastRead.includes(`>${read}</div>`)) wrong.push(`${listing.vendor} ${listing.tier}: no ${LAST_READ_LABEL} ${read}`);
      if (!block.includes(`>${publishedDateValue(listing)}</div>`)) {
        wrong.push(`${listing.vendor} ${listing.tier}: no catalogue date ${publishedDateValue(listing)}`);
      }
    }
    assertPopulationFloor(dated, 4, "other listings whose dates were read");
    assert.deepStrictEqual(wrong, [], wrong.join("; "));
  });

  it("says a listing's read found a difference exactly where its category row does", async () => {
    const disagree: string[] = [];
    let compared = 0;
    for (const listing of otherListings) {
      const block = listingBlocksOf((await get(`/vendor/${slugOf(listing.vendor)}`)).body).get(escaped(listing.url));
      if (!block) continue;
      const category = await get(`/category/${slugOf(listing.category)}`);
      const rows = category.body
        .split("<tr")
        .filter((row) => row.includes(`/vendor/${slugOf(listing.vendor)}"`) && row.includes(escaped(listing.description)));
      if (rows.length !== 1) continue;
      const rowSays = rows[0].includes("listing-read-contradicts");
      const blockSays = block.includes(FOUND_A_DIFFERENCE);
      compared++;
      if (rowSays !== blockSays) {
        disagree.push(`${listing.vendor} ${listing.tier}: category row ${rowSays ? "says" : "does not say"}, vendor page ${blockSays ? "says" : "does not say"}`);
      }
    }
    assertPopulationFloor(compared, 4, "other listings whose read the category row and the vendor page both state");
    assert.deepStrictEqual(disagree, [], disagree.join("; "));
  });
});

const metaDescriptionOf = (body: string): string =>
  body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";

const unescaped = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const OUR_READ_DID_NOT_CONFIRM = "our own read did not confirm them";

describe("a category page naming a vendor that holds a second listing there", () => {
  const SECOND_LISTING_URL = "https://second-listing.invalid/terms";
  const SECOND_LISTING_TERMS = "A second listing of the same vendor in the same category.";
  let fixture: RunningServer | null = null;
  let vendor = "";
  let categorySlug = "";
  let namedBefore: string[] = [];

  before(async () => {
    if (!live) live = await startServer();
    const namingEveryone: Array<{ slug: string; named: string[]; countsOurReads: boolean; length: number }> = [];
    for (const slug of [...new Set(listings.map((l) => slugOf(l.category)))]) {
      const page = await get(`/category/${slug}`);
      if (page.status !== 200) continue;
      const description = metaDescriptionOf(page.body);
      const named = vendorsNamedAsUncontradicted(description).map(unescaped);
      if (named.length === 0 || description.endsWith(" and more.")) continue;
      namingEveryone.push({ slug, named, countsOurReads: description.includes(OUR_READ_DID_NOT_CONFIRM), length: description.length });
    }
    namingEveryone.sort((a, b) => Number(b.countsOurReads) - Number(a.countsOurReads) || a.length - b.length);
    for (const { slug, named } of namingEveryone) {
      const alone = named.find((v) => listings.filter((l) => l.vendor === v && slugOf(l.category) === slug).length === 1);
      if (alone) {
        vendor = alone;
        categorySlug = slug;
        namedBefore = named;
        break;
      }
    }
    assert.ok(vendor, "no category page names all its uncontradicted vendors for this fixture to build on");
    const held = listings.find((l) => l.vendor === vendor && slugOf(l.category) === categorySlug)!;
    const refusals: Array<{ vendor: string; refused_date: string }> =
      JSON.parse(readFileSync(path.join(REPO, "data", "change_refusals.json"), "utf-8")).refusals;
    const refusedOn = new Set(refusals.filter((r) => r.vendor === vendor).map((r) => r.refused_date));
    const readOn = [10, 11, 12, 13].map(daysAgo).find((day) => !refusedOn.has(day))!;
    const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    catalogue.offers.push({
      vendor,
      category: held.category,
      tier: "Second Listing",
      url: SECOND_LISTING_URL,
      description: SECOND_LISTING_TERMS,
      verifiedDate: daysAgo(30),
      tags: [],
    });
    const state = JSON.parse(readFileSync(path.join(REPO, "data", "verification_state.json"), "utf-8"));
    state.records.push({
      vendor,
      url: SECOND_LISTING_URL,
      last_attempt_at: readOn,
      last_outcome: "changed",
      last_error: null,
      failure_category: null,
      consecutive_failures: 0,
      last_success: null,
      last_read_at: readOn,
      quarantined_since: null,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "vendor-page-listings-"));
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(catalogue));
    writeFileSync(path.join(dir, "verification_state.json"), JSON.stringify(state));
    fixture = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"),
      AGENTDEALS_VERIFICATION_STATE_PATH: path.join(dir, "verification_state.json"),
    });
  });
  after(() => {
    fixture?.child.kill();
    fixture = null;
    live?.child.kill();
    live = null;
  });

  it("stops naming the vendor once its other listing there holds a read that found a difference", async () => {
    const page = await fetchPage(fixture!, `/category/${categorySlug}`);
    assert.strictEqual(page.status, 200);
    const rows = page.body.split("<tr").filter((row) => row.includes(`/vendor/${slugOf(vendor)}"`));
    const second = rows.find((row) => row.includes(SECOND_LISTING_TERMS));
    assert.ok(second?.includes("listing-read-contradicts"), `the second ${vendor} listing does not carry the contradicting read`);
    assert.strictEqual(rows.length, 2, `/category/${categorySlug} lists ${rows.length} ${vendor} rows`);
    const named = vendorsNamedAsUncontradicted(metaDescriptionOf(page.body)).map(unescaped);
    assert.ok(!named.includes(vendor), `/category/${categorySlug} still names ${vendor}: ${named.join(", ")}`);
    assert.deepStrictEqual(
      named,
      namedBefore.filter((v) => v !== vendor),
      `/category/${categorySlug} should name every other vendor it named before`,
    );
  });
});
