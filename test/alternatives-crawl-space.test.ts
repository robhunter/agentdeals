import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const NOINDEX_FOLLOW = '<meta name="robots" content="noindex,follow">';

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

interface Rendered {
  slug: string;
  status: number;
  body: string;
  named: number;
}

const pages = new Map<string, Rendered>();
let submitted = new Set<string>();

function substituteNames(body: string): number {
  return (body.match(/class="alt-vendor-name"/g) ?? []).length;
}

async function renderAll(slugs: string[]): Promise<void> {
  const queue = [...slugs];
  const worker = async () => {
    for (let slug = queue.pop(); slug !== undefined; slug = queue.pop()) {
      const res = await fetch(`http://localhost:${serverPort}/alternative-to/${slug}`);
      const body = await res.text();
      pages.set(slug, { slug, status: res.status, body, named: substituteNames(body) });
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
}

const withSubstitutes = () => [...pages.values()].filter(p => p.named > 0);
const withoutSubstitutes = () => [...pages.values()].filter(p => p.named === 0);

before(async () => {
  proc = await startServer();
  const slugs = [...new Set(offers.map(o => slugOf(o.vendor)))];
  await renderAll(slugs);
  const sitemap = await (await fetch(`http://localhost:${serverPort}/sitemap-pages.xml`)).text();
  submitted = new Set([...sitemap.matchAll(/<loc>[^<]*\/alternative-to\/([^<]+)<\/loc>/g)].map(m => m[1]));
  assert.ok(pages.size > 1000, `every vendor must have an alternatives page for this test to mean anything, rendered ${pages.size}`);
  assert.ok(withSubstitutes().length > 0, "some page must name a substitute for this test to mean anything");
  assert.ok(withoutSubstitutes().length > 0, "some page must name none for this test to mean anything");
});

after(() => { if (proc) proc.kill(); });

describe("#1209 a page that names no substitute is served but not submitted", () => {
  it("keeps every vendor address live, whether or not it names a substitute", () => {
    const dead = [...pages.values()].filter(p => p.status !== 200).map(p => `${p.slug} (${p.status})`);
    assert.deepEqual(dead, [], "a vendor page links here, and the list returns when the vendor is classified");
  });

  it("asks not to be indexed when it names none", () => {
    const indexable = withoutSubstitutes().filter(p => !p.body.includes(NOINDEX_FOLLOW)).map(p => p.slug);
    assert.deepEqual(indexable.slice(0, 10), [], `${indexable.length} pages naming no substitute ask to be indexed`);
  });

  it("stays indexable when it names one", () => {
    const blocked = withSubstitutes().filter(p => p.body.includes(NOINDEX_FOLLOW)).map(p => p.slug);
    assert.deepEqual(blocked.slice(0, 10), [], `${blocked.length} pages naming a substitute ask not to be indexed`);
  });

  it("lets a crawler follow the links out of a page it may not index", () => {
    for (const page of withoutSubstitutes().slice(0, 50)) {
      const tag = page.body.match(/<meta name="robots"[^>]*>/);
      assert.ok(tag, `${page.slug} must carry a robots tag`);
      assert.ok(!/nofollow/.test(tag[0]), `${page.slug} names a category page worth crawling`);
    }
  });

  it("submits an address for indexing only when the page behind it names a substitute", () => {
    const disagreements: string[] = [];
    for (const page of pages.values()) {
      const wanted = page.named > 0;
      if (submitted.has(page.slug) !== wanted) {
        disagreements.push(`${page.slug} names ${page.named} and is ${submitted.has(page.slug) ? "" : "not "}submitted`);
      }
    }
    assert.deepEqual(disagreements.slice(0, 10), [], `${disagreements.length} addresses disagree with the page they point at`);
    assert.equal(submitted.size, withSubstitutes().length);
  });
});

describe("#1209 a page that names no substitute makes no claim it cannot support", () => {
  it("does not offer a question it cannot answer", () => {
    const withFaq = withoutSubstitutes().filter(p => p.body.includes('"@type":"FAQPage"')).map(p => p.slug);
    assert.deepEqual(withFaq.slice(0, 10), [], `${withFaq.length} pages naming no substitute publish FAQ structured data`);
  });

  it("publishes no list for a machine to read", () => {
    const withList = withoutSubstitutes().filter(p => p.body.includes('"@type":"ItemList"')).map(p => p.slug);
    assert.deepEqual(withList.slice(0, 10), [], `${withList.length} pages naming no substitute publish an ItemList`);
  });

  it("does not promise a list in the title or the heading", () => {
    const promising = withoutSubstitutes()
      .filter(p => /<title>Best /.test(p.body) || /<h1>Best /.test(p.body))
      .map(p => p.slug);
    assert.deepEqual(promising.slice(0, 10), [], `${promising.length} pages naming no substitute are titled as a list of the best ones`);
  });

  it("sends the reader to the category the vendor is listed in, in place of the list", () => {
    const byVendor = new Map<string, string>();
    for (const offer of offers) {
      if (!byVendor.has(slugOf(offer.vendor))) byVendor.set(slugOf(offer.vendor), offer.category);
    }
    const missing: string[] = [];
    for (const page of withoutSubstitutes()) {
      const category = byVendor.get(page.slug);
      if (!category) continue;
      const lede = page.body.match(/<p class="page-meta">[\s\S]*?<\/p>/);
      if (!lede || !lede[0].includes(`href="/category/${slugOf(category)}"`)) missing.push(page.slug);
    }
    assert.deepEqual(missing.slice(0, 10), [], `${missing.length} pages naming no substitute offer the reader nowhere to go`);
  });

  it("keeps naming the substitutes it has where it has them", () => {
    const named = withSubstitutes();
    const total = named.reduce((sum, p) => sum + p.named, 0);
    assert.ok(total >= named.length, "a page counted as naming substitutes must name at least one each");
    for (const page of named.slice(0, 20)) {
      assert.ok(page.body.includes('"@type":"ItemList"'), `${page.slug} names substitutes and must publish them for a machine to read`);
      assert.ok(/<title>Best /.test(page.body), `${page.slug} names substitutes and its title says so`);
    }
  });
});
