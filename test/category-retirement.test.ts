import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORY_ALIASES,
  CATEGORY_RETIREMENTS,
  CATEGORY_SCOPES,
  buildCategoryDirectory,
  categoryState,
  publishedScopeFor,
  retiredCategoryNames,
  retirementFor,
  scopeFor,
} from "../dist/category-scope.js";
import {
  RETIRED_CATEGORY_BADGE,
  RETIRED_CATEGORY_ONWARD_PATH,
  retiredCategoryDescription,
  retiredCategoryNoticeHtml,
  retiredCategoryStatedOn,
  retiredCategoryTitle,
} from "../dist/category-retirement.js";
import { CATALOGUE_CATEGORY_COUNT } from "../dist/mcp-instructions.js";
import { getCategories, loadOffers } from "../dist/data.js";
import { toSlug } from "../dist/slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const categories = getCategories();
const offers = loadOffers();
const liveNames: ReadonlySet<string> = new Set(categories.map((c) => c.name));

const SLUGS_PUBLISHED_BEFORE_THE_SCOPE_REGISTRY = [
  "ai-coding", "ai-ml", "analytics", "api-development", "api-gateway", "auth",
  "background-jobs", "banking-finance", "browser-automation", "cdn", "ci-cd",
  "cloud-hosting", "cloud-iaas", "cloud-storage", "code-quality", "communication",
  "communication-messaging", "consumer-email", "container-registry", "databases",
  "design", "design-creative", "dev-utilities", "diagramming", "dns-domain-management",
  "documentation", "education", "email", "error-tracking", "feature-flags",
  "fitness-health", "forms", "headless-cms", "ide-code-editors", "infrastructure",
  "localization", "logging", "low-code-platforms", "maps-geolocation",
  "meditation-wellness", "messaging", "mobile-development", "monitoring",
  "news-reading", "notebooks-data-science", "password-managers", "payments",
  "productivity-notes", "project-management", "search", "secrets-management",
  "security", "server-management", "source-control", "startup-perks",
  "startup-programs", "status-pages", "storage", "streaming-media",
  "team-collaboration", "testing", "tunneling-networking", "video", "vpn-privacy",
  "web-scraping", "workflow-automation",
];

const withoutRetirementCandidates: ReadonlySet<string> = new Set(
  [...liveNames].filter((name) => !CATEGORY_RETIREMENTS[name]),
);

const escapeForTest = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

let server: ChildProcess;
let port = 0;

function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

before(async () => { ({ child: server, port } = await startServer()); });
after(() => { server?.kill(); });

describe("a name holding nothing is retired, not absent", () => {
  it("keeps a name live while the catalogue still files offers under it", () => {
    for (const name of Object.keys(CATEGORY_RETIREMENTS)) {
      if (!liveNames.has(name)) continue;
      assert.strictEqual(categoryState(name, liveNames), "live", `${name} holds offers and does not read as live`);
      assert.strictEqual(retirementFor(name, liveNames), null, `${name} holds offers and publishes a retirement notice`);
      assert.ok(publishedScopeFor(name, liveNames), `${name} holds offers and withholds its scope statement`);
    }
  });

  it("reads a name carrying a notice and holding nothing as retired", () => {
    for (const name of Object.keys(CATEGORY_RETIREMENTS)) {
      assert.strictEqual(categoryState(name, withoutRetirementCandidates), "retired");
      assert.strictEqual(retirementFor(name, withoutRetirementCandidates)?.retired, CATEGORY_RETIREMENTS[name].retired);
    }
    assert.deepStrictEqual(
      retiredCategoryNames(withoutRetirementCandidates),
      Object.keys(CATEGORY_RETIREMENTS).sort(),
    );
  });

  it("reads a name holding nothing and carrying no notice as absent", () => {
    assert.strictEqual(categoryState("Fax Machines", liveNames), "absent");
    assert.strictEqual(categoryState("Fax Machines", withoutRetirementCandidates), "absent");
    assert.strictEqual(retirementFor("Fax Machines", withoutRetirementCandidates), null);
  });

  it("withholds the scope statement of a retired name and keeps it in the registry", () => {
    for (const name of Object.keys(CATEGORY_RETIREMENTS)) {
      assert.strictEqual(publishedScopeFor(name, withoutRetirementCandidates), null, `${name} is retired and still publishes a scope statement`);
      assert.ok(CATEGORY_SCOPES[name], `${name} is retired and has been dropped from the registry rather than kept`);
      assert.ok(scopeFor(name), `${name} is retired and the registry no longer remembers what it held`);
    }
  });

  it("resolves a renamed name before deciding its state", () => {
    for (const [alias, replacement] of Object.entries(CATEGORY_ALIASES)) {
      assert.strictEqual(categoryState(alias, liveNames), categoryState(replacement, liveNames));
    }
  });
});

describe("every retirement notice names a date and a reason", () => {
  it("dates every notice", () => {
    for (const [name, retirement] of Object.entries(CATEGORY_RETIREMENTS)) {
      assert.match(retirement.retired, /^\d{4}-\d{2}-\d{2}$/, `${name} is retired on no readable date`);
    }
  });

  it("gives a reason longer than the name it retires", () => {
    for (const [name, retirement] of Object.entries(CATEGORY_RETIREMENTS)) {
      assert.ok(retirement.reason.length > name.length + 40, `${name} is retired for no stated reason`);
    }
  });

  it("retires only a name the site has published", () => {
    const neverPublished = Object.keys(CATEGORY_RETIREMENTS)
      .filter((name) => !SLUGS_PUBLISHED_BEFORE_THE_SCOPE_REGISTRY.includes(toSlug(name)));
    assert.deepStrictEqual(neverPublished, [], `retirement notices for names the site never published: ${neverPublished.join(", ")}`);
  });
});

describe("the notice states the date and the reason in place of a listing", () => {
  const sample = { retired: "2026-01-31", reason: "The entries under this name were out of scope for an index of developer infrastructure." };

  it("prints the date and the reason", () => {
    const html = retiredCategoryNoticeHtml("Sample & Name", sample, escapeForTest);
    assert.ok(html.includes("2026-01-31"), "the notice does not print the date");
    assert.ok(html.includes(escapeForTest(sample.reason)), "the notice does not print the reason");
    assert.ok(html.includes(RETIRED_CATEGORY_BADGE));
    assert.ok(html.includes(`href="${RETIRED_CATEGORY_ONWARD_PATH}"`), "the notice offers no route onward");
  });

  it("escapes the name it was handed", () => {
    const html = retiredCategoryNoticeHtml("Sample & Name", sample, escapeForTest);
    assert.ok(html.includes("Sample &amp; Name"));
    assert.ok(!html.includes("Sample & Name"));
  });

  it("names the category in the title and the description without restating the notice", () => {
    assert.ok(retiredCategoryTitle("Sample").includes("Sample"));
    assert.ok(retiredCategoryDescription("Sample").includes("Sample"));
    assert.ok(!retiredCategoryDescription("Sample").includes(sample.reason), "the description restates the reason the notice already gives");
    assert.ok(retiredCategoryStatedOn(sample).includes("2026-01-31"));
  });
});

describe("a retired name reaches no surface that lists categories", () => {
  it("leaves a retired name out of the directory it would otherwise appear in", () => {
    const liveOnly = categories.filter((c) => !CATEGORY_RETIREMENTS[c.name]);
    const directory = buildCategoryDirectory(liveOnly, offers, toSlug);
    const surfaced = directory
      .map((entry) => entry.name)
      .filter((name) => retiredCategoryNames(withoutRetirementCandidates).includes(name));
    assert.deepStrictEqual(surfaced, [], `retired names published by the directory: ${surfaced.join(", ")}`);
  });

  it("sends no caller from a live name to a retired one", () => {
    const liveOnly = categories.filter((c) => !CATEGORY_RETIREMENTS[c.name]);
    const directory = buildCategoryDirectory(liveOnly, offers, toSlug);
    const retired = new Set(retiredCategoryNames(withoutRetirementCandidates));
    for (const entry of directory) {
      for (const sibling of entry.also_answering) {
        assert.ok(!retired.has(sibling.name), `${entry.name} sends a caller to ${sibling.name}, which is retired`);
      }
    }
  });

  it("names only a live category on every surface that publishes a list of them", async () => {
    const directory = await (await fetch(`http://localhost:${port}/api/categories`)).json() as {
      categories: { name: string }[];
    };
    for (const entry of directory.categories) {
      assert.ok(liveNames.has(entry.name), `/api/categories publishes ${entry.name}, which holds nothing`);
    }

    const sitemap = await (await fetch(`http://localhost:${port}/sitemap-pages.xml`)).text();
    const sitemapSlugs = [...sitemap.matchAll(/\/category\/([a-z0-9-]+)</g)].map((m) => m[1]);
    const liveSlugs = new Set([...liveNames].map(toSlug));
    for (const slug of sitemapSlugs) {
      assert.ok(liveSlugs.has(slug), `the sitemap lists /category/${slug}, which holds nothing`);
    }

    const llmsFull = await (await fetch(`http://localhost:${port}/llms-full.txt`)).text();
    const listed = [...llmsFull.matchAll(/^- (.+?) \(\d+ offers\)$/gm)].map((m) => m[1]);
    assert.ok(listed.length > 0, "llms-full.txt lists no categories at all");
    for (const name of listed) {
      assert.ok(liveNames.has(name), `llms-full.txt lists ${name}, which holds nothing`);
    }
  });

  it("publishes the retired set beside the renamed set rather than folded into it", async () => {
    const body = await (await fetch(`http://localhost:${port}/api/categories`)).json() as {
      retired_names: Record<string, string>;
      retired_categories: { name: string; slug: string; retired: string; reason: string }[];
    };
    assert.ok(Array.isArray(body.retired_categories));
    assert.deepStrictEqual(
      body.retired_categories.map((c) => c.name).sort(),
      retiredCategoryNames(liveNames),
    );
    for (const entry of body.retired_categories) {
      assert.strictEqual(entry.slug, toSlug(entry.name));
      assert.match(entry.retired, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(entry.reason.length > 0);
      assert.ok(!(entry.name in body.retired_names), `${entry.name} is reported as renamed and as retired`);
    }
  });
});

describe("every category path the site published still answers", () => {
  it("serves a retired path with a notice rather than a listing or a redirect", async () => {
    for (const name of retiredCategoryNames(liveNames)) {
      const retirement = CATEGORY_RETIREMENTS[name];
      const res = await fetch(`http://localhost:${port}/category/${toSlug(name)}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `/category/${toSlug(name)} answers ${res.status}`);
      const html = await res.text();
      assert.ok(html.includes(retirement.retired), `/category/${toSlug(name)} does not print the date it was retired`);
      assert.ok(html.includes(escapeForTest(retirement.reason)), `/category/${toSlug(name)} does not print why it was retired`);
      assert.ok(!html.includes("<table"), `/category/${toSlug(name)} still renders a listing`);
    }
  });

  it("answers every published path with a listing or a notice, never a 404", async () => {
    const orphaned: string[] = [];
    for (const slug of SLUGS_PUBLISHED_BEFORE_THE_SCOPE_REGISTRY) {
      const res = await fetch(`http://localhost:${port}/category/${slug}`, { redirect: "manual" });
      if (res.status === 200) continue;
      if (res.status === 301) {
        const followed = await fetch(`http://localhost:${port}${res.headers.get("location")}`, { redirect: "manual" });
        if (followed.status === 200) continue;
      }
      orphaned.push(`${slug} -> ${res.status}`);
    }
    assert.deepStrictEqual(orphaned, [], `category paths that no longer resolve: ${orphaned.join(", ")}`);
  });
});

describe("a catalogue that files nothing under a name retires it end to end", () => {
  const retiredHere = Object.keys(CATEGORY_RETIREMENTS);
  const emptiedIndex = path.join(os.tmpdir(), `catalogue-without-retired-categories-${process.pid}.json`);
  let emptied: ChildProcess;
  let emptiedPort = 0;
  let survivors: { name: string; count: number }[] = [];

  before(async () => {
    const kept = offers.filter((o) => !retiredHere.includes(o.category));
    assert.ok(retiredHere.length > 0, "no name carries a retirement notice, so nothing here is under test");
    assert.ok(!kept.some((o) => retiredHere.includes(o.category)), "the catalogue under test still files offers under a retired name");
    fs.mkdirSync(path.dirname(emptiedIndex), { recursive: true });
    fs.writeFileSync(emptiedIndex, JSON.stringify({ offers: kept }));
    const counts = new Map<string, number>();
    for (const offer of kept) counts.set(offer.category, (counts.get(offer.category) ?? 0) + 1);
    survivors = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
    ({ child: emptied, port: emptiedPort } = await startServer({ AGENTDEALS_INDEX_PATH: emptiedIndex }));
  });

  after(() => {
    emptied?.kill();
    fs.rmSync(emptiedIndex, { force: true });
  });

  it("answers every retired path with a dated, reasoned notice", async () => {
    for (const name of retiredHere) {
      const res = await fetch(`http://localhost:${emptiedPort}/category/${toSlug(name)}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `/category/${toSlug(name)} answers ${res.status} once the name holds nothing`);
      const html = await res.text();
      assert.ok(html.includes(CATEGORY_RETIREMENTS[name].retired), `/category/${toSlug(name)} does not print the date it was retired`);
      assert.ok(html.includes(escapeForTest(CATEGORY_RETIREMENTS[name].reason)), `/category/${toSlug(name)} does not print why it was retired`);
      assert.ok(html.includes(RETIRED_CATEGORY_BADGE));
      assert.ok(!html.includes("<table"), `/category/${toSlug(name)} still renders a listing`);
    }
  });

  it("states the reason once on the page rather than in the lede as well", async () => {
    for (const name of retiredHere) {
      const html = await (await fetch(`http://localhost:${emptiedPort}/category/${toSlug(name)}`)).text();
      const reason = escapeForTest(CATEGORY_RETIREMENTS[name].reason);
      const stated = html.split(reason).length - 1;
      assert.strictEqual(stated, 1, `/category/${toSlug(name)} states why it was retired ${stated} times`);
    }
  });

  it("answers every path the site published, retired names among them", async () => {
    const orphaned: string[] = [];
    for (const slug of SLUGS_PUBLISHED_BEFORE_THE_SCOPE_REGISTRY) {
      const res = await fetch(`http://localhost:${emptiedPort}/category/${slug}`, { redirect: "manual" });
      if (res.status === 200) continue;
      if (res.status === 301) {
        const followed = await fetch(`http://localhost:${emptiedPort}${res.headers.get("location")}`, { redirect: "manual" });
        if (followed.status === 200) continue;
      }
      orphaned.push(`${slug} -> ${res.status}`);
    }
    assert.deepStrictEqual(orphaned, [], `category paths that no longer resolve: ${orphaned.join(", ")}`);
  });

  it("leaves a retired name out of every surface that lists categories", async () => {
    const directory = await (await fetch(`http://localhost:${emptiedPort}/api/categories`)).json() as {
      categories: { name: string }[];
      retired_categories: { name: string; retired: string; reason: string }[];
    };
    for (const name of retiredHere) {
      assert.ok(!directory.categories.some((c) => c.name === name), `/api/categories still publishes ${name}`);
    }
    assert.deepStrictEqual(directory.retired_categories.map((c) => c.name).sort(), [...retiredHere].sort());

    const sitemap = await (await fetch(`http://localhost:${emptiedPort}/sitemap-pages.xml`)).text();
    for (const name of retiredHere) {
      assert.ok(!sitemap.includes(`/category/${toSlug(name)}<`), `the sitemap still lists /category/${toSlug(name)}`);
    }

    const llmsFull = await (await fetch(`http://localhost:${emptiedPort}/llms-full.txt`)).text();
    for (const name of retiredHere) {
      assert.ok(!llmsFull.includes(`- ${name} (`), `llms-full.txt still lists ${name}`);
    }

    const index = await (await fetch(`http://localhost:${emptiedPort}/category`)).text();
    for (const name of retiredHere) {
      assert.ok(!index.includes(`/category/${toSlug(name)}"`), `/category still cards ${name}`);
    }
  });

  it("returns no offer under a retired name from any search", async () => {
    for (const name of retiredHere) {
      const byCategory = await (await fetch(`http://localhost:${emptiedPort}/api/offers?category=${encodeURIComponent(name)}&limit=5`)).json() as { total: number };
      assert.strictEqual(byCategory.total, 0, `/api/offers still returns ${byCategory.total} offers under ${name}`);
    }

    const listed = await (await fetch(`http://localhost:${emptiedPort}/api/offers?limit=5000`)).json() as { total: number; offers: { vendor: string; category: string }[] };
    assert.strictEqual(listed.offers.length, listed.total, "the sweep did not read every offer the API will serve");
    assert.ok(listed.total > 0);
    const reachable = listed.offers.filter((o) => retiredHere.includes(o.category));
    assert.deepStrictEqual(reachable.map((o) => `${o.vendor} (${o.category})`), [], "offers filed under a retired name are still served");

    const searchPage = await (await fetch(`http://localhost:${emptiedPort}/search`)).text();
    for (const name of retiredHere) {
      assert.ok(!searchPage.includes(`>${name}<`), `/search still offers ${name} as a filter`);
    }
  });

  it("counts only the names that survived", async () => {
    const live = survivors.length;
    assert.strictEqual(live, categories.filter((c) => !retiredHere.includes(c.name)).length);
    assert.ok(live > 0);

    const home = await (await fetch(`http://localhost:${emptiedPort}/`)).text();
    assert.ok(home.includes(`<div class="stat-num stat-purple">${live}</div>`), `the home page does not state ${live} categories`);

    const llms = await (await fetch(`http://localhost:${emptiedPort}/llms.txt`)).text();
    assert.ok(llms.includes(`across ${live} categories`), `llms.txt does not state ${live} categories`);

    const index = await (await fetch(`http://localhost:${emptiedPort}/category`)).text();
    assert.ok(index.includes(`All Categories (${live})`), `/category does not state ${live} categories`);
  });
});

describe("the number of categories we publish is counted, not remembered", () => {
  it("prints the live count on every surface that states one", async () => {
    const live = categories.length;
    assert.strictEqual(CATALOGUE_CATEGORY_COUNT, live, "the MCP instructions state a count of their own");

    const home = await (await fetch(`http://localhost:${port}/`)).text();
    assert.ok(home.includes(`<div class="stat-num stat-purple">${live}</div>`), `the home page does not state ${live} categories`);

    const llms = await (await fetch(`http://localhost:${port}/llms.txt`)).text();
    assert.ok(llms.includes(`across ${live} categories`), `llms.txt does not state ${live} categories`);

    const llmsFull = await (await fetch(`http://localhost:${port}/llms-full.txt`)).text();
    assert.ok(llmsFull.includes(`across ${live} categories`), `llms-full.txt does not state ${live} categories`);

    const index = await (await fetch(`http://localhost:${port}/category`)).text();
    assert.ok(index.includes(`All Categories (${live})`), `/category does not state ${live} categories`);
  });

  it("states the same count over MCP as it states over HTTP", async () => {
    const init = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    const text = await init.text();
    const payload = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1] : text) as {
      result: { instructions: string; serverInfo: { description?: string } };
    };
    assert.ok(payload.result.instructions.includes(`across ${categories.length} developer-tool categories`), "the MCP instructions state a count of their own");
  });

  it("writes no category count into a source file that a shrinking catalogue would falsify", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(path.join(REPO, "src")).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(REPO, "src", file), "utf8");
      for (const match of source.matchAll(/across [0-9,]+\+? (?:developer-tool )?categor|[0-9,]+\+? categories with pricing change tracking|Browse [0-9,]+ categories/g)) {
        offenders.push(`src/${file}: ${match[0]}`);
      }
    }
    assert.deepStrictEqual(offenders, [], `category counts written as literals: ${offenders.join("; ")}`);
  });
});
