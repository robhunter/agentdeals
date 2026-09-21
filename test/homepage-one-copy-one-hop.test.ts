import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_OPENS_WINDOW_DAYS, HOMEPAGE_GUIDE_COUNT } from "../dist/homepage-routing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

interface Server {
  proc: ChildProcess;
  port: number;
}

function startServer(env: Record<string, string> = {}): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 40000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function withoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

interface StatedSelection {
  named: number;
  population: number;
  ranked: boolean;
}

function statedSelection(section: string): StatedSelection | null {
  const ranked = section.match(/The (\d+) of (\d+) guides AI agents opened most/);
  if (ranked) return { named: Number(ranked[1]), population: Number(ranked[2]), ranked: true };
  const all = section.match(/All (\d+) guides we publish, in the order \/guides lists them/);
  if (all) return { named: Number(all[1]), population: Number(all[1]), ranked: false };
  return null;
}

function statedRankedWindow(section: string): { days: number; from: string; to: string } | null {
  const stated = section.match(
    /across the (\d+) days we can attribute in full, (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/,
  );
  return stated ? { days: Number(stated[1]), from: stated[2], to: stated[3] } : null;
}

function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
}

function headingsIn(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

function changeSummaries(html: string): string[] {
  return [...withoutScripts(html).matchAll(/class="(?:change|rc|cs|deadline)-summary"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `the home page did not render a section with id ${id}`);
  const next = html.indexOf('class="divider"', start);
  return html.slice(start, next > start ? next : html.length);
}

function guidePathsOn(html: string): string[] {
  return [...new Set(hrefsIn(sectionOf(html, "answers")))].filter((h) => h !== "/guides");
}

describe("the home page prints each change record once", () => {
  let server: Server;
  let html = "";

  before(async () => {
    server = await startServer();
    html = await (await fetch(`http://localhost:${server.port}/`)).text();
  });

  after(() => server?.proc.kill());

  it("prints no change summary twice", () => {
    const summaries = changeSummaries(html);
    assert.ok(summaries.length > 0, "the home page rendered no change summaries, so this proves nothing");
    const seen = new Map<string, number>();
    for (const summary of summaries) seen.set(summary, (seen.get(summary) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([s, n]) => `${n}x ${s.slice(0, 60)}`);
    assert.deepStrictEqual(repeated, [], `the home page printed ${repeated.length} change summaries more than once`);
  });

  it("gives no two sections the same heading", () => {
    const headings = headingsIn(withoutScripts(html));
    assert.ok(headings.length > 0, "the home page rendered no h2 at all");
    const seen = new Map<string, number>();
    for (const heading of headings) seen.set(heading, (seen.get(heading) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([h]) => h);
    assert.deepStrictEqual(repeated, [], "two sections of the home page carry the same heading");
  });
});

describe("the home page hands its client install config to /setup", () => {
  let server: Server;
  let home = "";
  let setup = "";

  before(async () => {
    server = await startServer();
    home = await (await fetch(`http://localhost:${server.port}/`)).text();
    setup = await (await fetch(`http://localhost:${server.port}/setup`)).text();
  });

  after(() => server?.proc.kill());

  it("prints at most one mcpServers example", () => {
    const examples = (withoutScripts(home).match(/"mcpServers"/g) ?? []).length;
    assert.ok(examples <= 1, `the home page prints ${examples} mcpServers examples where /setup carries the full set`);
  });

  it("keeps the call to action that sends a reader to /setup", () => {
    assert.ok(home.includes('href="/setup"'), "the home page no longer links /setup at all");
  });

  it("leaves /setup carrying a tab for every client and the one-click installer", () => {
    const tabs = (setup.match(/class="client-tab[^"]*" data-client="/g) ?? []).length;
    const homeTabs = (home.match(/class="client-tab[^"]*" data-client="/g) ?? []).length;
    assert.ok(tabs >= 9, `/setup offers ${tabs} client tabs, fewer than the nine it is meant to carry`);
    assert.ok(tabs > homeTabs, "/setup does not carry more clients than the home page, so nothing was handed over");
    assert.ok(setup.includes(".mcpb"), "/setup no longer offers the one-click installer");
  });
});

describe("the home page routes a reader to an answer in one hop", () => {
  let server: Server;
  let home = "";
  let guides = "";

  before(async () => {
    server = await startServer();
    home = await (await fetch(`http://localhost:${server.port}/`)).text();
    guides = await (await fetch(`http://localhost:${server.port}/guides`)).text();
  });

  after(() => server?.proc.kill());

  it("names only guides that /guides itself lists", () => {
    const published = new Set(
      [...guides.matchAll(/<a href="(\/[^"]+)" class="guide-card"/g)].map((m) => m[1]),
    );
    assert.ok(published.size > 0, "/guides listed no guide cards, so this proves nothing");
    const named = guidePathsOn(home);
    assert.ok(named.length > 0, "the home page named no guides at all");
    const strangers = named.filter((p) => !published.has(p));
    assert.deepStrictEqual(strangers, [], "the home page named a guide /guides does not list");
  });

  it("names as many guides as the section says it does", () => {
    const named = guidePathsOn(home);
    const stated = statedSelection(sectionOf(home, "answers"));
    assert.ok(stated, "the guide section does not state how many of how many it names");
    assert.strictEqual(named.length, stated.named, "the guide section names a different number than it states");
    assert.strictEqual(
      named.length,
      stated.ranked ? HOMEPAGE_GUIDE_COUNT : stated.population,
      "the guide section named a different number than it selects",
    );
  });

  it("states the window of traffic its ranking was taken over, or that it has none to rank on", () => {
    const section = sectionOf(home, "answers");
    const stated = statedSelection(section);
    assert.ok(stated, "the guide section does not say what it is naming");
    const window = statedRankedWindow(section);

    if (!stated.ranked) {
      assert.equal(window, null, "the section disclaims a ranking and states a ranked window anyway");
      assert.doesNotMatch(section, /opened most/, "the section disclaims a ranking and claims one anyway");
      return;
    }

    assert.ok(window, "the guide section does not say which traffic it ranked over");
    assert.ok(window.days > 0, "the guide section says it ranked over no traffic at all");
    assert.ok(
      window.days <= AGENT_OPENS_WINDOW_DAYS,
      `the guide section claims ${window.days} days where the ranking reads at most ${AGENT_OPENS_WINDOW_DAYS}`,
    );
    assert.ok(window.from <= window.to, "the stated window ends before it begins");
  });

  it("links a guide for every group of /guides it draws one from", () => {
    const section = sectionOf(home, "answers");
    const groups = [...section.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    assert.ok(groups.length > 0, "the guide section named no groups");
    for (const group of groups) {
      assert.ok(guides.includes(`<h2>${group}</h2>`), `the home page grouped guides under ${group}, which /guides does not use`);
    }
  });
});

describe("the guide list on the home page follows the traffic it says it does", () => {
  let server: Server;
  let tmp = "";
  let html = "";
  let published: string[] = [];

  const opens: Record<string, number> = {
    "free-django-stack": 900,
    "free-go-stack": 800,
    "vercel-vs-netlify": 700,
    "hetzner-pricing-2026": 1,
  };

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "homepage-guide-rank-"));
    const day = (date: string, counts: Record<string, number>) => {
      const by_class_route: Record<string, number> = {};
      for (const [slug, n] of Object.entries(counts)) by_class_route[`ai_agent|/${slug}`] = n;
      writeFileSync(path.join(tmp, `${date}.json`), JSON.stringify({ date, traffic: { by_class_route } }));
    };
    day("2026-01-01", { "free-django-stack": 900, "free-go-stack": 800 });
    day("2026-01-02", { "vercel-vs-netlify": 700, "hetzner-pricing-2026": 1 });
    server = await startServer({ AGENTDEALS_ROLLUP_DIR: tmp });
    html = await (await fetch(`http://localhost:${server.port}/`)).text();
    const guides = await (await fetch(`http://localhost:${server.port}/guides`)).text();
    published = [...guides.matchAll(/<a href="\/([^"]+)" class="guide-card"/g)].map((m) => m[1]);
  });

  after(() => {
    server?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("names the set that traffic ranks highest, re-derived from the same window", () => {
    assert.ok(published.length > HOMEPAGE_GUIDE_COUNT, "/guides lists no more guides than the home page names");
    const expected = [...published]
      .sort((a, b) => (opens[b] ?? 0) - (opens[a] ?? 0) || a.localeCompare(b))
      .slice(0, HOMEPAGE_GUIDE_COUNT)
      .map((slug) => `/${slug}`)
      .sort();
    assert.deepStrictEqual(
      guidePathsOn(html).sort(),
      expected,
      "the home page named a different set of guides than the traffic it was given ranks highest",
    );
  });

  it("names every guide that window opened at all", () => {
    const named = new Set(guidePathsOn(html));
    const unnamed = Object.keys(opens).filter((slug) => !named.has(`/${slug}`));
    assert.deepStrictEqual(unnamed, [], "a guide the traffic window recorded opens for is missing from the home page");
  });

  it("states the window it was given rather than the one it ships with", () => {
    const section = sectionOf(html, "answers");
    const stated = statedRankedWindow(section);
    assert.ok(stated, "the guide section does not state a window");
    assert.strictEqual(stated.days, 2, "the guide section counted days it was not given");
    assert.deepStrictEqual([stated.from, stated.to], ["2026-01-01", "2026-01-02"], "the guide section states a window it did not read");
    assert.match(section, /Membership is that ranking and nothing else/);
  });

  it("states the share that reached no page once the window carries requests it could not attribute", async () => {
    const withOverflow = mkdtempSync(path.join(tmpdir(), "homepage-guide-overflow-"));
    try {
      assert.ok(published.length > 0, "the guide population is empty, so this proves nothing");
      writeFileSync(path.join(withOverflow, "2026-01-01.json"), JSON.stringify({
        date: "2026-01-01",
        traffic: {
          by_class_route: { "ai_agent|/free-django-stack": 900, "ai_agent|__other_pages__": 100 },
          class_route_truncation: { reserved_paths: published.map((slug) => `/${slug}`) },
        },
      }));
      const other = await startServer({ AGENTDEALS_ROLLUP_DIR: withOverflow });
      try {
        const page = await (await fetch(`http://localhost:${other.port}/`)).text();
        const section = sectionOf(page, "answers");
        assert.doesNotMatch(section, /and nothing else/, "the page claimed completeness over a window it could not attribute in full");
        assert.match(section, /100 of 1,?000 agent requests in those days \(10\.0%\) went to a shared bucket/);
      } finally {
        other.proc.kill();
      }
    } finally {
      rmSync(withOverflow, { recursive: true, force: true });
    }
  });
});

describe("the home page routes to a category without JavaScript", () => {
  let server: Server;
  let home = "";
  let categories: { name: string; slug: string }[] = [];

  before(async () => {
    server = await startServer();
    home = await (await fetch(`http://localhost:${server.port}/`)).text();
    const body = await (await fetch(`http://localhost:${server.port}/api/categories`)).json();
    categories = body.categories;
  });

  after(() => server?.proc.kill());

  it("links every category we publish, in the served markup", () => {
    const linked = new Set(hrefsIn(withoutScripts(home)));
    assert.ok(categories.length > 0, "the category directory is empty, so this proves nothing");
    const missing = categories.filter((c) => !linked.has(`/category/${c.slug}`)).map((c) => c.name);
    assert.deepStrictEqual(missing, [], `the home page leaves ${missing.length} categories unreachable without JavaScript`);
  });

  it("does not promise a list it only delivers to a client running JavaScript", () => {
    const browse = sectionOf(withoutScripts(home), "browse");
    const cards = (browse.match(/class="deal-card"/g) ?? []).length;
    const promisesTheWholeCatalogue = /filter [\d,]+\+? deals directly on this page/i.test(browse)
      || /Search and filter [\d,]+\+? deals directly/i.test(withoutScripts(home));
    assert.ok(
      !promisesTheWholeCatalogue,
      "the home page still tells a reader it can filter the whole catalogue on the page it just served them",
    );
    assert.ok(
      cards === 0 ? /run in your browser/.test(browse) : true,
      "the home page serves no deal cards and does not say the grid needs a browser",
    );
  });
});
