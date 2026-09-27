import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { offerRetired } = await import("../dist/retirement.js");
const { gateForOffer } = await import("../dist/data.js");
const { toSlug } = await import("../dist/slug.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES = ["/ai-ml-alternatives", "/free-llm-apis", "/free-ai-stack", "/ai-free-tiers", "/vector-database-pricing"];

const CATCH_ALL_HEADINGS: Record<string, string[]> = {
  "/ai-ml-alternatives": ["Other AI & ML Tools"],
  "/ai-free-tiers": ["ML Platforms & Specialized AI", "Free AI Coding Tools"],
};

const GATES_THAT_END_A_LISTING = new Set(["offer_retired", "product_discontinued"]);

const SAYS_IT_ENDED = /\b(?:retired|discontinued|sunset|withdrawn|ended|deprecated|shut down|no longer)\b/i;

type Offer = { vendor: string; tier: string; category: string; description?: string };
type Catalogue = { offers: Offer[] };

const shipped: Catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));

function endedSlugs(catalogue: Catalogue): Map<string, string> {
  const ended = new Map<string, string>();
  for (const offer of catalogue.offers) {
    if (offerRetired(offer) || GATES_THAT_END_A_LISTING.has(gateForOffer(offer)?.code ?? "")) {
      ended.set(toSlug(offer.vendor), offer.vendor);
    }
  }
  return ended;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headingBefore(html: string, at: number): string {
  let found = "";
  for (const m of html.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    if (m.index! > at) break;
    found = text(m[1]);
  }
  return found;
}

type Card = { slug: string; label: string; heading: string };

function cardsOn(html: string): Card[] {
  return [...html.matchAll(/<a href="\/vendor\/([a-z0-9-]+)" class="alt-card-name">[\s\S]*?<\/a>\s*<span class="alt-card-tier">([^<]*)<\/span>/g)].map((m) => ({
    slug: m[1],
    label: text(m[2]),
    heading: headingBefore(html, m.index!),
  }));
}

function itemListNames(html: string): string[] {
  const names: string[] = [];
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed["@type"] !== "ItemList") continue;
    for (const element of parsed.itemListElement ?? []) {
      if (element?.item?.name) names.push(element.item.name);
    }
  }
  return names;
}

type Row = { slug: string; text: string };

function rowsOn(html: string): Row[] {
  const rows: Row[] = [];
  for (const [row] of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const firstCell = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/i.exec(row)?.[0] ?? "";
    const slug = /href="\/vendor\/([a-z0-9-]+)"/.exec(firstCell)?.[1];
    if (slug) rows.push({ slug, text: text(row) });
  }
  return rows;
}

function rowSlugsOn(html: string): string[] {
  return rowsOn(html).map((row) => row.slug);
}

function findingsOn(page: string, html: string, ended: Map<string, string>): string[] {
  const found: string[] = [];
  const catchAlls = CATCH_ALL_HEADINGS[page] ?? [];
  for (const card of cardsOn(html)) {
    if (!ended.has(card.slug)) continue;
    if (!catchAlls.includes(card.heading)) found.push(`${page} lists ${card.slug} under "${card.heading}"`);
    if (!SAYS_IT_ENDED.test(card.label)) found.push(`${page} labels ${card.slug}'s card "${card.label}"`);
  }
  for (const name of itemListNames(html)) {
    if ([...ended.values()].includes(name)) found.push(`${page} puts ${name} in its ItemList`);
  }
  for (const row of rowsOn(html)) {
    if (ended.has(row.slug) && !SAYS_IT_ENDED.test(row.text)) found.push(`${page} prices ${row.slug} in a row: ${row.text.slice(0, 120)}`);
  }
  for (const [, slug] of html.matchAll(/<a href="\/vendor\/([a-z0-9-]+)" class="alt-chip">/g)) {
    if (ended.has(slug)) found.push(`${page} offers ${slug} as an alternative`);
  }
  for (const [, badge, slug] of html.matchAll(/<span class="pick-badge">([^<]*)<\/span>\s*<a href="\/vendor\/([a-z0-9-]+)" class="pick-name">/g)) {
    if (ended.has(slug) && !SAYS_IT_ENDED.test(badge)) found.push(`${page} picks ${slug} as "${badge}"`);
  }
  return found;
}

async function servePages(catalogue: Catalogue): Promise<Map<string, string>> {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-list-pages-"));
  const indexPath = path.join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify(catalogue));
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const served = new Map<string, string>();
    for (const page of PAGES) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, `${page} answered ${response.status}`);
      served.set(page, await response.text());
    }
    return served;
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the AI list pages offer no listing whose tier has ended or whose vendor page is gated as discontinued", () => {
  const ended = endedSlugs(shipped);
  let shippedPages = new Map<string, string>();
  let subject: Card | null = null;
  let rowSubject: string | null = null;
  let subjectRetired = new Map<string, string>();
  let endedWithTheSubject = new Map<string, string>();

  before(async () => {
    shippedPages = await servePages(shipped);
    const html = shippedPages.get("/ai-ml-alternatives")!;
    subject = cardsOn(html).find((card) => !ended.has(card.slug) && !CATCH_ALL_HEADINGS["/ai-ml-alternatives"].includes(card.heading)) ?? null;
    assert.ok(subject, "no current listing sits in a named section of /ai-ml-alternatives");
    rowSubject = rowSlugsOn(shippedPages.get("/vector-database-pricing")!).find((slug) => !ended.has(slug) && slug !== subject!.slug) ?? null;
    assert.ok(rowSubject, "no current listing has a row on /vector-database-pricing");
    const retiring = new Set([subject!.slug, rowSubject!]);
    const retired: Catalogue = {
      ...shipped,
      offers: shipped.offers.map((o) => (retiring.has(toSlug(o.vendor)) ? { ...o, tier: "Retired" } : o)),
    };
    endedWithTheSubject = endedSlugs(retired);
    subjectRetired = await servePages(retired);
  });

  it("reads an ended population from the catalogue's tiers and gates, including a gate the tier does not state", () => {
    assert.ok(ended.size > 0, "no listing's tier or gate says it has ended, so nothing below is exercised");
    const gatedOnly = shipped.offers.filter(
      (o) => !offerRetired(o) && GATES_THAT_END_A_LISTING.has(gateForOffer(o)?.code ?? ""),
    );
    assert.ok(gatedOnly.length > 0, "no listing is ended by its gate alone, so the gate half of the rule is not exercised");
  });

  it("lists an ended listing only in a catch-all section, on a card that says it has ended, and never in a list of options", () => {
    const found = [...shippedPages].flatMap(([page, html]) => findingsOn(page, html, ended));
    assert.deepStrictEqual(found, []);
  });

  it("moves a listing out of its named section by rule once its tier ends, rather than by its name", () => {
    assert.ok(subject);
    assert.ok(endedWithTheSubject.has(subject!.slug) && endedWithTheSubject.has(rowSubject!));
    assert.ok(rowSlugsOn(subjectRetired.get("/vector-database-pricing")!).includes(rowSubject!), `${rowSubject} loses its row on /vector-database-pricing rather than being marked`);
    const found = [...subjectRetired].flatMap(([page, html]) => findingsOn(page, html, endedWithTheSubject));
    assert.deepStrictEqual(found, []);
    const moved = cardsOn(subjectRetired.get("/ai-ml-alternatives")!).filter((card) => card.slug === subject!.slug);
    assert.ok(moved.length > 0, `${subject!.slug} disappears from /ai-ml-alternatives rather than moving to its catch-all`);
    for (const card of moved) assert.strictEqual(card.label, "Retired");
  });
});
