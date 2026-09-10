import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertCoversPopulation, assertPopulationFloor, categoriesInTheCatalogue, vendorsInTheCatalogue } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { SUPERLATIVE, faqSentences, namesASuperlative, ordersByAPrintedQuantity } = await import("../dist/faq-superlative.js");
const { NO_RANKING_HELD } = await import("../dist/unranked.js");
const { classifyTier } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const catalogue: { offers: Offer[] } = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
);
const offers = catalogue.offers;
const vendorNames = [...new Set(offers.map(o => o.vendor))].filter(v => v.length > 2);
const catalogueProse = new Set<string>();
for (const offer of offers) {
  if (offer.description) catalogueProse.add(offer.description);
}

const deniesAFreeTier = new Map<string, boolean>();
for (const offer of offers) {
  const denies = classifyTier(offer.tier).class === "not_free";
  deniesAFreeTier.set(offer.vendor, (deniesAFreeTier.get(offer.vendor) ?? true) && denies);
}

const CATALOGUE_PROSE_CROWNS = 5;

interface ServedAnswer {
  path: string;
  q: string;
  a: string;
}

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
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

const LD_BLOCK = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function faqAnswersIn(pathname: string, html: string): ServedAnswer[] {
  const found: ServedAnswer[] = [];
  for (const block of html.matchAll(LD_BLOCK)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const doc = entry as { "@type"?: string; mainEntity?: { name?: string; acceptedAnswer?: { text?: string } }[] };
      if (doc["@type"] !== "FAQPage") continue;
      for (const question of doc.mainEntity ?? []) {
        found.push({ path: pathname, q: question.name ?? "", a: question.acceptedAnswer?.text ?? "" });
      }
    }
  }
  return found;
}

function vendorsNamedIn(sentence: string): string[] {
  return vendorNames.filter(v => sentence.includes(v));
}

const QUOTED_RUN = 40;

function quotesCatalogueProse(sentence: string): boolean {
  const at = sentence.search(SUPERLATIVE);
  if (at < 0) return false;
  const run = sentence.slice(at, at + QUOTED_RUN);
  if (run.length < QUOTED_RUN) return false;
  for (const prose of catalogueProse) {
    if (prose.includes(run)) return true;
  }
  return false;
}

describe("no served FAQ answer crowns a vendor we hold no ranking for", () => {
  let proc: ChildProcess;
  let port = 0;
  const bodies = new Map<string, string>();
  let sweptPaths: string[] = [];
  const answers: ServedAnswer[] = [];
  const blocksByPath = new Map<string, number>();

  async function fetchPath(pathname: string): Promise<string> {
    const cached = bodies.get(pathname);
    if (cached !== undefined) return cached;
    const body = await (await fetch(`http://localhost:${port}${pathname}`)).text();
    bodies.set(pathname, body);
    return body;
  }

  before(async () => {
    const started = await startServer({ BASE_URL: "http://localhost" });
    proc = started.proc;
    port = started.port;

    const indexes = new Set<string>(["/sitemap.xml"]);
    for (const entry of (await fetchPath("/sitemap.xml")).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      indexes.add(new URL(entry[1]).pathname);
    }
    const paths = new Set<string>(["/"]);
    for (const sitemap of indexes) {
      for (const entry of (await fetchPath(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const pathname = new URL(entry[1]).pathname;
        if (!indexes.has(pathname)) paths.add(pathname);
      }
    }
    sweptPaths = [...paths].sort().filter(p => !p.endsWith(".xml"));

    let next = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        while (next < sweptPaths.length) await fetchPath(sweptPaths[next++]);
      }),
    );

    for (const pathname of sweptPaths) {
      const here = faqAnswersIn(pathname, bodies.get(pathname) ?? "");
      if (here.length > 0) blocksByPath.set(pathname, here.length);
      answers.push(...here);
    }
  });

  after(() => proc?.kill());

  it("reads every FAQ answer the site serves", () => {
    assertCoversPopulation(sweptPaths.length, vendorsInTheCatalogue(), "paths served for the sweep");
    assertPopulationFloor(blocksByPath.size, 1500, "served pages publishing an FAQPage block");
    assertPopulationFloor(answers.length, 9000, "FAQ answers parsed out of FAQPage markup");
    assertPopulationFloor(vendorNames.length, 900, "catalogue vendor names the sweep matches against");
  });

  it("names no vendor as best, top, most popular or most generous without printing the quantity that ranked it", () => {
    const crowning: string[] = [];
    for (const answer of answers) {
      for (const sentence of faqSentences(answer.a)) {
        if (!namesASuperlative(sentence)) continue;
        if (vendorsNamedIn(sentence).length === 0) continue;
        if (ordersByAPrintedQuantity(sentence)) continue;
        if (quotesCatalogueProse(sentence)) continue;
        crowning.push(`${answer.path} :: ${sentence.slice(0, 120)}`);
      }
    }
    assert.deepStrictEqual(crowning, [], `FAQ answers crowning a vendor: ${crowning.length}`);
  });

  it("keeps the surviving superlatives to catalogue prose and rules the reader can apply", () => {
    let fromCatalogueProse = 0;
    let ordered = 0;
    for (const answer of answers) {
      for (const sentence of faqSentences(answer.a)) {
        if (!namesASuperlative(sentence)) continue;
        if (vendorsNamedIn(sentence).length === 0) continue;
        if (ordersByAPrintedQuantity(sentence)) ordered++;
        else fromCatalogueProse++;
      }
    }
    assert.ok(
      fromCatalogueProse <= CATALOGUE_PROSE_CROWNS,
      `superlatives carried in from a catalogue record's own description: ${fromCatalogueProse}, allowed ${CATALOGUE_PROSE_CROWNS}`,
    );
    assert.ok(ordered >= 1, "no answer demonstrates a superlative backed by the quantity it ranks by");
  });

  it("publishes no answer built on a population of nothing", () => {
    const empty = answers
      .filter(a => /\b(?:We hold|comparison of|We track|There are)\s+0\b/.test(a.a))
      .map(a => `${a.path} :: ${a.q}`);
    assert.deepStrictEqual(empty, [], `answers stating a population of zero: ${empty.length}`);
  });

  it("lists a vendor among free services only where the record we hold states a free tier", () => {
    const listing = /(?:services|tools|options|alternatives|platforms)\s+include\s+([^.]*)/gi;
    const contradicted: string[] = [];
    for (const answer of answers) {
      for (const match of answer.a.matchAll(listing)) {
        for (const vendor of vendorsNamedIn(match[1])) {
          if (deniesAFreeTier.get(vendor)) contradicted.push(`${answer.path} :: ${vendor} — ${match[1].slice(0, 80)}`);
        }
      }
    }
    assert.deepStrictEqual(contradicted, [], `answers listing a vendor whose own record denies a free tier: ${contradicted.length}`);
  });

  it("counts one named catalogue category behind every denominator it publishes", () => {
    const held = /We hold (\d+) (.+?) services in our catalogue/g;
    const wrong: string[] = [];
    const named = new Set<string>();
    for (const answer of answers) {
      for (const match of answer.a.matchAll(held)) {
        const stated = parseInt(match[1], 10);
        const category = match[2];
        const actual = offers.filter(o => o.category === category).length;
        named.add(category);
        if (actual !== stated || actual === 0) wrong.push(`${answer.path} :: ${category} stated ${stated}, catalogue holds ${actual}`);
      }
    }
    assertCoversPopulation(named.size, categoriesInTheCatalogue(), "categories publishing a denominator in an answer");
    assert.deepStrictEqual(wrong, [], `denominators that name no single catalogue category: ${wrong.length}`);
  });

  it("sends a comparison page's reader only to category hubs the site serves", () => {
    const served = new Set(sweptPaths);
    const missing: string[] = [];
    let checked = 0;
    for (const [pathname, html] of bodies) {
      if (!/comparison-2026$/.test(pathname)) continue;
      for (const link of html.matchAll(/(\/category\/[a-z0-9-]+)(?=["'\s<])/g)) {
        checked++;
        if (!served.has(link[1])) missing.push(`${pathname} → ${link[1]}`);
      }
    }
    assertPopulationFloor(checked, 18, "category hub links rendered on comparison pages");
    assert.deepStrictEqual(missing, [], `comparison pages linking a category hub the sitemap does not serve: ${missing.length}`);
  });

  it("states the rule wherever it declines to rank", () => {
    const declining = answers.filter(a => a.a.includes(NO_RANKING_HELD));
    assertPopulationFloor(declining.length, 300, "answers that decline to rank");
    const withoutTheRule = declining.filter(a => !a.a.includes("/criteria")).map(a => a.path);
    assert.deepStrictEqual(withoutTheRule, [], "answers declining to rank without pointing at the published rule");
  });
});
