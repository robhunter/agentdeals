import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBadgeVerdicts, type SiteFreeTierVerdict } from "./badge-verdicts.ts";

const { tierRecordsAFreeTier } = await import("../dist/free-tier-record.js");
const { toSlug } = await import("../dist/vendor-slug.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const categoryNames = [...new Set(offers.map((o) => o.category))].sort();

let port = 0;
let proc: ChildProcess | null = null;
let verdicts = new Map<string, SiteFreeTierVerdict>();
const fetched = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function page(pathname: string): Promise<string> {
  const cached = fetched.get(pathname);
  if (cached !== undefined) return cached;
  const body = await (await fetch(`http://localhost:${port}${pathname}`)).text();
  fetched.set(pathname, body);
  return body;
}

function verdictFor(offer: Offer): SiteFreeTierVerdict {
  return verdicts.get(toSlug(offer.vendor)) ?? "unconfirmed";
}

interface Census {
  total: number;
  recorded: number;
  vouched: number;
  ended: number;
  unconfirmed: number;
}

function censusOf(population: Offer[]): Census {
  const census: Census = { total: population.length, recorded: 0, vouched: 0, ended: 0, unconfirmed: 0 };
  for (const offer of population) {
    if (verdictFor(offer) === "ended") { census.ended++; continue; }
    if (!tierRecordsAFreeTier(offer.tier)) continue;
    census.recorded++;
    if (verdictFor(offer) === "offered") census.vouched++;
    else census.unconfirmed++;
  }
  return census;
}

function statCards(html: string): Map<string, string> {
  const cards = new Map<string, string>();
  for (const m of html.matchAll(/<span class="stat-number">([^<]*)<\/span><span class="stat-label">([^<]*)<\/span>/g)) {
    cards.set(m[2].replace(/&mdash;/g, "—").trim(), m[1].trim());
  }
  return cards;
}

function statNumber(cards: Map<string, string>, labelPrefix: string): number {
  const entry = [...cards.entries()].find(([label]) => label.startsWith(labelPrefix));
  assert.ok(entry, `no stat card whose label starts with ${JSON.stringify(labelPrefix)} — labels: ${[...cards.keys()].join(" | ")}`);
  return parseInt(entry![1].replace(/[,%]/g, ""), 10);
}

interface LandscapeRow {
  slug: string;
  category: string;
  total: number;
  recorded: number;
  recordedPct: number;
  vouched: number;
  vouchedPct: number;
}

function landscapeRows(html: string): LandscapeRow[] {
  const section = html.split("<h2>Category Landscape</h2>")[1]?.split("</table>")[0] ?? "";
  return [...section.matchAll(
    /<tr>\s*<td><a href="\/category\/([a-z0-9-]+)">([^<]*)<\/a><\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)%<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)%<\/td>/g,
  )].map((m) => ({
    slug: m[1],
    category: m[2],
    total: Number(m[3]),
    recorded: Number(m[4]),
    recordedPct: Number(m[5]),
    vouched: Number(m[6]),
    vouchedPct: Number(m[7]),
  }));
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").trim();
}

function ledeOf(html: string): string {
  return textOf(html.match(/<p class="cat-meta">([\s\S]*?)<\/p>/)?.[1] ?? "");
}

function countOnVendors(html: string): { name: string; slug: string }[] {
  const section = html.split("<h2>Still Free: Vendors You Can Count On</h2>")[1]?.split('<div class="callout callout-good">')[0] ?? "";
  return [...section.matchAll(/href="\/vendor\/([a-z0-9-]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ slug: m[1], name: m[2] }));
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

before(async () => {
  proc = await startServer();
  verdicts = await fetchBadgeVerdicts(port);
});

after(() => { proc?.kill(); });

describe("the free tier report counts what the site is prepared to vouch for", () => {
  it("reads a verdict for every vendor in the catalogue", () => {
    assert.ok(verdicts.size >= 1500, `only ${verdicts.size} vendors publish a badge verdict`);
    const missing = offers.filter((o) => !verdicts.has(toSlug(o.vendor)));
    assert.deepStrictEqual(missing.map((o) => o.vendor), [], "offers whose vendor publishes no badge verdict");
  });

  it("holds the three populations the report is written for", () => {
    const census = censusOf(offers);
    assert.ok(census.ended >= 20, `only ${census.ended} offers are recorded as ended`);
    assert.ok(census.vouched >= 300, `only ${census.vouched} offers are vouched`);
    assert.ok(census.unconfirmed >= 100, `only ${census.unconfirmed} recorded offers are unconfirmed`);
    assert.ok(
      censusOf(offers.filter((o) => tierRecordsAFreeTier(o.tier))).ended >= 20,
      "no offer whose tier records a free tier is also recorded as ended, so the exclusion is untested",
    );
  });

  it("publishes recorded, vouched, ended and unconfirmed as four separate numbers", async () => {
    const cards = statCards(await page("/state-of-free-tiers"));
    const census = censusOf(offers);
    assert.strictEqual(statNumber(cards, "Free Tiers Recorded"), census.recorded);
    assert.strictEqual(statNumber(cards, "Vouched Today"), census.vouched);
    assert.strictEqual(statNumber(cards, "Recorded, Unconfirmed"), census.unconfirmed);
    assert.strictEqual(statNumber(cards, "Recorded as Ended"), census.ended);
    assert.strictEqual(
      census.recorded,
      census.vouched + census.unconfirmed,
      "the recorded population is not the vouched and unconfirmed populations together",
    );
  });

  it("states the vouched share in the opening summary and derives it from the same data", async () => {
    const html = await page("/state-of-free-tiers");
    const census = censusOf(offers);
    const vouchedPct = Math.round((census.vouched / census.total) * 100);
    const recordedPct = Math.round((census.recorded / census.total) * 100);
    assert.ok(
      html.includes(`<strong>${vouchedPct}% of tracked services offer a free tier we can vouch for today</strong>`),
      `the summary does not open on ${vouchedPct}%`,
    );
    assert.ok(html.includes(`we hold a free-tier record for ${recordedPct}% of them`), `the summary does not state ${recordedPct}% recorded`);
    assert.ok(html.includes(`<strong>${census.ended} free tiers we have recorded as ended</strong>`), "the summary does not state the ended count");
    assert.ok(!/\d+% of tracked services offer free tiers/.test(html), "the report still publishes a free tier rate that counts ended free tiers");
  });

  it("counts no offer the site says has ended toward any total on the report", async () => {
    const html = await page("/state-of-free-tiers");
    const cards = statCards(html);
    const ended = offers.filter((o) => verdictFor(o) === "ended");
    assert.ok(ended.length >= 20, `only ${ended.length} offers are recorded as ended`);
    const recordedIfEndedCounted = censusOf(offers).recorded + ended.filter((o) => tierRecordsAFreeTier(o.tier)).length;
    assert.notStrictEqual(
      statNumber(cards, "Free Tiers Recorded"),
      recordedIfEndedCounted,
      "the recorded total is the same whether or not ended free tiers are counted, so nothing is excluded",
    );
    for (const row of landscapeRows(html)) {
      const category = categoryNames.find((c) => slugOf(c) === row.slug);
      assert.ok(category, `the landscape table names /category/${row.slug}, which is no category we hold`);
      const census = censusOf(offers.filter((o) => o.category === category));
      assert.strictEqual(row.recorded, census.recorded, `${row.category} recorded`);
      assert.strictEqual(row.vouched, census.vouched, `${row.category} vouched`);
      assert.strictEqual(row.total, census.total, `${row.category} total`);
    }
  });

  it("ranks the category landscape by the share it can vouch for and publishes both shares", async () => {
    const rows = landscapeRows(await page("/state-of-free-tiers"));
    assert.ok(rows.length >= 15, `the landscape table renders ${rows.length} rows`);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i - 1].vouchedPct >= rows[i].vouchedPct,
        `${rows[i - 1].category} (${rows[i - 1].vouchedPct}%) is ranked above ${rows[i].category} (${rows[i].vouchedPct}%)`,
      );
    }
    assert.ok(
      new Set(rows.map((r) => r.vouchedPct)).size > 1,
      "every row in the landscape table reads the same vouched share, so the column ranks nothing",
    );
    for (const row of rows) {
      assert.ok(row.recordedPct >= row.vouchedPct, `${row.category} vouches for more than it records`);
      assert.strictEqual(row.recordedPct, Math.round((row.recorded / row.total) * 100), `${row.category} recorded share`);
      assert.strictEqual(row.vouchedPct, Math.round((row.vouched / row.total) * 100), `${row.category} vouched share`);
    }
    assert.ok(
      rows.some((r) => r.recordedPct - r.vouchedPct >= 20),
      "no row in the landscape table shows a gap between the two shares",
    );
  });

  it("recommends no vendor on the report whose free tier the site says has ended", async () => {
    const html = await page("/state-of-free-tiers");
    const named = countOnVendors(html);
    assert.ok(named.length >= 12, `the structural-commitment cards name ${named.length} vendors`);
    for (const vendor of named) {
      assert.notStrictEqual(
        verdicts.get(vendor.slug),
        "ended",
        `the report puts ${vendor.name} forward as a vendor you can count on`,
      );
      assert.ok(verdicts.has(vendor.slug), `the report links /vendor/${vendor.slug}, which publishes no badge verdict`);
      const res = await fetch(`http://localhost:${port}/vendor/${vendor.slug}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `/vendor/${vendor.slug} answers ${res.status}`);
    }
    assert.ok(
      html.includes("A vendor drops out of these lists as soon as our change log records its free tier ending"),
      "the report does not say the lists are filtered",
    );

    const dropped = (textOf(html).match(/which is why (.+?) (?:is|are) not here/)?.[1] ?? "")
      .split(/,\s*|\s+and\s+/)
      .filter(Boolean);
    assert.ok(dropped.length > 0, "the report names no vendor it dropped, so the sentence is untested");
    for (const name of dropped) {
      assert.strictEqual(
        verdicts.get(toSlug(name)),
        "ended",
        `the report says it dropped ${name}, whose badge does not read ended`,
      );
    }
    assert.ok(
      named.length + dropped.length >= 20,
      `the cards account for ${named.length} vendors published and ${dropped.length} dropped — a name in these lists resolves to no vendor page at all`,
    );
  });
});

describe("a category lede counts no free tier the site says has ended", () => {
  it("holds categories on both sides of the exclusion", () => {
    const withEnded = categoryNames.filter((c) => censusOf(offers.filter((o) => o.category === c)).ended > 0);
    assert.ok(withEnded.length >= 15, `only ${withEnded.length} categories hold an ended free tier`);
    assert.ok(withEnded.length < categoryNames.length, "every category holds an ended free tier");
    assert.ok(
      categoryNames.some((c) => censusOf(offers.filter((o) => o.category === c)).ended > 1),
      "no category holds more than one ended free tier, so the plural form is untested",
    );
  });

  it("subtracts them from the count and names them", async () => {
    let naming = 0;
    for (const category of categoryNames) {
      const population = offers.filter((o) => o.category === category);
      const ended = censusOf(population).ended;
      const lede = ledeOf(await page(`/category/${slugOf(category)}`));
      assert.ok(
        lede.startsWith(`${population.length - ended} verified free tiers and developer deals`),
        `/category/${slugOf(category)} counts ${population.length} less ${ended} ended as: ${lede}`,
      );
      if (ended === 0) {
        assert.ok(!lede.includes("whose free tier"), `/category/${slugOf(category)} names an ended free tier it does not hold: ${lede}`);
        continue;
      }
      naming++;
      const clause = ended === 1
        ? "We also track one whose free tier has ended."
        : `We also track ${ended} whose free tiers have ended.`;
      assert.ok(lede.includes(clause), `/category/${slugOf(category)} lede is: ${lede}`);
    }
    assert.ok(naming >= 15, `only ${naming} categories name an ended free tier`);
  });

  it("keeps the count out of the intro and the search snippet as well", async () => {
    for (const category of categoryNames) {
      const population = offers.filter((o) => o.category === category);
      const standing = population.length - censusOf(population).ended;
      const html = await page(`/category/${slugOf(category)}`);
      const intro = textOf(html.match(/<div class="cat-intro">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "");
      assert.ok(
        intro.startsWith(`We track ${standing} ${category.toLowerCase()} services with free tiers.`),
        `/category/${slugOf(category)} intro is: ${intro}`,
      );
      const description = (html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");
      assert.ok(
        description.startsWith(`Compare ${standing} free ${category.toLowerCase()} tools`),
        `/category/${slugOf(category)} description is: ${description}`,
      );
    }
  });

  it("agrees with the vendor page about a free tier that has ended", async () => {
    const ended = offers.filter((o) => verdictFor(o) === "ended");
    assert.ok(ended.length >= 20, `only ${ended.length} offers are recorded as ended`);
    let checked = 0;
    let retired = 0;
    for (const offer of ended.slice(0, 20)) {
      const slug = toSlug(offer.vendor);
      const vendorPage = textOf(await page(`/vendor/${slug}`));
      const saysRetired = vendorPage.includes(`${offer.vendor} — free tier retired`);
      if (saysRetired) retired++;
      assert.ok(
        saysRetired || vendorPage.includes("Why risky:"),
        `/vendor/${slug} publishes neither a retirement nor a cause, but its badge reads ended`,
      );
      const lede = ledeOf(await page(`/category/${slugOf(offer.category)}`));
      const population = offers.filter((o) => o.category === offer.category);
      const standing = population.length - censusOf(population).ended;
      assert.ok(
        lede.startsWith(`${standing} verified free tiers`),
        `/category/${slugOf(offer.category)} still counts ${offer.vendor}: ${lede}`,
      );
      checked++;
    }
    assert.ok(checked >= 20, `only ${checked} ended free tiers were checked against their vendor page`);
    assert.ok(retired > 0 && retired < checked, `${retired} of ${checked} pages publish a retirement, so one of the two forms is untested`);
  });
});

describe("the report answers the free tier question with the rule the rest of the site uses", () => {
  it("keeps no tier substring test inside the report builder", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    const start = source.indexOf("function buildStateOfFreeTiersPage(");
    assert.ok(start > 0, "buildStateOfFreeTiersPage is no longer in src/serve.ts");
    const next = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, next > 0 ? next : undefined);
    assert.ok(!body.includes('t.includes("free")'), "the report still classifies a tier by substring");
    assert.ok(!body.includes('=== "hobby"'), "the report still holds its own list of free tier labels");
    assert.ok(body.includes("freeTierCensus("), "the report does not ask the shared census for its populations");
  });

  it("reads a tier the same way wherever the question is asked", () => {
    assert.strictEqual(tierRecordsAFreeTier("Free"), true);
    assert.strictEqual(tierRecordsAFreeTier("Hobby"), true);
    assert.strictEqual(tierRecordsAFreeTier("Open Source"), true);
    assert.strictEqual(tierRecordsAFreeTier("Pro"), false);
    assert.strictEqual(tierRecordsAFreeTier("Free Credits"), false);
    assert.strictEqual(tierRecordsAFreeTier("Free Trial"), false);
    assert.strictEqual(tierRecordsAFreeTier("Discontinued"), false);
    assert.ok(
      offers.some((o) => /free/i.test(o.tier) && !tierRecordsAFreeTier(o.tier)),
      "no offer in the catalogue names free in a tier that does not record an ongoing free tier",
    );
  });
});
