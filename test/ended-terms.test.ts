import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropEndedFromNameList, endedIndex, markEndedVendorRows } from "../dist/ended-surfaces.js";
import { endedStatusWord, ENDED_STATUS_WHEN_THE_TIER_NAMES_NONE } from "../dist/retirement.js";
import { endedOffersStatedAsAvailable, ENDED_TERMS_POPULATION, pageSubjectSlug } from "../dist/retired-terms.js";
import { assertCoversPopulation, assertPopulationFloor, type Population } from "./population-floor.ts";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const POPULATION = ENDED_TERMS_POPULATION();

const SHORTEST_QUOTED_RECORD = 45;

const STORED_CHANGE_PROSE: string[] = (() => {
  const parsed = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
  const changes: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : parsed.changes ?? [];
  return changes
    .flatMap(c => [c.summary, c.previous_state, c.current_state])
    .filter((t): t is string => typeof t === "string" && t.length >= SHORTEST_QUOTED_RECORD)
    .map(t => t.replace(/\s+/g, " "));
})();

function quotesAStoredChangeRecord(unit: string): boolean {
  const said = unit.replace(/\s+/g, " ");
  return STORED_CHANGE_PROSE.some(t => said.includes(t.slice(0, SHORTEST_QUOTED_RECORD)));
}

function page(body: string, description = ""): string {
  return `<!DOCTYPE html><html><head><meta name="description" content="${description}"></head><body>${body}</body></html>`;
}

describe("a page that states terms for an offer whose record has ended", () => {
  it("has a population to check against", () => {
    assert.ok(POPULATION.length > 0, "the catalogue holds at least one ended offer");
    assert.ok(POPULATION.some(o => o.vendor === "GitHub Models"), "GitHub Models is recorded as ended");
  });

  it("flags a comparison row that puts a rate limit beside an ended vendor", () => {
    const html = page(`<table><tr>
      <td><a href="/vendor/github-models">GitHub Models</a></td>
      <td>Inference</td><td>10-15 RPM</td><td>50-150 req/day</td>
      <td>100+ models, GPT-4o, Llama</td><td>Widest model selection free</td>
    </tr></table>`);
    const found = endedOffersStatedAsAvailable(html, "/free-llm-apis", POPULATION);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].vendor, "GitHub Models");
  });

  it("credits a free plan named in one clause to that clause's vendor only", () => {
    const html = page(`<p>GitHub Copilot's free plan lists 2,000 completions; <strong>GitHub Models</strong> is billed per token.</p>`);
    assert.deepStrictEqual(endedOffersStatedAsAvailable(html, "/free-llm-apis", POPULATION), []);
  });

  it("flags a sentence that credits an ended vendor with an allowance", () => {
    const html = page("<p>And <strong>GitHub Models</strong> provides 100+ models with generous daily limits.</p>");
    assert.strictEqual(endedOffersStatedAsAvailable(html, "/free-llm-apis", POPULATION).length, 1);
  });

  it("flags a meta description that lists an ended vendor among free alternatives", () => {
    const html = page("", "Compare free alternatives: Upstash, Valkey, DragonflyDB, KeyDB, Momento, Garnet, Memcached, Aiven.");
    const found = endedOffersStatedAsAvailable(html, "/redis-alternatives", POPULATION);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].where, "meta description");
  });

  it("passes a row that already says the offer has ended", () => {
    const html = page(`<table><tr>
      <td><a href="/vendor/github-models">GitHub Models</a></td>
      <td>Retired — the offer has ended, so there is no free tier to compare.</td>
    </tr></table>`);
    assert.deepStrictEqual(endedOffersStatedAsAvailable(html, "/llm-api-pricing", POPULATION), []);
  });

  it("passes a row that states what the vendor charges", () => {
    const html = page(`<table><tr>
      <td><a href="/vendor/augment-code">Augment Code</a></td>
      <td>$20</td><td>$20</td>
      <td>Included usage is $20/month on Standard and $100/month on Business.</td>
    </tr></table>`);
    assert.deepStrictEqual(endedOffersStatedAsAvailable(html, "/ai-coding-tools-pricing", POPULATION), []);
  });

  it("passes a row that says the vendor has no free tier", () => {
    const html = page("<table><tr><td><a href=\"/vendor/momento\">Momento</a></td><td>No free tier</td><td>5 GB transfer/month once paid</td></tr></table>");
    assert.deepStrictEqual(endedOffersStatedAsAvailable(html, "/database-pricing", POPULATION), []);
  });

  it("passes a page whose own subject is the ended vendor", () => {
    const html = page("<h1>Best Momento Alternatives with Free Tiers (2026)</h1>", "Compare 3 free alternatives to Momento for Databases.");
    assert.deepStrictEqual(endedOffersStatedAsAvailable(html, "/alternative-to/momento", POPULATION), []);
    assert.strictEqual(pageSubjectSlug("/alternative-to/momento"), "momento");
    assert.strictEqual(pageSubjectSlug("/redis-alternatives"), null);
  });

  it("passes a change record that describes the price the vendor moved to", () => {
    const html = page("<table><tr><td>discovered Sep 4, 2026</td><td><a href=\"/vendor/momento\">Momento</a></td><td>Momento Cache Flex starts at $13 per GB-month.</td></tr></table>");
    assert.deepStrictEqual(endedOffersStatedAsAvailable(html, "/database-pricing", POPULATION), []);
  });
});

describe("the rendering that keeps an ended offer out of a free comparison", () => {
  const ended = endedIndex([
    { vendor: "GitHub Models", tier: "Retired" },
    { vendor: "Momento", tier: "Retired" },
    { vendor: "Groq", tier: "Free" },
  ]);

  it("replaces the terms cells of a row whose subject has ended", () => {
    const row = '<tr><td><a href="/vendor/github-models">GitHub Models</a></td><td>10-15 RPM</td><td>50-150 req/day</td></tr>';
    const out = markEndedVendorRows(row, ended);
    assert.match(out, /colspan="2"/);
    assert.match(out, /Retired — the offer has ended/);
    assert.doesNotMatch(out, /RPM/);
    assert.match(out, /GitHub Models<\/a>/);
  });

  it("leaves a row whose subject is still offered", () => {
    const row = '<tr><td><a href="/vendor/groq">Groq</a></td><td>~30 RPM</td><td>Generous daily</td></tr>';
    assert.strictEqual(markEndedVendorRows(row, ended), row);
  });

  it("leaves a row that already states the retirement", () => {
    const row = '<tr><td><a href="/vendor/github-models">GitHub Models</a></td><td>Retired</td><td>GPT-4o, Llama</td></tr>';
    assert.strictEqual(markEndedVendorRows(row, ended), row);
  });

  it("derives the word in the cell from the record rather than a fixed label", () => {
    const sunset = endedIndex([{ vendor: "Momento", tier: "Sunset" }]);
    const row = '<tr><td><a href="/vendor/momento">Momento</a></td><td>5 GB transfer/mo</td></tr>';
    assert.match(markEndedVendorRows(row, sunset), /Sunset — the offer has ended/);
  });

  it("states the status the tier names, not the rest of what the tier says", () => {
    const deprecated = endedIndex([{ vendor: "Google Content API for Shopping", tier: "Free (Deprecated)" }]);
    const row = '<tr><td><a href="/vendor/google-content-api-for-shopping">Google Content API for Shopping</a></td><td>Unlimited calls</td></tr>';
    const out = markEndedVendorRows(row, deprecated);
    assert.match(out, /Deprecated — the offer has ended/);
    assert.doesNotMatch(out, /Free \(Deprecated\)/);
  });

  it("reads the status out of a tier the catalogue states in any casing", () => {
    assert.strictEqual(endedStatusWord("RETIRED"), "Retired");
    assert.strictEqual(endedStatusWord("Free (deprecated)"), "Deprecated");
    assert.strictEqual(endedStatusWord("Free"), ENDED_STATUS_WHEN_THE_TIER_NAMES_NONE);
  });

  it("drops an ended vendor from a list of names without disturbing the rest", () => {
    const before = "Compare free alternatives: Upstash, Valkey, DragonflyDB, KeyDB, Momento, Garnet, Memcached, Aiven.";
    assert.strictEqual(
      dropEndedFromNameList(before, ended),
      "Compare free alternatives: Upstash, Valkey, DragonflyDB, KeyDB, Garnet, Memcached, Aiven.",
    );
  });

  it("leaves a list that names no ended vendor", () => {
    const before = "Compare free alternatives: Upstash, Valkey, DragonflyDB, KeyDB, Garnet.";
    assert.strictEqual(dropEndedFromNameList(before, ended), before);
  });
});

let proc: ChildProcess | null = null;
let serverPort = 0;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("every route we publish outside the vendor and comparison templates", () => {
  const rendered = new Map<string, string>();
  const listed = new Set<string>();

  function routesTheSitemapLists(): Population {
    return { size: listed.size, read: "routes the sitemap lists outside the vendor and comparison sets" };
  }

  before(async () => {
    proc = await startServer();
    const base = `http://localhost:${serverPort}`;
    const index = await (await fetch(`${base}/sitemap.xml`)).text();
    const subs = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => m[1])
      .filter(u => !/sitemap-(?:vendors|comparisons)\.xml$/.test(u));
    for (const sub of subs) {
      const xml = await (await fetch(base + new URL(sub).pathname)).text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) listed.add(new URL(m[1]).pathname);
    }
    for (const p of listed) {
      const res = await fetch(base + p);
      if (res.status === 200) rendered.set(p, await res.text());
    }
  });

  after(() => { proc?.kill(); });

  it("renders every route the sitemap lists, so the sweep below reads the whole site", () => {
    assertPopulationFloor(listed.size, 300, "routes the sitemap lists for the sweep to read");
    assertCoversPopulation(rendered.size, routesTheSitemapLists(), "routes that rendered for the sweep");
  });

  it("states no terms for an offer our own record says has ended", () => {
    const found: string[] = [];
    for (const [p, html] of rendered) {
      for (const f of endedOffersStatedAsAvailable(html, p, POPULATION)) {
        if (quotesAStoredChangeRecord(f.unit)) continue;
        found.push(`${p} ${f.where} ${f.vendor}: ${f.unit}`);
      }
    }
    assert.deepStrictEqual(found, [], `${found.length} of ${rendered.size} routes state terms for an ended offer`);
  });

  it("keeps naming the ended vendors on the pages that report the retirement", () => {
    for (const p of ["/llm-api-pricing", "/openai-assistants-alternatives", "/ai-free-tiers", "/ai-ml-alternatives"]) {
      const html = rendered.get(p);
      assert.ok(html, `${p} renders`);
      assert.ok(html!.includes("GitHub Models"), `${p} still names GitHub Models`);
      assert.match(html!, /Retired/, `${p} still reports the status`);
    }
  });

  it("keeps the rows that price a vendor whose free tier ended", () => {
    const html = rendered.get("/database-pricing");
    assert.ok(html, "/database-pricing renders");
    assert.ok(html!.includes("Momento"), "/database-pricing still names Momento");
  });
});
