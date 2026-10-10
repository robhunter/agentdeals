import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { everyRouteTheSitemapPublishes } from "./sitemap-routes.ts";

const { offerRetired } = await import("../dist/retirement.js");
const { VENDOR_CONDITIONS_ROW_CLASS } = await import("../dist/listing-conditions.js");

type Offer = import("../src/types.ts").Offer;
type ListingCondition = import("../src/types.ts").ListingCondition;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));

const HETZNER_GUIDE = "/hetzner-pricing-2026";
const GCP_GUIDE = "/gcp-free-tier-2026";
const HETZNER = "Hetzner";
const COMPUTE_ENGINE = "Google Compute Engine";
const E2_MICRO_ROW = "Compute Engine (e2-micro)";
const SUPABASE = "Supabase";
const RENDER = "Render";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function codeFor(index: number): string {
  return LETTERS[Math.floor(index / 676) % 26]! + LETTERS[Math.floor(index / 26) % 26]! + LETTERS[index % 26]!;
}

const ANY_TOKEN = /Zqg[a-z]{3}[12]\b/g;

function conditionNaming(token: string): ListingCondition {
  return {
    text: `The plan carries condition ${token} & "quoted" <terms>.`,
    quote: `Condition ${token} applies.`,
    url: `https://www.conditions.example/terms?plan=free&use="any"`,
    read_on: TODAY,
  };
}

const tokensOf = new Map<string, string[]>();

const conditionedOffers: Offer[] = catalogue.offers.map((offer: Offer, index: number) => {
  const tokens = [`Zqg${codeFor(index)}1`, `Zqg${codeFor(index)}2`];
  tokensOf.set(offer.vendor, [...(tokensOf.get(offer.vendor) ?? []), ...tokens]);
  return { ...offer, conditions: tokens.map(conditionNaming) };
});

const unconditionedOffers: Offer[] = catalogue.offers.map((offer: Offer) => {
  const { conditions: _conditions, ...rest } = offer as Offer & { conditions?: unknown };
  return rest as Offer;
});

const dir = mkdtempSync(path.join(tmpdir(), "guide-vendor-conditions-"));

function scratchIndex(name: string, offers: Offer[]): string {
  const at = path.join(dir, name);
  writeFileSync(at, JSON.stringify({ ...catalogue, offers }));
  return at;
}

function aRecordNamingTheTermsOf(offer: Offer): Record<string, unknown> {
  return {
    vendor: offer.vendor,
    category: offer.category,
    tier: offer.tier,
    change_type: "limits_reduced",
    date: "2026-08-28",
    date_source: "discovered",
    summary: "The plan now allows one project.",
    previous_state: offer.description,
    current_state: "Plan: 1 project, 100 MB storage",
    impact: "high",
    source_url: offer.url,
    alternatives: [],
  };
}

function changeLogSupersedingTheTermsOf(vendors: string[]): string {
  const stored = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
  const subjects = conditionedOffers.filter((offer) => vendors.includes(offer.vendor));
  const at = path.join(dir, "superseding-changes.json");
  writeFileSync(at, JSON.stringify({ ...stored, changes: [...stored.changes, ...subjects.map(aRecordNamingTheTermsOf)] }));
  return at;
}

function anEmptyChangeLog(): string {
  const at = path.join(dir, "no-changes.json");
  writeFileSync(at, JSON.stringify({ changes: [] }));
  return at;
}

function startServer(indexPath: string, env: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath, ...env },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function page(base: string, route: string): Promise<string> {
  const response = await fetch(`${base}${route}`);
  assert.strictEqual(response.status, 200, route);
  return response.text();
}

const CONDITIONS_LIST = /<ul class="listing-conditions"[^>]*>[\s\S]*?<\/ul>/g;

function conditionLists(html: string): string[] {
  return html.match(CONDITIONS_LIST) ?? [];
}

function asLiteralPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function vendorSlug(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sectionOne(html: string): string {
  const start = html.indexOf('<h2 id="pricing">');
  const end = html.indexOf('<h2 id="april">');
  assert.ok(start >= 0 && end > start, "the Hetzner guide has its section 1 ahead of section 2");
  return html.slice(start, end);
}

function alwaysFreeRows(html: string): Array<{ name: string; limits: string }> {
  const start = html.indexOf('id="always-free"');
  const table = html.slice(start, html.indexOf("</table>", start));
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell!))
    .filter((cells) => cells.length >= 2)
    .map((cells) => ({ name: cells[0]!.replace(/<[^>]+>/g, "").trim(), limits: cells[1]! }));
}

let conditioned: { child: ChildProcess; base: string };
let unconditioned: { child: ChildProcess; base: string };
let superseded: { child: ChildProcess; base: string };
let withholdingNothing: { child: ChildProcess; base: string };

before(async () => {
  const conditionedIndex = scratchIndex("conditioned.json", conditionedOffers);
  conditioned = await startServer(conditionedIndex);
  unconditioned = await startServer(scratchIndex("unconditioned.json", unconditionedOffers));
  superseded = await startServer(conditionedIndex, { AGENTDEALS_CHANGES_PATH: changeLogSupersedingTheTermsOf([HETZNER, COMPUTE_ENGINE, SUPABASE, RENDER]) });
  withholdingNothing = await startServer(conditionedIndex, { AGENTDEALS_CHANGES_PATH: anEmptyChangeLog() });
});
after(() => {
  conditioned?.child.kill();
  unconditioned?.child.kill();
  superseded?.child.kill();
  withholdingNothing?.child.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("the Hetzner and Google Cloud guides print their vendor's conditions of use as its vendor page does", () => {
  it("holds one listing each for Hetzner and Google Compute Engine, so each guide has one list to print", () => {
    assert.strictEqual(tokensOf.get(HETZNER)?.length, 2);
    assert.strictEqual(tokensOf.get(COMPUTE_ENGINE)?.length, 2);
  });

  it("ends the Hetzner guide's section 1 with the Hetzner listing's conditions, byte for byte as /vendor/hetzner lists them", async () => {
    const guide = await page(conditioned.base, HETZNER_GUIDE);
    const [onTheVendorPage] = conditionLists(await page(conditioned.base, `/vendor/${vendorSlug(HETZNER)}`));
    assert.ok(onTheVendorPage, "the vendor page lists the conditions");
    assert.deepStrictEqual(onTheVendorPage.match(ANY_TOKEN), tokensOf.get(HETZNER));
    assert.ok(sectionOne(guide).trimEnd().endsWith(onTheVendorPage), "section 1 ends with the vendor page's list, after the plan table and its notes");
    assert.ok(sectionOne(guide).indexOf("</table>") < sectionOne(guide).indexOf(onTheVendorPage), "the list follows the plan table");
    assert.strictEqual(guide.split(onTheVendorPage).length - 1, 1, "the list is printed once");
  });

  it("prints the Google Compute Engine listing's conditions in the e2-micro row of the Always Free table, and in no other row", async () => {
    const guide = await page(conditioned.base, GCP_GUIDE);
    const [onTheVendorPage] = conditionLists(await page(conditioned.base, `/vendor/${vendorSlug(COMPUTE_ENGINE)}`));
    assert.ok(onTheVendorPage, "the vendor page lists the conditions");
    assert.deepStrictEqual(onTheVendorPage.match(ANY_TOKEN), tokensOf.get(COMPUTE_ENGINE));
    const rows = alwaysFreeRows(guide);
    const e2Micro = rows.find((row) => row.name === E2_MICRO_ROW);
    assert.ok(e2Micro, "the Always Free table has the e2-micro row");
    assert.match(e2Micro.limits, new RegExp(`<div style="font-family:var\\(--sans\\)">\\s*${asLiteralPattern(onTheVendorPage)}\\s*</div>$`), "the row's limits cell ends with the vendor page's list");
    assert.deepStrictEqual(rows.filter((row) => row !== e2Micro && conditionLists(row.limits).length > 0).map((row) => row.name), []);
    assert.strictEqual(guide.split(onTheVendorPage).length - 1, 1, "the list is printed once");
  });

  it("names no other listing's conditions where it prints its vendor's", async () => {
    const hetzner = sectionOne(await page(conditioned.base, HETZNER_GUIDE));
    const gcp = alwaysFreeRows(await page(conditioned.base, GCP_GUIDE)).find((row) => row.name === E2_MICRO_ROW)!.limits;
    assert.deepStrictEqual(hetzner.match(ANY_TOKEN), tokensOf.get(HETZNER));
    assert.deepStrictEqual(gcp.match(ANY_TOKEN), tokensOf.get(COMPUTE_ENGINE));
  });

  it("prints no list and no empty container where the listing holds no conditions", async () => {
    const hetzner = await page(unconditioned.base, HETZNER_GUIDE);
    const gcp = await page(unconditioned.base, GCP_GUIDE);
    assert.deepStrictEqual(conditionLists(sectionOne(hetzner)), []);
    assert.match(sectionOne(hetzner).trimEnd(), /<\/p>$/, "section 1 ends with its last paragraph");
    const e2Micro = alwaysFreeRows(gcp).find((row) => row.name === E2_MICRO_ROW)!;
    assert.deepStrictEqual(conditionLists(e2Micro.limits), []);
    assert.ok(!e2Micro.limits.includes("font-family:var(--sans)"), `no empty wrapper in the e2-micro cell\n${e2Micro.limits}`);
  });

  it("withholds the conditions wherever the vendor page does, as for a listing whose stored terms a recorded change supersedes", async () => {
    for (const vendor of [HETZNER, COMPUTE_ENGINE]) {
      const vendorPage = await page(superseded.base, `/vendor/${vendorSlug(vendor)}`);
      assert.deepStrictEqual(vendorPage.match(ANY_TOKEN) ?? [], [], `${vendor}: the vendor page withholds the conditions beside superseded terms`);
    }
    const hetzner = sectionOne(await page(superseded.base, HETZNER_GUIDE));
    const e2Micro = alwaysFreeRows(await page(superseded.base, GCP_GUIDE)).find((row) => row.name === E2_MICRO_ROW)!;
    assert.deepStrictEqual(hetzner.match(ANY_TOKEN) ?? [], []);
    assert.deepStrictEqual(e2Micro.limits.match(ANY_TOKEN) ?? [], []);
    assert.ok(!e2Micro.limits.includes("font-family:var(--sans)"), `no empty wrapper in the e2-micro cell\n${e2Micro.limits}`);
  });
});

const TEMPLATES_THAT_PRINT_CONDITIONS_THEIR_OWN_WAY = [/^\/vendor\//, /^\/category\//, /^\/best\//, /^\/compare\//, /^\/alternative-to\//];

const PAGES_WHOSE_ROWS_ARE_NOT_ABOUT_A_VENDORS_TERMS = [
  /^\/events\//,
  /^\/freshness$/,
  /^\/free-tier-risk$/,
  /^\/free-tier-tracker$/,
  /^\/referral-programs$/,
  /^\/state-of-free-tiers$/,
  /^\/x402-services$/,
  /^\/agent-payments$/,
  /^\/free-tier-facts-ai-models-get-wrong$/,
];

function coveredByThisTest(route: string): boolean {
  return ![...TEMPLATES_THAT_PRINT_CONDITIONS_THEIR_OWN_WAY, ...PAGES_WHOSE_ROWS_ARE_NOT_ABOUT_A_VENDORS_TERMS].some((pattern) => pattern.test(route));
}

const VENDOR_CARD = /<div class="diff-card"[^>]*>\s*<h3>([\s\S]*?)<\/h3>\s*<(p|div) class="diff-desc">[\s\S]*?<\/\2>([\s\S]*?)<\/div>/g;
const CATALOGUE_CARD = /<div class="alt-card"[^>]*>\s*<div class="alt-card-header">\s*<a href="\/vendor\/([a-z0-9-]+)" class="alt-card-name">/g;
const LISTING_IN_FULL = /<div class="context-box listing-in-full">\s*<strong><a href="\/vendor\/([a-z0-9-]+)"/g;
const VENDOR_PAGE_LINK = /<a href="\/vendor\/([a-z0-9-]+)"/;
const TABLE_MARKUP = /<table\b[\s\S]*?<\/table>/g;
const TABLE_ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
const FIRST_CELL = /<td\b([^>]*)>([\s\S]*?)<\/td>/;
const CONDITIONS_ROW_ATTRIBUTE = `class="${VENDOR_CONDITIONS_ROW_CLASS}"`;
const CONDITIONS_CELL = /^<td colspan="(\d+)">([\s\S]*)<\/td>$/;
const FIRST_DECORATION = /<a |<span class=/;

type Piece =
  | { kind: "card"; slug: string; printed: string; at: number }
  | { kind: "listed in full"; slug: string; at: number }
  | { kind: "row"; subject: string | null; at: number }
  | { kind: "conditions"; colspan: number; columns: number; list: string; at: number };

interface Placement {
  slug: string;
  where: string;
  printed: string;
}

interface GuideLayout {
  placements: Placement[];
  spans: Array<{ colspan: number; columns: number }>;
  strays: string[];
}

function subjectOfRow(cells: string): string | null {
  const first = cells.match(FIRST_CELL);
  if (!first) return null;
  const [, attributes, content] = first;
  const linked = content!.match(VENDOR_PAGE_LINK);
  if (linked) return linked[1]!;
  if (!attributes!.includes('class="provider-col"')) return null;
  return vendorSlug(content!.split(FIRST_DECORATION)[0]!.replace(/<[^>]+>/g, "").trim());
}

function headerColumns(table: string): number {
  const head = table.indexOf("</thead>");
  return (table.slice(0, head < 0 ? 0 : head).match(/<th\b/g) ?? []).length;
}

function piecesOf(html: string): Piece[] {
  const pieces: Piece[] = [];
  for (const card of html.matchAll(VENDOR_CARD)) {
    const slug = card[1]!.match(VENDOR_PAGE_LINK)?.[1];
    if (slug) pieces.push({ kind: "card", slug, printed: conditionLists(card[3]!).join(""), at: card.index! });
  }
  for (const listed of [...html.matchAll(CATALOGUE_CARD), ...html.matchAll(LISTING_IN_FULL)]) {
    pieces.push({ kind: "listed in full", slug: listed[1]!, at: listed.index! });
  }
  for (const table of html.matchAll(TABLE_MARKUP)) {
    const columns = headerColumns(table[0]);
    for (const row of table[0].matchAll(TABLE_ROW)) {
      const at = table.index! + row.index!;
      if (row[1]!.includes(CONDITIONS_ROW_ATTRIBUTE)) {
        const [, colspan, list] = row[2]!.match(CONDITIONS_CELL) ?? [];
        pieces.push({ kind: "conditions", colspan: Number(colspan), columns, list: (list ?? "").trim(), at });
      } else {
        const subject = subjectOfRow(row[2]!);
        if (subject && conditionLists(row[2]!).length > 0) pieces.push({ kind: "listed in full", slug: subject, at });
        pieces.push({ kind: "row", subject, at });
      }
    }
  }
  return pieces.sort((a, b) => a.at - b.at);
}

function layoutOf(html: string): GuideLayout {
  const pieces = piecesOf(html);
  const carded = new Set(pieces.flatMap((piece) => (piece.kind === "card" || piece.kind === "listed in full" ? [piece.slug] : [])));
  const rowed = new Set<string>();
  const layout: GuideLayout = { placements: [], spans: [], strays: [] };
  let awaitingItsRow: Placement | null = null;
  for (const piece of pieces) {
    if (piece.kind === "conditions") {
      layout.spans.push({ colspan: piece.colspan, columns: piece.columns });
      if (awaitingItsRow) awaitingItsRow.printed = piece.list;
      else layout.strays.push(piece.list.slice(0, 200));
      awaitingItsRow = null;
      continue;
    }
    awaitingItsRow = null;
    if (piece.kind === "card") {
      layout.placements.push({ slug: piece.slug, where: `the ${piece.slug} card`, printed: piece.printed });
    } else if (piece.kind === "row" && piece.subject && !carded.has(piece.subject) && !rowed.has(piece.subject)) {
      rowed.add(piece.subject);
      awaitingItsRow = { slug: piece.subject, where: `the first ${piece.subject} row`, printed: "" };
      layout.placements.push(awaitingItsRow);
    }
  }
  return layout;
}

const endedSlugs = new Set(
  catalogue.offers
    .filter((offer: Offer, index: number) => catalogue.offers.findIndex((other: Offer) => other.vendor === offer.vendor) === index)
    .filter((primary: Offer) => offerRetired(primary))
    .map((primary: Offer) => vendorSlug(primary.vendor)),
);

interface VendorPageList {
  list: string;
  landsOnAnotherListing: boolean;
}

async function listTheVendorPagePrints(base: string, slug: string, memo: Map<string, VendorPageList>): Promise<VendorPageList> {
  const known = memo.get(slug);
  if (known) return known;
  const response = await fetch(`${base}/vendor/${slug}`, { redirect: "manual" });
  const location = response.headers.get("location");
  const redirected = response.status >= 300 && response.status < 400 && location !== null;
  const landing = redirected ? await fetch(new URL(location, base)) : response;
  const found = { list: landing.status === 200 ? conditionLists(await landing.text())[0] ?? "" : "", landsOnAnotherListing: redirected };
  memo.set(slug, found);
  return found;
}

function rowsNamedWithoutALink(html: string): string[] {
  const named = new Set<string>();
  for (const table of html.matchAll(TABLE_MARKUP)) {
    for (const row of table[0].matchAll(TABLE_ROW)) {
      const first = row[2]!.match(FIRST_CELL);
      if (!first || VENDOR_PAGE_LINK.test(first[2]!)) continue;
      const subject = subjectOfRow(row[2]!);
      if (subject) named.add(subject);
    }
  }
  return [...named];
}

function cardsLinkingNoListingThatPrintAList(html: string): string[] {
  return [...html.matchAll(VENDOR_CARD)]
    .filter((card) => !VENDOR_PAGE_LINK.test(card[1]!) && conditionLists(card[3]!).length > 0)
    .map((card) => card[1]!.split("<")[0]!.trim());
}

async function vendorPageStatus(base: string, slug: string, memo: Map<string, number>): Promise<number> {
  if (!memo.has(slug)) memo.set(slug, (await fetch(`${base}/vendor/${slug}`, { redirect: "manual" })).status);
  return memo.get(slug)!;
}

interface GuideReading {
  route: string;
  layout: GuideLayout;
  rowsNamedWithoutALink: string[];
  cardsLinkingNoListingThatPrintAList: string[];
  lists: number;
  carriesAnEmptyConditionsRow: boolean;
  tokens: string[];
}

async function readGuides(base: string, routes: string[]): Promise<GuideReading[]> {
  const readings: GuideReading[] = [];
  for (let at = 0; at < routes.length; at += 8) {
    readings.push(...await Promise.all(routes.slice(at, at + 8).map(async (route) => {
      const html = await page(base, route);
      return {
        route,
        layout: layoutOf(html),
        rowsNamedWithoutALink: rowsNamedWithoutALink(html),
        cardsLinkingNoListingThatPrintAList: cardsLinkingNoListingThatPrintAList(html),
        lists: conditionLists(html).length,
        carriesAnEmptyConditionsRow: html.includes(CONDITIONS_ROW_ATTRIBUTE),
        tokens: html.match(ANY_TOKEN) ?? [],
      };
    })));
  }
  return readings;
}

const PRODUCT_ROWS_THEIR_PARENTS_CONDITIONS_COVER = [
  { route: "/storage-comparison-2026", row: "supabase-storage", parent: "supabase" },
  { route: "/storage-comparison-2026", row: "vercel-blob", parent: "vercel" },
];

const PRODUCT_CARDS_THEIR_PARENTS_CONDITIONS_COVER = [
  { route: "/storage-comparison-2026", card: "Netlify Blobs", parent: "netlify" },
  { route: "/startup-credits", card: "DigitalOcean Startups", parent: "digitalocean" },
];

const PRODUCT_CARDS_THEIR_PARENTS_CONDITIONS_DO_NOT_COVER = [
  { route: "/storage-comparison-2026", card: "DigitalOcean Spaces", parent: "digitalocean" },
];

function listsInTheCardHeaded(html: string, heading: string): string {
  const cards = [...html.matchAll(VENDOR_CARD)].filter((card) => card[1]!.split("<")[0]!.trim() === heading);
  assert.strictEqual(cards.length, 1, `one ${heading} card`);
  return conditionLists(cards[0]![3]!).join("");
}

const ROWS_THEIR_LISTINGS_CONDITIONS_DO_NOT_DESCRIBE = [
  { route: "/storage-comparison-2026", row: "firebase-storage", listing: "firebase" },
  { route: "/aws-app-runner-migration", row: "digitalocean", listing: "digitalocean" },
];

const ROWS_NAMING_NO_LISTING = [
  { route: "/analytics-free-tier-comparison-2026", row: "countly" },
  { route: "/analytics-free-tier-comparison-2026", row: "fathom" },
  { route: "/analytics-free-tier-comparison-2026", row: "june-so" },
  { route: "/analytics-free-tier-comparison-2026", row: "matomo" },
  { route: "/analytics-free-tier-comparison-2026", row: "pirsch" },
  { route: "/analytics-free-tier-comparison-2026", row: "simple-analytics" },
  { route: "/api-development-free-tier-comparison-2026", row: "httpie" },
  { route: "/api-development-free-tier-comparison-2026", row: "scalar" },
  { route: "/api-development-free-tier-comparison-2026", row: "yaak" },
  { route: "/auth-comparison-2026", row: "authelia" },
  { route: "/cloud-free-tier-comparison-2026", row: "gcp" },
  { route: "/email-comparison-2026", row: "best-dx-modern-stack" },
  { route: "/email-comparison-2026", row: "email-testing-staging" },
  { route: "/email-comparison-2026", row: "mailcheck-ai" },
  { route: "/email-comparison-2026", row: "mailgun" },
  { route: "/email-comparison-2026", row: "marketing-transactional" },
  { route: "/email-comparison-2026", row: "self-hosted-oss-hedge" },
  { route: "/email-comparison-2026", row: "sendgrid" },
  { route: "/email-comparison-2026", row: "side-project-transactional" },
  { route: "/email-comparison-2026", row: "smtp2go" },
  { route: "/hosting-free-tier-comparison-2026", row: "heroku" },
  { route: "/monitoring-comparison-2026", row: "hyperdx" },
  { route: "/serverless-free-tier-comparison-2026", row: "google-cloud-functions" },
  { route: "/storage-comparison-2026", row: "bunnycdn" },
  { route: "/storage-comparison-2026", row: "keycdn" },
  { route: "/storage-comparison-2026", row: "uploadthing" },
];

function namesNoListing(route: string, row: string): boolean {
  return ROWS_NAMING_NO_LISTING.some((listed) => listed.route === route && listed.row === row);
}

const ROWS_UNDER_A_VENDORS_FORMER_NAME = [
  { route: "/firebase-studio-shutdown", row: "codesandbox", listing: "codesandbox-io" },
  { route: "/firebase-studio-shutdown", row: "stackblitz", listing: "stackblitz-com" },
  { route: "/firebase-studio-shutdown", row: "v0", listing: "v0-dev" },
  { route: "/email-comparison-2026", row: "mailtrap", listing: "mailtrap-io" },
  { route: "/email-comparison-2026", row: "mailersend", listing: "mailersend-com" },
  { route: "/email-comparison-2026", row: "mailerlite", listing: "mailerlite-com" },
  { route: "/monitoring-comparison-2026", row: "netdata", listing: "netdata-cloud" },
  { route: "/monitoring-comparison-2026", row: "pingbreak", listing: "pingbreak-com" },
  { route: "/team-collaboration-alternatives", row: "slack-api", listing: "slack" },
];

function listingsConditionsDoNotDescribe(route: string, slug: string): boolean {
  return ROWS_THEIR_LISTINGS_CONDITIONS_DO_NOT_DESCRIBE.some((listed) => listed.route === route && listed.row === slug);
}

async function placementsNotMatchingTheirVendorPage(base: string, readings: GuideReading[]): Promise<string[]> {
  const memo = new Map<string, VendorPageList>();
  const wrong: string[] = [];
  for (const { route, layout } of readings) {
    for (const placement of layout.placements) {
      const onTheVendorPage = await listTheVendorPagePrints(base, placement.slug, memo);
      const expected = endedSlugs.has(placement.slug) ? "" : onTheVendorPage.list;
      const acceptable = onTheVendorPage.landsOnAnotherListing || listingsConditionsDoNotDescribe(route, placement.slug) ? [expected, ""] : [expected];
      if (!acceptable.includes(placement.printed)) {
        wrong.push(`${route}, ${placement.where}: printed ${placement.printed.slice(0, 160) || "nothing"}; its vendor page lists ${expected.slice(0, 160) || "nothing"}`);
      }
    }
  }
  return wrong;
}

function placementOf(html: string, slug: string): Placement {
  const placement = layoutOf(html).placements.find((candidate) => candidate.slug === slug);
  assert.ok(placement, `a ${slug} row`);
  return placement;
}

async function parentListOf(base: string, row: string, parent: string, memo: Map<string, VendorPageList>): Promise<string> {
  const viaTheRow = await listTheVendorPagePrints(base, row, memo);
  const parents = await listTheVendorPagePrints(base, parent, memo);
  assert.ok(row === parent || (viaTheRow.landsOnAnotherListing && viaTheRow.list === parents.list), `/vendor/${row} lands on /vendor/${parent}`);
  assert.notStrictEqual(parents.list, "", `/vendor/${parent} lists conditions`);
  return parents.list;
}

let routesCovered: string[] = [];
const readingsOf = new Map<string, Promise<GuideReading[]>>();

function readingsOn(base: string): Promise<GuideReading[]> {
  if (!readingsOf.has(base)) readingsOf.set(base, readGuides(base, routesCovered));
  return readingsOf.get(base)!;
}

describe("every guide that compares vendors prints each vendor's conditions of use beside its card or row, as its vendor page lists them", () => {
  before(async () => {
    const published = await everyRouteTheSitemapPublishes(conditioned.base);
    routesCovered = published.filter(coveredByThisTest).sort();
  });

  it("prints every vendor's list once: in its card where the guide has one, else after the first table row that names it", async () => {
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(conditioned.base, await readingsOn(conditioned.base)), []);
  });

  it("prints every vendor's list where no record withholds it, so no row is silent only because a record withholds its list today", async () => {
    const routes = (await everyRouteTheSitemapPublishes(withholdingNothing.base)).filter(coveredByThisTest).sort();
    assert.ok(routes.length >= routesCovered.length / 2, `only ${routes.length} of ${routesCovered.length} guides are served without records`);
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(withholdingNothing.base, await readGuides(withholdingNothing.base, routes)), []);
  });

  it("ties every vendor row to a vendor page, by a link in its first cell or by a name one answers to, unless the row is listed as naming no listing", async () => {
    const memo = new Map<string, number>();
    const unanswered: string[] = [];
    for (const { route, rowsNamedWithoutALink } of await readingsOn(conditioned.base)) {
      for (const row of rowsNamedWithoutALink) {
        if (!namesNoListing(route, row) && await vendorPageStatus(conditioned.base, row, memo) === 404) unanswered.push(`${route}: the ${row} row`);
      }
    }
    assert.deepStrictEqual(unanswered, []);
  });

  it("lists as naming no listing only rows a guide it reads still prints, under a name no vendor page answers to", async () => {
    const memo = new Map<string, number>();
    const readings = new Map((await readingsOn(conditioned.base)).map((reading) => [reading.route, reading]));
    for (const { route, row } of ROWS_NAMING_NO_LISTING) {
      assert.ok(readings.get(route)?.rowsNamedWithoutALink.includes(row), `${route} prints no ${row} row named without a link`);
      assert.ok([404, 410].includes(await vendorPageStatus(conditioned.base, row, memo)), `/vendor/${row} answers now; take ${route}'s ${row} row off the list`);
    }
  });

  it("prints the parent listing's conditions after a product row they cover", async () => {
    const memo = new Map<string, VendorPageList>();
    for (const { route, row, parent } of PRODUCT_ROWS_THEIR_PARENTS_CONDITIONS_COVER) {
      const list = await parentListOf(conditioned.base, row, parent, memo);
      assert.strictEqual(placementOf(await page(conditioned.base, route), row).printed, list, `${route}, the ${row} row`);
    }
  });

  it("prints the parent listing's conditions in a product card they cover, and none in a product card they do not", async () => {
    const memo = new Map<string, VendorPageList>();
    for (const { route, card, parent } of PRODUCT_CARDS_THEIR_PARENTS_CONDITIONS_COVER) {
      const { list } = await listTheVendorPagePrints(conditioned.base, parent, memo);
      assert.notStrictEqual(list, "", `/vendor/${parent} lists conditions`);
      assert.strictEqual(listsInTheCardHeaded(await page(conditioned.base, route), card), list, `${route}, the ${card} card`);
    }
    for (const { route, card, parent } of PRODUCT_CARDS_THEIR_PARENTS_CONDITIONS_DO_NOT_COVER) {
      assert.notStrictEqual((await listTheVendorPagePrints(conditioned.base, parent, memo)).list, "", `/vendor/${parent} lists conditions`);
      assert.strictEqual(listsInTheCardHeaded(await page(conditioned.base, route), card), "", `${route}, the ${card} card`);
    }
  });

  it("prints a list in a card that links no listing only where a parent listing's conditions are listed as covering it", async () => {
    const named = ({ route, card }: { route: string; card: string }) => `${route}: the ${card} card`;
    const printing = (await readingsOn(conditioned.base)).flatMap(({ route, cardsLinkingNoListingThatPrintAList }) =>
      cardsLinkingNoListingThatPrintAList.map((card) => named({ route, card })));
    assert.deepStrictEqual(printing.sort(), PRODUCT_CARDS_THEIR_PARENTS_CONDITIONS_COVER.map(named).sort());
  });

  it("prints the conditions of the listing a vendor's former name lands on after a row under that name", async () => {
    const memo = new Map<string, VendorPageList>();
    for (const { route, row, listing } of ROWS_UNDER_A_VENDORS_FORMER_NAME) {
      const list = await parentListOf(conditioned.base, row, listing, memo);
      assert.strictEqual(placementOf(await page(conditioned.base, route), row).printed, list, `${route}, the ${row} row`);
    }
  });

  it("prints no conditions after a row whose listing's conditions do not describe what the row compares", async () => {
    const memo = new Map<string, VendorPageList>();
    for (const { route, row, listing } of ROWS_THEIR_LISTINGS_CONDITIONS_DO_NOT_DESCRIBE) {
      await parentListOf(conditioned.base, row, listing, memo);
      assert.strictEqual(placementOf(await page(conditioned.base, route), row).printed, "", `${route}, the ${row} row`);
    }
  });

  it("finds the guides it covers from the sitemap, and vendors to print on them when every listing holds conditions", async () => {
    const readings = await readingsOn(conditioned.base);
    const printing = readings.filter(({ layout }) => layout.placements.some((placement) => placement.printed !== ""));
    assertPopulationFloor(printing.length, 15, "guides that print a vendor's conditions beside its card or row");
    assertPopulationFloor(printing.reduce((sum, { layout }) => sum + layout.placements.filter((placement) => placement.printed !== "").length, 0), 150, "cards and rows that print their vendor's conditions");
  });

  it("prints no conditions row after a row that is not its vendor's first", async () => {
    for (const { route, layout } of await readingsOn(conditioned.base)) {
      assert.deepStrictEqual(layout.strays, [], `${route}: a conditions row follows no vendor row that should carry one`);
    }
  });

  it("spans each conditions row across every column of its table", async () => {
    for (const { route, layout } of await readingsOn(conditioned.base)) {
      assert.deepStrictEqual(layout.spans.filter((span) => span.colspan !== span.columns || span.columns === 0), [], route);
    }
  });

  it("prints no list and no empty conditions row where no listing holds conditions", async () => {
    const readings = await readingsOn(unconditioned.base);
    for (const { route, lists, carriesAnEmptyConditionsRow } of readings) {
      assert.strictEqual(lists, 0, route);
      assert.ok(!carriesAnEmptyConditionsRow, `${route} carries an empty conditions row`);
    }
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(unconditioned.base, readings), []);
  });

  it("withholds a vendor's conditions wherever its vendor page does, as beside stored terms a recorded change supersedes", async () => {
    const withheld = [...(tokensOf.get(SUPABASE) ?? []), ...(tokensOf.get(RENDER) ?? [])];
    assert.strictEqual(withheld.length, 4, "one listing each for Supabase and Render");
    const readings = await readingsOn(superseded.base);
    for (const { route, tokens } of readings) {
      assert.deepStrictEqual(tokens.filter((token) => withheld.includes(token)), [], route);
    }
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(superseded.base, readings), []);
  });
});
