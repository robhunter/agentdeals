import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

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

before(async () => {
  const conditionedIndex = scratchIndex("conditioned.json", conditionedOffers);
  conditioned = await startServer(conditionedIndex);
  unconditioned = await startServer(scratchIndex("unconditioned.json", unconditionedOffers));
  superseded = await startServer(conditionedIndex, { AGENTDEALS_CHANGES_PATH: changeLogSupersedingTheTermsOf([HETZNER, COMPUTE_ENGINE, SUPABASE, RENDER]) });
});
after(() => {
  conditioned?.child.kill();
  unconditioned?.child.kill();
  superseded?.child.kill();
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

const COMPARISON_GUIDES = [
  "/database-pricing",
  "/hosting-pricing",
  HETZNER_GUIDE,
  "/database-free-tier-comparison-2026",
  "/hosting-free-tier-comparison-2026",
];

const VENDOR_CARD = /<div class="diff-card"[^>]*>\s*<h3>([\s\S]*?)<\/h3>\s*<(p|div) class="diff-desc">[\s\S]*?<\/\2>([\s\S]*?)<\/div>/g;
const VENDOR_PAGE_LINK = /<a href="\/vendor\/([a-z0-9-]+)"/;
const TABLE_MARKUP = /<table\b[\s\S]*?<\/table>/g;
const TABLE_ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
const FIRST_CELL = /<td\b([^>]*)>([\s\S]*?)<\/td>/;
const CONDITIONS_ROW_ATTRIBUTE = `class="${VENDOR_CONDITIONS_ROW_CLASS}"`;
const CONDITIONS_CELL = /^<td colspan="(\d+)">([\s\S]*)<\/td>$/;
const FIRST_DECORATION = /<a |<span class=/;

type Piece =
  | { kind: "card"; slug: string; printed: string; at: number }
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
    if (slug) pieces.push({ kind: "card", slug, printed: card[3]!.trim(), at: card.index! });
  }
  for (const table of html.matchAll(TABLE_MARKUP)) {
    const columns = headerColumns(table[0]);
    for (const row of table[0].matchAll(TABLE_ROW)) {
      const at = table.index! + row.index!;
      if (row[1]!.includes(CONDITIONS_ROW_ATTRIBUTE)) {
        const [, colspan, list] = row[2]!.match(CONDITIONS_CELL) ?? [];
        pieces.push({ kind: "conditions", colspan: Number(colspan), columns, list: (list ?? "").trim(), at });
      } else {
        pieces.push({ kind: "row", subject: subjectOfRow(row[2]!), at });
      }
    }
  }
  return pieces.sort((a, b) => a.at - b.at);
}

function layoutOf(html: string): GuideLayout {
  const pieces = piecesOf(html);
  const carded = new Set(pieces.flatMap((piece) => (piece.kind === "card" ? [piece.slug] : [])));
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
    } else if (piece.subject && !carded.has(piece.subject) && !rowed.has(piece.subject)) {
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

async function listTheVendorPagePrints(base: string, slug: string, memo: Map<string, string>): Promise<string> {
  const known = memo.get(slug);
  if (known !== undefined) return known;
  const response = await fetch(`${base}/vendor/${slug}`);
  const list = response.status === 200 ? conditionLists(await response.text())[0] ?? "" : "";
  memo.set(slug, list);
  return list;
}

async function placementsNotMatchingTheirVendorPage(base: string): Promise<string[]> {
  const memo = new Map<string, string>();
  const wrong: string[] = [];
  for (const guide of COMPARISON_GUIDES) {
    for (const placement of layoutOf(await page(base, guide)).placements) {
      const expected = endedSlugs.has(placement.slug) ? "" : await listTheVendorPagePrints(base, placement.slug, memo);
      if (placement.printed !== expected) {
        wrong.push(`${guide}, ${placement.where}: printed ${placement.printed.slice(0, 160) || "nothing"}; its vendor page lists ${expected.slice(0, 160) || "nothing"}`);
      }
    }
  }
  return wrong;
}

describe("five comparison guides print each vendor's conditions of use beside its card or row, as its vendor page lists them", () => {
  it("prints every vendor's list once: in its card where the guide has one, else after the first table row that names it", async () => {
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(conditioned.base), []);
  });

  it("finds vendors to print on each guide when every listing holds conditions", async () => {
    for (const guide of COMPARISON_GUIDES) {
      const printed = layoutOf(await page(conditioned.base, guide)).placements.filter((placement) => placement.printed !== "");
      assertPopulationFloor(printed.length, 3, `vendors whose conditions ${guide} prints`);
    }
  });

  it("prints no list a placement does not account for", async () => {
    for (const guide of COMPARISON_GUIDES) {
      const html = await page(conditioned.base, guide);
      const layout = layoutOf(html);
      const ownSection = guide === HETZNER_GUIDE ? conditionLists(sectionOne(html)).length : 0;
      assert.deepStrictEqual(layout.strays, [], `${guide}: a conditions row follows no vendor row that should carry one`);
      assert.strictEqual(
        conditionLists(html).length,
        layout.placements.filter((placement) => placement.printed !== "").length + ownSection,
        `${guide}: every list on the page sits in a vendor's card or right after its first row`,
      );
    }
  });

  it("spans each conditions row across every column of its table", async () => {
    for (const guide of COMPARISON_GUIDES) {
      const { spans } = layoutOf(await page(conditioned.base, guide));
      assert.deepStrictEqual(spans.filter((span) => span.colspan !== span.columns || span.columns === 0), [], guide);
    }
  });

  it("prints no list and no empty conditions row where no listing holds conditions", async () => {
    for (const guide of COMPARISON_GUIDES) {
      const html = await page(unconditioned.base, guide);
      assert.deepStrictEqual(conditionLists(html), [], guide);
      assert.ok(!html.includes(CONDITIONS_ROW_ATTRIBUTE), `${guide} carries an empty conditions row`);
    }
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(unconditioned.base), []);
  });

  it("withholds a vendor's conditions wherever its vendor page does, as beside stored terms a recorded change supersedes", async () => {
    const withheld = [...(tokensOf.get(SUPABASE) ?? []), ...(tokensOf.get(RENDER) ?? [])];
    assert.strictEqual(withheld.length, 4, "one listing each for Supabase and Render");
    for (const guide of COMPARISON_GUIDES) {
      const printed = (await page(superseded.base, guide)).match(ANY_TOKEN) ?? [];
      assert.deepStrictEqual(printed.filter((token) => withheld.includes(token)), [], guide);
    }
    assert.deepStrictEqual(await placementsNotMatchingTheirVendorPage(superseded.base), []);
  });
});
