import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { offerRetired, recordedTierSentence } = await import("../dist/retirement.js");
const { gateFor, utcDate } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let port = 0;
let proc: ChildProcess | null = null;

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

const pages = new Map<string, string>();

async function page(pathname: string): Promise<string> {
  const cached = pages.get(pathname);
  if (cached !== undefined) return cached;
  const res = await fetch(`http://localhost:${port}${pathname}`);
  const body = await res.text();
  pages.set(pathname, body);
  return body;
}

async function fetchAll(paths: string[], workers = 12): Promise<void> {
  const queue = paths.filter(p => !pages.has(p));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (next < queue.length) await page(queue[next++]);
    }),
  );
}

function jsonLdBlocks(html: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(m[1])); } catch { continue; }
  }
  return out;
}

function blockOfType(html: string, type: string): Record<string, any> | undefined {
  return jsonLdBlocks(html).find(b => b["@type"] === type);
}

function faqAnswer(html: string, prefix: string): string | undefined {
  const faq = blockOfType(html, "FAQPage");
  const item = faq?.mainEntity?.find((q: { name: string }) => q.name.startsWith(prefix));
  return item?.acceptedAnswer?.text;
}

function renderedOffer(html: string): Offer | undefined {
  const webPage = blockOfType(html, "WebPage");
  const vendor = webPage?.mainEntity?.name;
  const tier = webPage?.mainEntity?.offers?.description;
  if (typeof vendor !== "string" || typeof tier !== "string") return undefined;
  return offers.find(o => o.vendor === vendor && o.tier === tier);
}

function anchorsTo(html: string, url: string): number {
  const pattern = new RegExp(`<a [^>]*href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
  return [...html.matchAll(pattern)].length;
}

const retiredRecords = offers.filter(o => offerRetired(o));
const retiredUrls = [...new Set(retiredRecords.map(o => o.url))];
const vendorPaths = [...new Set(offers.map(o => `/vendor/${slugOf(o.vendor)}`))];

type RenderedPage = { slug: string; html: string; offer: Offer };
const renderedVendorPages: RenderedPage[] = [];

let sweptPaths: string[] = [];

before(async () => {
  proc = await startServer();
  const sitemapPaths = new Set<string>(["/", "/best", "/categories", "/vendor"]);
  for (const sitemap of ["/sitemap.xml", "/sitemap-vendors.xml", "/sitemap-comparisons.xml", "/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"]) {
    for (const entry of (await page(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      sitemapPaths.add(new URL(entry[1]).pathname);
    }
  }
  for (const o of offers) {
    sitemapPaths.add(`/vendor/${slugOf(o.vendor)}`);
    sitemapPaths.add(`/alternative-to/${slugOf(o.vendor)}`);
    sitemapPaths.add(`/category/${slugOf(o.category)}`);
  }
  sweptPaths = [...sitemapPaths].sort();
  await fetchAll(sweptPaths);
  for (const p of vendorPaths) {
    const html = await page(p);
    const offer = renderedOffer(html);
    if (offer) renderedVendorPages.push({ slug: p.slice("/vendor/".length), html, offer });
  }
});

after(() => { proc?.kill(); });

describe("a record marked retired in its tier is read as retired", () => {
  it("has a subject in the index, including one whose source check passed", () => {
    assert.ok(retiredRecords.length > 0, "no record in the index carries a retired tier, so this file has no subject");
    const passedItsSourceCheck = retiredRecords.filter(o => o.source_check?.outcome === "ok");
    assert.ok(
      passedItsSourceCheck.length > 0,
      "every retired record is now held back by its source check, so the combination this file guards is untested",
    );
  });

  it("never answers the free-tier question with a bare yes", () => {
    const retiredPages = renderedVendorPages.filter(p => offerRetired(p.offer));
    assert.ok(retiredPages.length > 0, "no vendor page renders a retired record");
    const offenders = retiredPages
      .filter(p => (faqAnswer(p.html, `Is ${p.offer.vendor} free?`) ?? "").startsWith("Yes"))
      .map(p => p.slug);
    assert.deepStrictEqual(offenders, []);
  });

  it("answers it from the stored tier rather than from the description", () => {
    for (const p of renderedVendorPages.filter(x => offerRetired(x.offer))) {
      const sentence = recordedTierSentence(p.offer.vendor, p.offer.tier);
      for (const question of [`Is ${p.offer.vendor} free?`, `What is ${p.offer.vendor}'s free tier?`]) {
        const answer = faqAnswer(p.html, question) ?? "";
        const opening = `${answer.split(". ")[0]}.`;
        assert.ok(
          opening.includes(p.offer.tier),
          `${p.slug} opens its answer to "${question}" without naming the tier it stores: ${opening}`,
        );
        assert.ok(answer.startsWith(sentence), `${p.slug} answers "${question}" with ${answer.slice(0, 70)}`);
      }
    }
  });

  it("sends no reader to the URL it holds for the offer", () => {
    for (const p of renderedVendorPages.filter(x => offerRetired(x.offer))) {
      assert.strictEqual(anchorsTo(p.html, escapeHtml(p.offer.url)), 0, `/vendor/${p.slug} still links to ${p.offer.url}`);
      const application = blockOfType(p.html, "WebPage")?.mainEntity ?? {};
      assert.ok(!("url" in application), `/vendor/${p.slug} publishes ${p.offer.url} as the application URL`);
    }
  });

  it("sends no reader there from any other page we serve either", () => {
    assert.ok(sweptPaths.length > 1000, `swept only ${sweptPaths.length} paths`);
    const offenders: string[] = [];
    for (const p of sweptPaths) {
      const html = pages.get(p) ?? "";
      for (const url of retiredUrls) {
        if (anchorsTo(html, escapeHtml(url)) > 0) offenders.push(`${p} -> ${url}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });
});

describe("a record that is not retired keeps everything the gate would take away", () => {
  it("still links to its pricing page from its vendor page", () => {
    const live = renderedVendorPages.filter(p => !offerRetired(p.offer));
    assert.ok(live.length > 1000, `only ${live.length} vendor pages render a live record`);
    const missing = live.filter(p => anchorsTo(p.html, escapeHtml(p.offer.url)) === 0).map(p => p.slug);
    assert.deepStrictEqual(missing, []);
  });

  it("still publishes that URL as the application URL", () => {
    for (const p of renderedVendorPages.filter(x => !offerRetired(x.offer))) {
      assert.strictEqual(blockOfType(p.html, "WebPage")?.mainEntity?.url, p.offer.url, `/vendor/${p.slug}`);
    }
  });

  it("still answers yes where nothing else withholds the answer", () => {
    const plainlyFree = renderedVendorPages.filter(
      p => !offerRetired(p.offer) && !p.offer.eligibility && p.offer.source_check?.outcome === "ok"
        && !gateFor(p.offer, utcDate())
        && p.offer.tier.toLowerCase() !== "none"
        && !p.offer.description.toLowerCase().includes("no free tier"),
    );
    assert.ok(plainlyFree.length > 100, `only ${plainlyFree.length} vendor pages are plainly free`);
    const quiet = plainlyFree
      .filter(p => !(faqAnswer(p.html, `Is ${p.offer.vendor} free?`) ?? "").startsWith("Yes"))
      .map(p => p.slug);
    assert.deepStrictEqual(quiet, []);
  });
});
