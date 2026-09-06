import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

type SiteVerdict = "offered" | "ended" | "unconfirmed";

const BADGE_VERDICT: Record<string, SiteVerdict> = {
  "active": "offered",
  "at risk": "offered",
  "stale": "offered",
  "free tier removed": "ended",
  "deprecated": "ended",
  "retired": "ended",
};

interface Pair {
  slug: string;
  a: string;
  b: string;
}

interface Side {
  vendor: string;
  slug: string;
  verdict: SiteVerdict;
  tier: string;
  description: string;
  superseded: boolean;
  reasonsItCouldGive: string[];
}

let pairs: Pair[] = [];
const sides = new Map<string, Side>();

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescHtml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—").replace(/&rsquo;/g, "’").replace(/&hellip;/g, "…")
    .replace(/&#39;/g, "'").replace(/&darr;/g, "↓").replace(/&rarr;/g, "→");
}

function badgeLabel(svg: string): string {
  const title = svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
  return title.split(": ").slice(1).join(": ").split(" · ")[0].trim();
}

async function fetchAll<T>(items: T[], worker: (item: T) => Promise<void>, lanes = 12): Promise<void> {
  let queue = 0;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (queue < items.length) await worker(items[queue++]);
  }));
}

before(async () => {
  const { buildComparisonMap } = await import("../dist/comparison-pairs.js");
  const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
  const { toSlug } = await import("../dist/vendor-slug.js");
  const { supersedingChange } = await import("../dist/superseded-description.js");
  const { gateFor, utcDate } = await import("../dist/ranking.js");
  const { levelWithheldReason, withheldLevelSentence } = await import("../dist/source-check.js");
  const { ratingWithheldForNoSourceSentence } = await import("../dist/change-citation.js");

  const offers = loadOffers();
  const changes = loadDealChanges();
  const servedOn = utcDate();
  pairs = [...buildComparisonMap().entries()].map(([slug, [a, b]]: [string, [string, string]]) => ({ slug, a, b }));
  assert.ok(pairs.length > 300, "the comparison set did not load");

  const started = await startHttpServer();
  proc = started.child;
  serverPort = started.port;

  const vendors = [...new Set(pairs.flatMap(p => [p.a, p.b]))];
  await fetchAll(vendors, async (vendor) => {
    const primary = offers.find((o: { vendor: string }) => o.vendor === vendor)!;
    const slug = toSlug(vendor);
    const res = await fetch(`http://localhost:${serverPort}/badge/${slug}.svg`);
    assert.strictEqual(res.status, 200, `/badge/${slug}.svg returned ${res.status}`);
    const label = badgeLabel(await res.text());
    const verdict = BADGE_VERDICT[label] ?? "unconfirmed";
    if (!BADGE_VERDICT[label]) {
      assert.match(label, /^unrated/, `${vendor} carries an unrecognised badge label "${label}"`);
    }
    const enriched = enrichOffers([primary])[0];
    const unreachable = enriched.link_unreachable;
    const withheld = levelWithheldReason(primary, unreachable);
    const since = unreachable?.last_reachable ? ` since ${unreachable.last_reachable}` : "";
    const reasonsItCouldGive = [
      gateFor(primary, servedOn)?.reason,
      withheld ? withheldLevelSentence(withheld, vendor, since) : null,
      ratingWithheldForNoSourceSentence(vendor),
    ].filter((r): r is string => typeof r === "string" && r !== "");

    sides.set(vendor, {
      vendor,
      slug,
      verdict,
      tier: primary.tier,
      description: primary.description,
      superseded: supersedingChange(
        primary,
        changes.filter((c: { vendor: string }) => c.vendor.toLowerCase() === vendor.toLowerCase()),
      ) !== null,
      reasonsItCouldGive,
    });
  });
});

after(() => { if (proc) proc.kill(); });

let renderedPages: Map<string, string> | null = null;

async function everyComparisonPage(): Promise<Map<string, string>> {
  if (renderedPages) return renderedPages;
  const html = new Map<string, string>();
  await fetchAll(pairs, async ({ slug }) => {
    const res = await fetch(`http://localhost:${serverPort}/compare/${slug}`);
    assert.strictEqual(res.status, 200, `/compare/${slug} returned ${res.status}`);
    html.set(slug, await res.text());
  });
  renderedPages = html;
  return html;
}

function verdictOf(html: string): string {
  const section = html.match(/class="verdict-section">([\s\S]*?)<\/div>/)?.[1] ?? "";
  return unescHtml(section.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "").trim();
}

function jsonLdBlocks(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => JSON.parse(m[1]) as Record<string, unknown>);
}

function itemListOf(html: string): { name: string; description: string; offers?: { price?: string } }[] {
  const page = jsonLdBlocks(html).find(b => b["@type"] === "WebPage") as
    { mainEntity: { itemListElement: { item: { name: string; description: string; offers?: { price?: string } } }[] } };
  return page.mainEntity.itemListElement.map(e => e.item);
}

function faqAnswers(html: string): string[] {
  const faq = jsonLdBlocks(html).find(b => b["@type"] === "FAQPage") as
    { mainEntity: { acceptedAnswer: { text: string } }[] };
  return faq.mainEntity.map(q => q.acceptedAnswer.text);
}

function assertsAFreeTier(verdict: string, side: Side, other: Side): boolean {
  const both = `Both ${side.vendor} and ${other.vendor} offer free tiers.`;
  const bothReversed = `Both ${other.vendor} and ${side.vendor} offer free tiers.`;
  if (verdict.startsWith(both) || verdict.startsWith(bothReversed)) return true;
  return verdict.includes(`${side.vendor} offers a free tier ("`);
}

describe("#1393 the comparison page answers the free-tier question the way the rest of the site answers it", () => {
  it("asserts a free tier for exactly the vendors the badge rates one for, on every page", async () => {
    const pages = await everyComparisonPage();
    const assertsWhatTheSiteWillNot: string[] = [];
    const withholdsWhereTheSitePublishes: string[] = [];
    let asserted = 0;

    for (const pair of pairs) {
      const verdict = verdictOf(pages.get(pair.slug)!);
      assert.notStrictEqual(verdict, "", `/compare/${pair.slug} publishes no verdict`);
      for (const [vendor, otherVendor] of [[pair.a, pair.b], [pair.b, pair.a]]) {
        const side = sides.get(vendor)!;
        const other = sides.get(otherVendor)!;
        const asserts = assertsAFreeTier(verdict, side, other);
        if (asserts) asserted++;
        if (asserts && side.verdict !== "offered") {
          assertsWhatTheSiteWillNot.push(`/compare/${pair.slug} — ${vendor} is ${side.verdict}`);
        }
        if (!asserts && side.verdict === "offered") {
          withholdsWhereTheSitePublishes.push(`/compare/${pair.slug} — ${vendor}`);
        }
      }
    }

    assert.deepStrictEqual(assertsWhatTheSiteWillNot, [], "a comparison asserts a free tier the badge does not rate");
    assert.deepStrictEqual(withholdsWhereTheSitePublishes, [], "a comparison withholds a free tier the badge rates");
    assert.ok(asserted > 300, `only ${asserted} slots assert a free tier`);
  });

  it("states why it is withholding, on every slot the site does not rate", async () => {
    const pages = await everyComparisonPage();
    const silent: string[] = [];
    const unreasoned: string[] = [];
    let withholdingSlots = 0;

    for (const pair of pairs) {
      const verdict = verdictOf(pages.get(pair.slug)!);
      for (const vendor of [pair.a, pair.b]) {
        const side = sides.get(vendor)!;
        if (side.verdict !== "unconfirmed") continue;
        withholdingSlots++;
        if (!verdict.includes(`free-tier verdict for ${vendor}.`) && !verdict.includes(`free-tier verdict for either `)) {
          silent.push(`/compare/${pair.slug} — ${vendor}`);
        }
        if (!side.reasonsItCouldGive.some(reason => verdict.includes(reason))) {
          unreasoned.push(`/compare/${pair.slug} — ${vendor}`);
        }
      }
    }

    assert.deepStrictEqual(silent, [], "a comparison withholds without saying so in the claim");
    assert.deepStrictEqual(unreasoned, [], "a comparison withholds without naming a reason we hold");
    assert.ok(withholdingSlots > 100, `only ${withholdingSlots} slots withhold`);
  });

  it("never publishes stored terms a change record supersedes", async () => {
    const pages = await everyComparisonPage();
    const republished: string[] = [];
    let withheld = 0;

    for (const pair of pairs) {
      const html = pages.get(pair.slug)!;
      for (const vendor of [pair.a, pair.b]) {
        const side = sides.get(vendor)!;
        if (!side.superseded) continue;
        withheld++;
        if (html.includes(escHtml(side.description))) republished.push(`/compare/${pair.slug} — ${vendor}`);
        if (!html.includes("Superseded:")) republished.push(`/compare/${pair.slug} — ${vendor} states no supersession`);
      }
    }

    assert.deepStrictEqual(republished, [], "a comparison publishes terms our own record supersedes");
    assert.ok(withheld > 0, "no superseded side was exercised");
  });

  it("keeps the stored terms of every side no record supersedes", async () => {
    const pages = await everyComparisonPage();
    const dropped: string[] = [];

    for (const pair of pairs) {
      const html = pages.get(pair.slug)!;
      for (const vendor of [pair.a, pair.b]) {
        const side = sides.get(vendor)!;
        if (side.superseded) continue;
        if (!html.includes(escHtml(side.description))) dropped.push(`/compare/${pair.slug} — ${vendor}`);
      }
    }

    assert.deepStrictEqual(dropped, [], "a comparison dropped terms nothing supersedes");
  });

  it("prices an Offer at zero only where it says in prose that the free tier exists", async () => {
    const pages = await everyComparisonPage();
    const priced: string[] = [];
    const missing: string[] = [];
    let offerBlocks = 0;

    for (const pair of pairs) {
      const items = itemListOf(pages.get(pair.slug)!);
      for (const item of items) {
        const side = sides.get(item.name)!;
        const publishable = side.verdict === "offered" && !side.superseded;
        if (item.offers) {
          offerBlocks++;
          assert.strictEqual(item.offers.price, "0", `${item.name} publishes a non-zero Offer`);
          if (!publishable) priced.push(`/compare/${pair.slug} — ${item.name} is ${side.verdict}`);
        } else if (publishable) {
          missing.push(`/compare/${pair.slug} — ${item.name}`);
        }
      }
    }

    assert.deepStrictEqual(priced, [], "a machine-readable Offer prices a free tier the page will not vouch for");
    assert.deepStrictEqual(missing, [], "a rated free tier lost its Offer block");
    assert.ok(offerBlocks > 0, "no Offer block was exercised");
  });

  it("takes its FAQ provenance from its own route, not from a page whose path its slug happens to match", async () => {
    const { faqPageJsonLd, pageFaqProvenanceClause } = await import("../dist/faq-provenance.js");
    const pages = await everyComparisonPage();
    const borrowed: string[] = [];
    let collisions = 0;

    for (const pair of pairs) {
      const foreign = pageFaqProvenanceClause(`/${pair.slug}`);
      const own = pageFaqProvenanceClause(`/compare/${pair.slug}`);
      if (foreign === "" || foreign === own) continue;
      collisions++;

      const statesAFigure = [{ q: `What does ${pair.a} include?`, a: `The free tier includes 100 GB of bandwidth.` }];
      const asItsOwnRoute = JSON.stringify(faqPageJsonLd(`/compare/${pair.slug}`, statesAFigure));
      const asTheOtherPage = JSON.stringify(faqPageJsonLd(`/${pair.slug}`, statesAFigure));
      assert.notStrictEqual(asItsOwnRoute, asTheOtherPage, `/compare/${pair.slug} cannot tell the two routes apart`);
      assert.ok(asTheOtherPage.includes(foreign), `/${pair.slug} stopped carrying its own clause`);
      assert.ok(!asItsOwnRoute.includes(foreign), `/compare/${pair.slug} inherits another page's clause`);

      for (const answer of faqAnswers(pages.get(pair.slug)!)) {
        if (answer.includes(foreign)) borrowed.push(`/compare/${pair.slug}`);
      }
    }

    assert.deepStrictEqual(borrowed, [], "a comparison page carries another page's provenance clause");
    assert.ok(collisions > 0, "no slug collision was exercised");
  });

  it("leaves a page reading as it did where the site rates both free tiers", async () => {
    const pages = await everyComparisonPage();
    const changed: string[] = [];
    let bothRated = 0;

    for (const pair of pairs) {
      const a = sides.get(pair.a)!;
      const b = sides.get(pair.b)!;
      if (a.verdict !== "offered" || b.verdict !== "offered") continue;
      bothRated++;
      const verdict = verdictOf(pages.get(pair.slug)!);
      const expected = `Both ${a.vendor} and ${b.vendor} offer free tiers. ${a.vendor} provides "${a.tier}" while ${b.vendor} offers "${b.tier}".`;
      if (!verdict.startsWith(expected)) changed.push(`/compare/${pair.slug}`);
    }

    assert.deepStrictEqual(changed, [], "a page the site rates on both sides stopped reading the way it did");
    assert.ok(bothRated > 50, `only ${bothRated} pages rate both sides`);
  });
});
