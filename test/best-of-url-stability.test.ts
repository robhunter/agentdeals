import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichOffers, getCategories, loadDealChanges, loadOffers } from "../dist/data.js";
import { buildProductFunctions, functionMembers, type ProductFunction } from "../dist/product-function.js";
import { rankOffers } from "../dist/ranking.js";
import { verificationLedger } from "../dist/verification-state.js";
import {
  bestOfPathResolves,
  parseBestOfPublished,
  readBestOfPublished,
  recordBestOfPublished,
  serializeBestOfPublished,
} from "../dist/best-of-publication.js";
import { toSlug } from "../dist/slug.js";
import { gateDisclosureSentence, matchingSubject } from "../dist/gate-disclosure.js";
import { CATEGORY_RETIREMENTS } from "../dist/category-scope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DAY_MS = 86400000;

const serveSource = fs.readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
const MIN_VENDORS = Number(/const BEST_OF_MIN_VENDORS = (\d+);/.exec(serveSource)?.[1]);
const MIN_PICKS = Number(/const BEST_OF_MIN_PICKS = (\d+);/.exec(serveSource)?.[1]);

const offers = loadOffers();
const categories = getCategories();
const changes = loadDealChanges();
const ledger = verificationLedger();
const functions = buildProductFunctions(categories.map(c => c.name));
const published = readBestOfPublished();
const TODAY = new Date().toISOString().slice(0, 10);

const CLOCK_DAYS_DEMONSTRATED = ["2026-10-29", "2026-12-01"];

function dayAfter(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function rankingOf(fn: ProductFunction, date: string) {
  return rankOffers(enrichOffers(functionMembers(offers, fn)), {
    queryKey: `best-of:${fn.categories[0] ?? fn.subtypes[0]}`,
    changes,
    date,
    verificationLedger: ledger,
  });
}

function qualifiedCount(fn: ProductFunction, date: string): number {
  return rankingOf(fn, date).qualified.length;
}

function escapeForHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function reachesTheVendorFloor(fn: ProductFunction): boolean {
  return functionMembers(offers, fn).filter(o => !o.eligibility).length >= MIN_VENDORS;
}

function slugsResolvingOn(date: string): Set<string> {
  const resolving = new Set<string>();
  for (const fn of functions) {
    const slug = `free-${fn.slug}`;
    if (!reachesTheVendorFloor(fn) && !published.slugs.includes(slug)) continue;
    const resolves = bestOfPathResolves({
      qualified: qualifiedCount(fn, date),
      minPicks: MIN_PICKS,
      publishedBefore: published.slugs.includes(slug),
    });
    if (resolves) resolving.add(slug);
  }
  return resolving;
}

describe("the rule that decides whether a best-of path resolves", () => {
  it("resolves a path already published even when its list is under the picks floor", () => {
    assert.strictEqual(bestOfPathResolves({ qualified: 1, minPicks: 2, publishedBefore: true }), true);
    assert.strictEqual(bestOfPathResolves({ qualified: 0, minPicks: 2, publishedBefore: true }), true);
  });

  it("leaves a path that has never published unresolved until it reaches the floor", () => {
    assert.strictEqual(bestOfPathResolves({ qualified: 1, minPicks: 2, publishedBefore: false }), false);
    assert.strictEqual(bestOfPathResolves({ qualified: 2, minPicks: 2, publishedBefore: false }), true);
  });

  it("reads the floor from its argument rather than from a constant of its own", () => {
    assert.strictEqual(bestOfPathResolves({ qualified: 2, minPicks: 3, publishedBefore: false }), false);
    assert.strictEqual(bestOfPathResolves({ qualified: 2, minPicks: 1, publishedBefore: false }), true);
  });
});

describe("the ledger of best-of paths the site has published", () => {
  it("holds every path serving today", () => {
    const missing = [...slugsResolvingOn(TODAY)].filter(slug => !published.slugs.includes(slug)).sort();
    assert.deepStrictEqual(missing, [], `serving today and absent from data/best-of-published.json: ${missing.join(", ")}`);
  });

  it("keeps a path a later run does not see", () => {
    const previous = { version: 1 as const, generated: "2026-09-01", slugs: ["free-search", "free-video"] };
    const { ledger: next, added } = recordBestOfPublished(previous, [], "2026-12-01");
    assert.deepStrictEqual(next.slugs, ["free-search", "free-video"]);
    assert.deepStrictEqual(added, []);
  });

  it("records a path the first time a run sees it", () => {
    const previous = { version: 1 as const, generated: "2026-09-01", slugs: ["free-video"] };
    const { ledger: next, added } = recordBestOfPublished(previous, ["free-video", "free-search"], "2026-12-01");
    assert.deepStrictEqual(next.slugs, ["free-search", "free-video"]);
    assert.deepStrictEqual(added, ["free-search"]);
    assert.strictEqual(next.generated, "2026-12-01");
  });

  it("survives a round trip through the file it is written to", () => {
    const round = parseBestOfPublished(serializeBestOfPublished(published), "round trip");
    assert.deepStrictEqual(round, published);
  });

  it("refuses a path where a slug belongs", () => {
    assert.throws(
      () => parseBestOfPublished(JSON.stringify({ version: 1, generated: "2026-09-20", slugs: ["/best/free-search"] }), "fixture"),
      /expected the slug alone/,
    );
  });
});

describe("a best-of path that has answered 200 keeps answering", () => {
  it("resolves every path in the ledger on every day for the next four months", () => {
    const today = slugsResolvingOn(TODAY);
    const lost: string[] = [];
    for (let d = 1; d <= 120; d++) {
      const date = dayAfter(TODAY, d);
      const resolving = slugsResolvingOn(date);
      for (const slug of today) {
        if (!resolving.has(slug)) lost.push(`${slug} on ${date}`);
      }
    }
    assert.deepStrictEqual(lost, [], `best-of paths that stop resolving: ${lost.slice(0, 10).join(", ")}`);
  });

  it("holds on the two days the qualified lists collapse furthest", () => {
    for (const date of CLOCK_DAYS_DEMONSTRATED) {
      const resolving = slugsResolvingOn(date);
      const underTheFloor = functions.filter(fn =>
        resolving.has(`free-${fn.slug}`) && qualifiedCount(fn, date) < MIN_PICKS);
      assert.ok(
        underTheFloor.length > 0,
        `${date} puts no published best-of page under the picks floor, so this day demonstrates nothing`,
      );
      for (const fn of underTheFloor) {
        assert.ok(published.slugs.includes(`free-${fn.slug}`), `free-${fn.slug} serves on ${date} without ever having published`);
      }
    }
  });

  it("does not publish a path that has never reached the floor", () => {
    const neverPublished = functions
      .filter(fn => reachesTheVendorFloor(fn) && !published.slugs.includes(`free-${fn.slug}`))
      .map(fn => `free-${fn.slug}`);
    const resolving = slugsResolvingOn(TODAY);
    for (const slug of neverPublished) {
      assert.ok(!resolving.has(slug), `${slug} has never published and would begin serving`);
    }
  });
});

describe("a best-of path whose category the index no longer carries", () => {
  it("keeps a retired category's best-of path in the ledger", () => {
    const retiredWithAPath = Object.keys(CATEGORY_RETIREMENTS)
      .map(name => `free-${toSlug(name)}`)
      .filter(slug => published.slugs.includes(slug));
    assert.ok(retiredWithAPath.length > 0, "no retired category has a best-of path in the ledger, so the redirect covers nothing");
    for (const slug of retiredWithAPath) {
      assert.ok(!functions.some(fn => `free-${fn.slug}` === slug), `${slug} still has a product function and needs no redirect`);
    }
  });
});

function clockShiftMsTo(day: string): number {
  return Date.parse(`${day}T12:00:00Z`) - Date.now();
}

function startServer(env: NodeJS.ProcessEnv, atDay?: string): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const args = atDay ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const child = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        ...(atDay ? { AGENTDEALS_CLOCK_SHIFT_MS: String(clockShiftMsTo(atDay)) } : {}),
        ...env,
      },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 90000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

describe("the site as its own clock will read it on 2026-10-29 and on 2026-12-01", () => {
  let ahead: ChildProcess;
  let aheadPort = 0;
  let october: ChildProcess;
  let octoberPort = 0;
  let today: ChildProcess;
  let todayPort = 0;

  before(async () => {
    [
      { child: ahead, port: aheadPort },
      { child: october, port: octoberPort },
      { child: today, port: todayPort },
    ] = await Promise.all([
      startServer({}, CLOCK_DAYS_DEMONSTRATED[1]),
      startServer({}, CLOCK_DAYS_DEMONSTRATED[0]),
      startServer({}),
    ]);
  });
  after(() => { ahead?.kill(); october?.kill(); today?.kill(); });

  async function status(port: number, pathname: string): Promise<number> {
    const res = await fetch(`http://localhost:${port}${pathname}`, { redirect: "manual" });
    await res.text();
    return res.status;
  }

  async function body(port: number, pathname: string): Promise<string> {
    const res = await fetch(`http://localhost:${port}${pathname}`);
    return res.text();
  }

  it("counts on the page what the ranker counts for the day the clock reads", async () => {
    const disagreeing: string[] = [];
    let compared = 0;
    for (const fn of functions) {
      const slug = `free-${fn.slug}`;
      if (!published.slugs.includes(slug)) continue;
      if (await status(aheadPort, `/best/${slug}`) !== 200) continue;
      const html = await body(aheadPort, `/best/${slug}`);
      const stated = /(\d+) offers? (?:meets|meet) the criteria/.exec(html);
      if (!stated) { disagreeing.push(`${slug} states no count`); continue; }
      compared++;
      const byTheClock = qualifiedCount(fn, CLOCK_DAYS_DEMONSTRATED[1]);
      if (Number(stated[1]) !== byTheClock) disagreeing.push(`${slug}: page ${stated[1]}, ranker ${byTheClock}`);
    }
    assert.ok(compared >= 50, `only ${compared} pages were compared`);
    assert.deepStrictEqual(disagreeing, [], `pages where the served count and the ranker disagree: ${disagreeing.slice(0, 8).join(", ")}`);
  });

  it("answers 200 for every best-of path that answers 200 today", async () => {
    const lost: string[] = [];
    for (const slug of published.slugs) {
      const now = await status(todayPort, `/best/${slug}`);
      if (now !== 200 && now !== 301) continue;
      for (const [label, port] of [["2026-10-29", octoberPort], ["2026-12-01", aheadPort]] as const) {
        const then = await status(port, `/best/${slug}`);
        if (then !== now) lost.push(`/best/${slug}: ${now} today, ${then} on ${label}`);
      }
    }
    assert.deepStrictEqual(lost, [], `best-of paths whose answer changes: ${lost.join(", ")}`);
  });

  it("states what a page under the picks floor holds", async () => {
    const underTheFloor = functions
      .filter(fn => published.slugs.includes(`free-${fn.slug}`) && qualifiedCount(fn, CLOCK_DAYS_DEMONSTRATED[1]) < MIN_PICKS);
    assert.ok(underTheFloor.length > 0, "no published page is under the floor on the day being demonstrated");
    for (const fn of underTheFloor) {
      const html = await body(aheadPort, `/best/free-${fn.slug}`);
      const stated = /(\d+) offers? (?:meets|meet) the criteria and (\d+) offers? (?:is|are) demoted with a named reason/.exec(html);
      assert.ok(stated, `/best/free-${fn.slug} does not state how many offers meet the criteria`);
      assert.ok(Number(stated[1]) < MIN_PICKS, `/best/free-${fn.slug} states ${stated[1]} offers meeting the criteria, expected fewer than ${MIN_PICKS}`);
      assert.ok(Number(stated[2]) > 0, `/best/free-${fn.slug} states no demoted offer and so accounts for nothing it holds`);
    }
  });

  it("lists no best-of path in the sitemap that answers 404", async () => {
    const xml = await body(aheadPort, "/sitemap-pages.xml");
    const paths = [...xml.matchAll(/<loc>[^<]*?(\/best\/[^<]*)<\/loc>/g)].map(m => m[1]);
    assert.ok(paths.length > 0, "the sitemap lists no best-of path at all");
    const dead: string[] = [];
    for (const pathname of paths) {
      if (await status(aheadPort, pathname) !== 200) dead.push(pathname);
    }
    assert.deepStrictEqual(dead, [], `sitemap paths answering 404: ${dead.join(", ")}`);
  });

  it("keeps every category path it serves today", async () => {
    const gone: string[] = [];
    for (const c of categories) {
      const pathname = `/category/${toSlug(c.name)}`;
      if (await status(todayPort, pathname) !== 200) continue;
      if (await status(aheadPort, pathname) !== 200) gone.push(pathname);
    }
    assert.deepStrictEqual(gone, [], `category paths lost by 2026-12-01: ${gone.join(", ")}`);
  });

  it("sends a retired category's best-of path to the category it retired from", async () => {
    for (const name of Object.keys(CATEGORY_RETIREMENTS)) {
      const slug = `free-${toSlug(name)}`;
      if (!published.slugs.includes(slug)) continue;
      const res = await fetch(`http://localhost:${todayPort}/best/${slug}`, { redirect: "manual" });
      await res.text();
      assert.strictEqual(res.status, 301, `/best/${slug} answers ${res.status}`);
      const location = res.headers.get("location");
      assert.strictEqual(location, `/category/${toSlug(name)}`);
      assert.strictEqual(await status(todayPort, location!), 200, `${location} does not answer`);
    }
  });

  it("counts the offers it gates, and says under which rule", async () => {
    const pagesWithAGate = functions.filter(fn => published.slugs.includes(`free-${fn.slug}`) && rankingOf(fn, TODAY).excluded.length > 0);
    assert.ok(pagesWithAGate.length >= 10, `only ${pagesWithAGate.length} published pages gate an offer today`);
    for (const fn of pagesWithAGate) {
      const ranking = rankingOf(fn, TODAY);
      const held = ranking.ranked.length + ranking.excluded.length;
      const expected = gateDisclosureSentence(
        matchingSubject("offer", held),
        held,
        ranking.excluded.map(e => e.gate.code),
      );
      const html = await body(todayPort, `/best/free-${fn.slug}`);
      assert.ok(html.includes('id="not-ranked"'), `/best/free-${fn.slug} carries no block for the offers it gates`);
      assert.ok(html.includes(escapeForHtml(expected)), `/best/free-${fn.slug} does not state "${expected}"`);
    }
  });

  it("keeps a published path while it still holds a record, and withdraws it when it holds none", async () => {
    const held = functions.find(fn => fn.slug === "search" && published.slugs.includes("free-search"));
    assert.ok(held, "free-search is not a published category function, so this pair demonstrates nothing");
    const members = functionMembers(offers, held!).map(o => o.vendor);
    assert.ok(members.length >= MIN_VENDORS, `Search holds ${members.length} records, fewer than the vendor floor`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "best-of-emptied-"));
    const catalogue = JSON.parse(fs.readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
    const movedTo = "Databases";
    const away = (keep: number) => ({
      ...catalogue,
      offers: catalogue.offers.map((o: { vendor: string; category: string }) =>
        members.includes(o.vendor) && members.indexOf(o.vendor) >= keep ? { ...o, category: movedTo, tags: ["databases"], product_subtypes: undefined } : o),
    });
    const oneLeft = path.join(dir, "one-left.json");
    const noneLeft = path.join(dir, "none-left.json");
    fs.writeFileSync(oneLeft, JSON.stringify(away(1)));
    fs.writeFileSync(noneLeft, JSON.stringify(away(0)));

    const [a, b] = await Promise.all([
      startServer({ AGENTDEALS_INDEX_PATH: oneLeft }),
      startServer({ AGENTDEALS_INDEX_PATH: noneLeft }),
    ]);
    try {
      assert.strictEqual(await status(a.port, "/best/free-search"), 200, "/best/free-search is withdrawn while it still holds a record");
      assert.notStrictEqual(await status(b.port, "/best/free-search"), 200, "/best/free-search still answers with no record behind it");
    } finally {
      a.child.kill();
      b.child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing of the kind on a page that gates nothing", async () => {
    const clean = functions.find(fn => published.slugs.includes(`free-${fn.slug}`) && rankingOf(fn, TODAY).excluded.length === 0);
    assert.ok(clean, "every published page gates an offer, so the empty case is untested");
    const html = await body(todayPort, `/best/free-${clean!.slug}`);
    assert.ok(!html.includes('id="not-ranked"'), `/best/free-${clean!.slug} gates nothing and still carries the block`);
  });
});
