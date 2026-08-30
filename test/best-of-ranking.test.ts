// The rendered half of #1025: what a reader and a crawler actually see once
// selection goes through the shared module.
//
// The assertions worth having here are the ones a unit test cannot make: that
// the tie is disclosed above the list rather than hidden by a top-8 cut, that
// a demoted vendor is still on the page with its reason attached, and that the
// seed we publish is the seed we used.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const child = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 15000);
    child.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
};

before(async () => { proc = await startHttpServer(); });
after(() => { if (proc) proc.kill(); });

describe("/best/:slug shows the whole qualified band", () => {
  it("lists every offer that clears the gates, not a top 8", async () => {
    const { status, html } = await get("/best/free-databases");
    assert.strictEqual(status, 200);
    const cards = (html.match(/class="best-pick"/g) ?? []).length;
    assert.ok(cards > 8, `expected the full band, got ${cards} cards`);
  });

  it("states the tie in plain language, above the list", async () => {
    const { html } = await get("/best/free-databases");
    const tieNote = html.indexOf("offers meet our criteria for this category");
    const firstCard = html.indexOf('class="best-pick"');
    assert.ok(tieNote > -1, "the tie must be stated");
    assert.ok(tieNote < firstCard, "the tie must be stated above the list, not below it");
    assert.match(html, /none is distinguishable from the others under any signal we record/);
    assert.match(html, /rotates daily/);
  });

  it("keeps a title that matches what people search for", async () => {
    const { html } = await get("/best/free-databases");
    assert.match(html, /<title>Best Free Databases Tools \(\d{4}\) — AgentDeals<\/title>/);
    assert.match(html, /<h1>Best Free Databases Tools<\/h1>/);
  });

  it("keeps demoted vendors on the page with the reason named", async () => {
    const { html } = await get("/best/free-databases");
    assert.match(html, /Demoted &mdash; and exactly why/);
    assert.ok(html.includes("Firebase"), "Firebase withdrew a free tier and should still be listed, below the band");
    assert.match(html, /free_tier_withdrawn/);
    assert.match(html, /Recorded product deprecation on \d{4}-\d{2}-\d{2}/);
  });

  it("discloses a recorded change without letting it move rank", async () => {
    const { html } = await get("/best/free-databases");
    assert.match(html, /Recorded, but does not affect rank/);
    // Supabase's Feb limit reduction is disclosed; it is still in the top band.
    const demotedAt = html.indexOf("Demoted &mdash; and exactly why");
    const supabaseAt = html.indexOf(">Supabase<");
    assert.ok(supabaseAt > -1 && supabaseAt < demotedAt, "Supabase should be in the qualified band");
  });

  it("publishes the seed it used, and the seed is the real one", async () => {
    const { html } = await get("/best/free-databases");
    const date = html.match(/<dt>date<\/dt><dd>(\d{4}-\d{2}-\d{2})<\/dd>/)?.[1];
    const queryKey = html.match(/<dt>query_key<\/dt><dd>([^<]+)<\/dd>/)?.[1];
    const seed = html.match(/<dt>seed<\/dt><dd>([0-9a-f]{64})<\/dd>/)?.[1];
    const tieCount = html.match(/<dt>tie_count<\/dt><dd>(\d+)<\/dd>/)?.[1];
    assert.ok(date && queryKey && seed && tieCount, "the audit block must publish all four fields");
    assert.strictEqual(queryKey, "best-of:Databases");
    const recomputed = createHash("sha256").update(`${date}|${queryKey}|p0`).digest("hex");
    assert.strictEqual(seed, recomputed, "a third party must be able to recompute the published seed");
    const cards = (html.match(/class="best-pick"/g) ?? []).length;
    assert.strictEqual(Number(tieCount), cards, "tie_count must equal the number of qualified entries shown");
  });

  it("links the published criteria from the page", async () => {
    const { html } = await get("/best/free-databases");
    assert.ok(html.includes('href="/criteria"'), "must link to the criteria page");
  });

  it("keeps the structured data consistent with what is rendered", async () => {
    const { html } = await get("/best/free-databases");
    const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"ItemList".*?)<\/script>/s)![1]);
    const cards = (html.match(/class="best-pick"/g) ?? []).length;
    assert.strictEqual(jsonLd.numberOfItems, cards);
    assert.strictEqual(jsonLd.itemListElement.length, cards);
  });
});

describe("/best/:slug is not a mirror of /category/:slug", () => {
  // The kill condition for this page type: if the gates make no difference, the page
  // is duplicate content on 57 URLs and should not exist.
  it("the gates remove offers the category page shows", async () => {
    const best = await get("/best/free-ai-ml");
    const category = await get("/category/ai-ml");
    assert.strictEqual(best.status, 200);
    assert.strictEqual(category.status, 200);
    const bestVendors = new Set([...best.html.matchAll(/class="best-pick-name">([^<]+)</g)].map((m) => m[1]));
    assert.ok(bestVendors.size > 0);
    // Eligibility-restricted and non-free tiers are in the category and not here.
    const index = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "index.json"), "utf8"));
    const gatedOut = index.offers.filter((o: { category: string; eligibility?: unknown }) => o.category === "AI / ML" && o.eligibility);
    assert.ok(gatedOut.length > 0, "fixture assumption: AI/ML has eligibility-gated offers");
    for (const o of gatedOut) {
      assert.ok(!bestVendors.has(o.vendor), `${o.vendor} is eligibility-restricted and must not be on a best-of page`);
    }
  });
});

describe("/criteria publishes the method", () => {
  it("returns the policy sentence verbatim", async () => {
    const { status, html } = await get("/criteria");
    assert.strictEqual(status, 200);
    assert.match(html, /There is no signal a vendor can acquire, lobby for, or buy — there is nothing to add/);
  });

  it("publishes the demerit table with its weights", async () => {
    const { html } = await get("/criteria");
    for (const code of ["free_tier_withdrawn", "time_limited_offer", "stale_verification", "expiring_soon"]) {
      assert.ok(html.includes(code), `${code} must be published`);
    }
    assert.match(html, /&minus;3/);
    assert.match(html, /&minus;2/);
  });

  it("publishes the tie-break algorithm in enough detail to reproduce", async () => {
    const { html } = await get("/criteria");
    assert.match(html, /seed = sha256\(utc_date \+ .{1,8}\|.{1,8} \+ query_key \+ .{1,8}\|p.{1,8} \+ demerit_total\)/);
    assert.match(html, /Fisher-Yates/);
    assert.match(html, /mulberry32/);
    assert.match(html, /No vendor name, slug, id, index or offer field is an input/);
  });

  it("publishes the finding rather than hiding it, and says what it counted", async () => {
    const { html } = await get("/criteria");
    assert.match(html, /Zero of the \d+ categories with a best-of page have a unique number one/);
    assert.match(html, /The site publishes \d+ categories in all/);
    assert.ok(!/of 57 categories have/.test(html), "57 counts best-of pages, and the site publishes more categories than that");
  });

  it("says what we do not model", async () => {
    const { html } = await get("/criteria");
    assert.match(html, /We do not model technical fit/);
  });

  it("is in the sitemap and reachable from the nav", async () => {
    const { html: sitemap } = await get("/sitemap-pages.xml");
    assert.ok(sitemap.includes("/criteria"), "criteria page must be in the sitemap");
    const { html: best } = await get("/best");
    assert.ok(best.includes('href="/criteria"'), "criteria must be linked from the best-of index");
  });

  it("has a canonical URL and structured data", async () => {
    const { html } = await get("/criteria");
    assert.match(html, /<link rel="canonical" href="[^"]*\/criteria">/);
    assert.ok(html.includes("BreadcrumbList"));
  });
});

describe("comparison pages survive the change of pair selection", () => {
  it("a pair we no longer generate still resolves rather than 404ing", async () => {
    // Vendors that exist but are not in the generated set: the URL may have
    // been indexed under the old description.length selection.
    const { status, html } = await get("/compare/supabase-vs-neon");
    assert.ok(status === 200 || status === 301, `expected the page to resolve, got ${status}`);
    if (status === 200) assert.ok(html.includes("Supabase") && html.includes("Neon"));
  });

  it("the non-canonical ordering 301s rather than serving duplicate content", async () => {
    const { status, location } = await get("/compare/xata-vs-nile");
    assert.strictEqual(status, 301);
    assert.strictEqual(location, "/compare/nile-vs-xata");
  });

  it("an unknown vendor still 404s", async () => {
    const { status } = await get("/compare/definitelynotavendor-vs-alsonotavendor");
    assert.strictEqual(status, 404);
  });
});
