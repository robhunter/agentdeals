import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const denoDeploy = catalogue.offers.find((offer: { vendor: string }) => offer.vendor === "Deno Deploy");
const SHUTDOWN_CONDITION: string = denoDeploy?.conditions?.find((condition: { text: string }) => /shut down/.test(condition.text))?.text ?? "";

const HOSTING_GUIDE = "/hosting-free-tier-comparison-2026";
const NAME_IT_IN_HAND_TYPED_COPY = [
  HOSTING_GUIDE,
  "/hosting-pricing",
  "/serverless-free-tier-comparison-2026",
  "/hosting-alternatives",
  "/heroku-alternatives",
  "/vercel-alternatives",
];
const CONDITIONS_ROW_UNDER_ITS_FIRST_ROW: Record<string, string> = {
  "/serverless-free-tier-comparison-2026": 'id="main-comparison"',
  "/hosting-alternatives": "<h2>Free Hosting Comparison</h2>",
  "/heroku-alternatives": "<h2>Free Tier Comparison</h2>",
  "/vercel-alternatives": "<h2>Free Tier Comparison</h2>",
};
const ONLY_MENTION_WENT_WITH_ITS_LIST = "/vercel-vs-netlify";
const HAND_TYPED_SHUTDOWN_COPY = [
  "Deno Deploy shuts down about six months after 2026-10-09",
  "Shutting down: Deno is joining Cloudflare",
];
const LEDES_LISTING_PICKS = ["/heroku-alternatives", "/vercel-alternatives"];
const LEDES_LISTING_WHAT_THE_PAGE_COMPARES = ["/hosting-pricing", "/serverless-free-tier-comparison-2026", HOSTING_GUIDE];

const PICKS_NO_LONGER_MADE: Record<string, { withdrawn: string[]; served: string[] }> = {
  "/serverless-free-tier-comparison-2026": {
    withdrawn: ["Quick scripts and prototypes → Val Town or Deno Deploy", "Deno Deploy: full TypeScript runtime with Web APIs"],
    served: ["Quick scripts and prototypes → Cloudflare Workers Cloudflare Workers: write a function in the Cloudflare dashboard and get a workers.dev URL."],
  },
  "/hosting-alternatives": {
    withdrawn: ["Deno Deploy for TypeScript-native."],
    served: ["Cloudflare Workers (100K req/day, edge-fast) for lightweight APIs. Google Cloud Run for containerized APIs with auto-scale."],
  },
  "/hosting-pricing": {
    withdrawn: ["Deno Deploy (1M req/month free)", "Deno Deploy (1M requests/month)", "Deno Deploy (1M req/month)", "The edge platforms (Cloudflare, Deno Deploy)"],
    served: [
      "Cloudflare Workers (100K req/day free, zero cold starts, 300+ edge locations).",
      "For full-stack apps, Vercel's Hobby plan (100 GB of Fast Data Transfer, builds included; non-commercial use only) is a strong free option.",
      "For serverless APIs: Cloudflare Workers (100K req/day free).",
      "Cloudflare has bucked this trend with a generous free tier, likely subsidized by its broader platform.",
    ],
  },
  "/vercel-alternatives": {
    withdrawn: ["Edge-first options (Deno Deploy, Cloudflare Workers)"],
    served: ["Edge-first options such as Cloudflare Workers optimize for performance. And self-hosted tools (Coolify)"],
  },
};
const FAQ_ANSWERS_NO_LONGER_PICKING_IT = [
  "For full-stack apps, Vercel's Hobby plan (100 GB of Fast Data Transfer, builds included; non-commercial use only) is a strong free option.",
  "For serverless APIs: Cloudflare Workers (100K req/day free).",
];
const SITEMAPS_OF_GUIDES_AND_COMPARISONS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml", "/sitemap-comparisons.xml"];

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&rarr;/g, "→")
    .replace(/&mdash;/g, "—")
    .replace(/&#10003;/g, "✓")
    .replace(/&#10007;/g, "✗")
    .replace(/\s+/g, " ")
    .replace(/ ([,.:;])/g, "$1")
    .trim();
}

function ledeOf(html: string): string {
  return textOf(html.match(/<p class="page-claim">([\s\S]*?)<\/p>/)?.[1] ?? "");
}

function metaContentsOf(html: string): string[] {
  return [...html.matchAll(/<meta\s[^>]*content="([^"]*)"/g)].map(([, content]) => textOf(content));
}

function faqAnswersOf(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .flatMap(([, raw]) => {
      try {
        return [JSON.parse(raw)];
      } catch {
        return [];
      }
    })
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .filter((entry) => entry?.["@type"] === "FAQPage")
    .flatMap((entry) => (entry.mainEntity ?? []).map((q: { acceptedAnswer?: { text?: string } }) => q.acceptedAnswer?.text ?? ""));
}

function tableAfter(html: string, anchor: string): string {
  const at = html.indexOf(anchor);
  assert.ok(at >= 0, `the page has ${anchor}`);
  const start = html.indexOf("<table", at);
  return html.slice(start, html.indexOf("</table>", start));
}

function rowsOf(table: string): string[] {
  return [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(([row]) => row);
}

function cellsOf(row: string): string[] {
  return [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell]) => textOf(cell));
}

function denoDeployRowIndex(rows: string[]): number {
  return rows.findIndex((row) => cellsOf(row)[0]?.startsWith("Deno Deploy"));
}

function cardNamesUnder(html: string, heading: string): string[] {
  const at = html.indexOf(heading);
  assert.ok(at >= 0, `the page has ${heading}`);
  const section = html.slice(at, html.indexOf("<h2", at + heading.length));
  return [...section.matchAll(/class="alt-card-name">([^<]+)</g)].map(([, name]) => name);
}

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

describe("pages that name Deno Deploy say it shuts down, and none picks it for a new project", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const routes = new Set<string>([...NAME_IT_IN_HAND_TYPED_COPY, ONLY_MENTION_WENT_WITH_ITS_LIST]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_COMPARISONS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("holds a listing condition that states the shutdown, and reads every page whose own copy names Deno Deploy", () => {
    assert.match(SHUTDOWN_CONDITION, /Deno Deploy will keep running for six months and then shut down/);
    assert.deepStrictEqual([...NAME_IT_IN_HAND_TYPED_COPY, ONLY_MENTION_WENT_WITH_ITS_LIST].filter((route) => !served.has(route)), []);
  });

  it("states the shutdown, in the listing condition's words, on every page whose own copy names Deno Deploy", () => {
    assert.match(SHUTDOWN_CONDITION, /shut down/, "the listing holds a shutdown condition to print");
    assert.deepStrictEqual(NAME_IT_IN_HAND_TYPED_COPY.filter((route) => !textOf(served.get(route)!).includes(SHUTDOWN_CONDITION)), []);
  });

  it("prints that condition in the row directly under Deno Deploy's first row where a comparison table names it", () => {
    assert.match(SHUTDOWN_CONDITION, /shut down/, "the listing holds a shutdown condition to print");
    for (const [route, anchor] of Object.entries(CONDITIONS_ROW_UNDER_ITS_FIRST_ROW)) {
      const rows = rowsOf(tableAfter(served.get(route)!, anchor));
      const at = denoDeployRowIndex(rows);
      assert.ok(at > 0, `${route} lists Deno Deploy after ${anchor}`);
      const under = rows[at + 1] ?? "";
      assert.ok(under.startsWith('<tr class="vendor-conditions-row"'), `${route}: the row under Deno Deploy's is its conditions row`);
      assert.ok(textOf(under).includes(SHUTDOWN_CONDITION), `${route}: ${textOf(under).slice(0, 300)}`);
    }
  });

  it("states the shutdown in no hand-typed copy of its own on any guide or comparison", () => {
    const stating = [...served].filter(([, html]) => HAND_TYPED_SHUTDOWN_COPY.some((copy) => textOf(html).includes(copy))).map(([route]) => route);
    assert.deepStrictEqual(stating, []);
  });

  it("no longer marks Deno Deploy a permanent free tier in the hosting guide's table", () => {
    const rows = rowsOf(tableAfter(served.get(HOSTING_GUIDE)!, 'id="main-comparison"'));
    const column = cellsOf(rows[0]).indexOf("Permanent Free");
    assert.ok(column > 0, "the table has a Permanent Free column");
    const at = denoDeployRowIndex(rows);
    assert.ok(at > 0, "the table has a Deno Deploy row");
    assert.strictEqual(cellsOf(rows[at])[column], "✗");
  });

  it("no longer answers that Deno Deploy is always free in the serverless comparison's main table", () => {
    const rows = rowsOf(tableAfter(served.get("/serverless-free-tier-comparison-2026")!, 'id="main-comparison"'));
    const column = cellsOf(rows[0]).indexOf("Always Free?");
    assert.ok(column > 0, "the table has an Always Free? column");
    const at = denoDeployRowIndex(rows);
    assert.ok(at > 0, "the table has a Deno Deploy row");
    assert.strictEqual(cellsOf(rows[at])[column], "No");
  });

  it("names Deno Deploy in no lede that lists picks, and still in the ledes that list what a page compares", () => {
    for (const route of LEDES_LISTING_PICKS) {
      const html = served.get(route)!;
      assert.ok(ledeOf(html).includes("Compare free"), `${route} has its lede: ${ledeOf(html)}`);
      assert.deepStrictEqual([ledeOf(html), ...metaContentsOf(html)].filter((text) => text.includes("Deno Deploy")), [], route);
    }
    assert.deepStrictEqual(LEDES_LISTING_WHAT_THE_PAGE_COMPARES.filter((route) => !ledeOf(served.get(route)!).includes("Deno Deploy")), []);
  });

  it("makes none of the picks of Deno Deploy it used to, and serves the sentences that replace them", () => {
    for (const [route, { withdrawn, served: replacing }] of Object.entries(PICKS_NO_LONGER_MADE)) {
      const html = served.get(route)!;
      const readable = [textOf(html), ...faqAnswersOf(html)];
      assert.deepStrictEqual(withdrawn.filter((pick) => readable.some((text) => text.includes(pick))), [], route);
      assert.deepStrictEqual(replacing.filter((sentence) => !textOf(html).includes(sentence)), [], route);
    }
  });

  it("gives /hosting-pricing's structured FAQ answers the same picks as the page, none of them Deno Deploy", () => {
    const answers = faqAnswersOf(served.get("/hosting-pricing")!);
    assert.ok(answers.length > 0, "the page publishes FAQ answers");
    assert.deepStrictEqual(FAQ_ANSWERS_NO_LONGER_PICKING_IT.filter((sentence) => !answers.some((answer) => answer.includes(sentence))), []);
    assert.deepStrictEqual(answers.filter((answer) => answer.includes("Deno Deploy")), []);
  });

  it("lists Deno Deploy among neither /hosting-alternatives' app platforms nor /vercel-vs-netlify's alternatives", () => {
    const platforms = cardNamesUnder(served.get("/hosting-alternatives")!, "App Platforms / PaaS</h2>");
    assert.ok(platforms.includes("Render"), `the app platforms still list Render: ${platforms.join(", ")}`);
    assert.ok(!platforms.includes("Deno Deploy"), `the app platforms: ${platforms.join(", ")}`);
    const html = served.get(ONLY_MENTION_WENT_WITH_ITS_LIST)!;
    const at = html.indexOf('id="alternatives"');
    assert.ok(at >= 0, "the comparison has an alternatives section");
    const alternatives = rowsOf(html.slice(at, html.indexOf("</table>", at))).map((row) => cellsOf(row)[0]);
    assert.ok(alternatives.includes("Render"), `the alternatives still list Render: ${alternatives.join(", ")}`);
    assert.ok(!alternatives.includes("Deno Deploy"), `the alternatives: ${alternatives.join(", ")}`);
    assert.ok(!html.includes("Deno Deploy"), "the comparison names Deno Deploy nowhere else");
  });

  it("keeps Deno Deploy in /api/hosting-pricing's edge-serverless platforms", async () => {
    const response = await fetch(`${base}/api/hosting-pricing?type=edge-serverless`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as { platforms: { vendor: string; category: string }[] };
    assert.ok(body.platforms.some((platform) => platform.vendor === "Deno Deploy" && platform.category === "edge-serverless"));
  });
});
