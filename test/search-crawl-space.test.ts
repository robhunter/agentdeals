import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_SOURCE = path.join(__dirname, "..", "src", "serve.ts");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const p = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 15000);
    p.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
    });
    p.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function get(routePath: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${routePath}`, { headers });
  return res.text();
}

function anchors(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
}

function queryBearingSearchAnchors(html: string): string[] {
  return anchors(html).filter((tag) => /href="(?:https?:\/\/[^/"]+)?\/search\?/.test(tag));
}

function bareSearchAnchors(html: string): string[] {
  return anchors(html).filter((tag) => /href="(?:https?:\/\/[^/"]+)?\/search"/.test(tag));
}

function hrefOf(tag: string): string {
  const m = tag.match(/href="([^"]*)"/);
  return m ? m[1].replace(/&amp;/g, "&") : "";
}

const SEARCH_VARIANTS = [
  "/search",
  "/search?q=vercel",
  "/search?q=database&page=2",
  "/search?category=CDN",
  "/search?type=oss&sort=vendor",
  "/search?q=vercel&category=CDN&type=public&sort=newest",
];

const PAGES_LINKING_INTO_SEARCH = [
  "/terraform-cloud-free-tier-removed",
  "/hcp-terraform-migration",
  "/firebase-alternatives",
  "/postman-alternatives",
  "/google-developer-program-2026",
];

describe("search facet space is closed to crawlers", () => {
  before(async () => { proc = await startHttpServer(); });
  after(() => { if (proc) { proc.kill(); proc = null; } });

  it("robots.txt disallows the query-bearing search space", async () => {
    const body = await get("/robots.txt");
    assert.ok(body.includes("Disallow: /search?"), `robots.txt should disallow the search query space, got:\n${body}`);
  });

  it("robots.txt states the disallow before the site-wide allow", async () => {
    const body = await get("/robots.txt");
    const disallowAt = body.indexOf("Disallow: /search?");
    const allowAt = body.indexOf("Allow: /");
    assert.ok(allowAt >= 0, "robots.txt should still allow the rest of the site");
    assert.ok(disallowAt < allowAt, "a first-match parser must see the disallow before the site-wide allow");
  });

  it("robots.txt still points at the sitemap index", async () => {
    const body = await get("/robots.txt");
    assert.match(body, /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
  });

  it("robots.txt is not cacheable for longer than an hour", async () => {
    const res = await fetch(`http://localhost:${serverPort}/robots.txt`);
    const maxAge = res.headers.get("cache-control")?.match(/max-age=(\d+)/);
    assert.ok(maxAge, `robots.txt should still declare a max-age, got ${res.headers.get("cache-control")}`);
    assert.ok(
      Number(maxAge![1]) <= 3600,
      `a rule a crawler cannot see is not in force: an edge cache would serve the previous robots.txt for ${maxAge![1]} seconds`
    );
  });

  for (const variant of SEARCH_VARIANTS) {
    it(`${variant} asks not to be indexed`, async () => {
      const html = await get(variant);
      assert.ok(
        html.includes('<meta name="robots" content="noindex,follow">'),
        `${variant} should carry a noindex,follow robots meta`
      );
    });
  }

  it("the search page is absent from the sitemap it asks not to be indexed in", async () => {
    const sitemap = await get("/sitemap-pages.xml");
    const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, ""));
    assert.ok(locs.length > 100, `sitemap-pages.xml should still list the site, got ${locs.length} entries`);
    assert.ok(!locs.includes("/search"), "a noindex page should not be submitted for indexing");
  });

  for (const variant of SEARCH_VARIANTS) {
    it(`${variant} marks every link back into the facet space nofollow`, async () => {
      const html = await get(variant);
      const found = queryBearingSearchAnchors(html);
      assert.ok(found.length > 0, `${variant} should publish facet links for a human to click`);
      const followed = found.filter((tag) => !/\brel="[^"]*nofollow[^"]*"/.test(tag));
      assert.deepStrictEqual(followed, [], `${variant} publishes crawlable facet links`);
    });
  }

  for (const variant of ["/search", "/search?category=CDN"]) {
    it(`${variant} keeps the unfiltered search address followable`, async () => {
      const html = await get(variant);
      const bare = bareSearchAnchors(html);
      assert.ok(bare.length > 0, `${variant} should still link to the unfiltered search page`);
      for (const tag of bare) {
        assert.ok(!/nofollow/.test(tag), `a noindex,follow page needs its own address reachable: ${tag}`);
      }
    });
  }

  it("the next-page link carries the query and lands on later results", async () => {
    const first = await get("/search?q=database");
    const next = queryBearingSearchAnchors(first)
      .filter((tag) => /class="page-link"/.test(tag))
      .map(hrefOf)
      .find((href) => href.includes("page=2"));
    assert.ok(next, "a query with more than one page of results should publish a next-page link");
    assert.ok(next!.includes("q=database"), `the next-page link should keep the query, got ${next}`);
    const second = await get(next!);
    const firstVendors = [...first.matchAll(/class="result-vendor">([^<]+)</g)].map((m) => m[1]);
    const secondVendors = [...second.matchAll(/class="result-vendor">([^<]+)</g)].map((m) => m[1]);
    assert.ok(secondVendors.length > 0, "the second page should still render results");
    assert.deepStrictEqual(firstVendors.filter((v) => secondVendors.includes(v)), [], "the second page should not repeat the first");
  });

  for (const page of PAGES_LINKING_INTO_SEARCH) {
    it(`${page} marks its search links nofollow`, async () => {
      const html = await get(page);
      const found = queryBearingSearchAnchors(html);
      assert.ok(found.length > 0, `${page} should still link into search`);
      const followed = found.filter((tag) => !/\brel="[^"]*nofollow[^"]*"/.test(tag));
      assert.deepStrictEqual(followed, [], `${page} publishes crawlable search links`);
    });
  }

  it("every search link an editorial page publishes still resolves", async () => {
    const targets = new Set<string>();
    for (const page of PAGES_LINKING_INTO_SEARCH) {
      for (const tag of queryBearingSearchAnchors(await get(page))) targets.add(hrefOf(tag));
    }
    assert.ok(targets.size > 0, "editorial pages should still link into search");
    for (const target of targets) {
      const res = await fetch(`http://localhost:${serverPort}${target}`);
      assert.strictEqual(res.status, 200, `${target} should still serve a result page`);
      assert.ok((await res.text()).includes("search-input"), `${target} should still render the search page`);
    }
  });

  it("search results do not vary by user agent", async () => {
    const agents = [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
      "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "python-httpx/0.28.1",
      "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0 Safari/537.36 (compatible; AionBot/1.0)",
    ];
    for (const route of ["/search", "/search?q=database"]) {
      const bodies = await Promise.all(agents.map((ua) => get(route, { "User-Agent": ua })));
      const cardCounts = bodies.map((b) => (b.match(/class="result-card"/g) ?? []).length);
      assert.strictEqual(new Set(cardCounts).size, 1, `${route} returned ${cardCounts.join("/")} results across agents`);
    }
    const withResults = await get("/search?q=database");
    assert.ok((withResults.match(/class="result-card"/g) ?? []).length > 0, "a query with matches should still return them");
  });

  it("no hand-written search link escapes the nofollow rule", async () => {
    const source = readFileSync(SERVE_SOURCE, "utf8");
    const needle = 'href="/search?';
    const unmarked: string[] = [];
    let at = source.indexOf(needle);
    while (at !== -1) {
      const tagEnd = source.indexOf(">", at);
      const tail = tagEnd === -1 ? source.slice(at, at + 200) : source.slice(at, tagEnd);
      if (!tail.includes("nofollow")) unmarked.push(tail.slice(0, 160));
      at = source.indexOf(needle, at + needle.length);
    }
    assert.deepStrictEqual(unmarked, [], "a literal search link must carry rel=\"nofollow\"");
  });
});
