import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daysBetween, emptyPageLastmod, entryDay, fallbackDay, hashPageBody, httpDate, isDailyEntry, lastmodFor, newestLastmod,
  parsePageLastmod, readPageLastmod, serializePageLastmod, updatePageLastmod, type PageLastmodLedger,
} from "../dist/page-lastmod.js";
import { entityTag } from "../dist/conditional-request.js";
import { toSlug } from "../dist/slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let server: ChildProcess;
let base = "";
let inventory: string[] = [];
let scratch = "";

function startServer(inventoryOut: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const SITEMAPS = ["vendors", "comparisons", "pages", "reports", "misc"] as const;

async function sitemapEntries(name: string): Promise<Array<{ loc: string; lastmod: string }>> {
  const xml = await (await fetch(`${base}/sitemap-${name}.xml`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]
    .map(m => ({ loc: m[1].replace("http://localhost", ""), lastmod: m[2] }));
}

const RETITLED = ["/monitoring-comparison-2026", "/llm-api-pricing"];
const REPRICED = "/vercel-vs-netlify";
const THE_DAY_THOSE_PAGES_CHANGED = "2026-09-04";

describe("page lastmod ledger", () => {
  it("keeps the recorded day for a page whose output has not moved", () => {
    const previous: PageLastmodLedger = {
      version: 1,
      generated: "2026-08-01",
      pages: { "/guides/a": { hash: "aaaa", changed: "2026-05-02" } },
    };
    const { ledger, moved, added, dropped } = updatePageLastmod(previous, new Map([["/guides/a", "aaaa"]]), "2026-09-05");
    assert.deepEqual(ledger.pages["/guides/a"], { hash: "aaaa", changed: "2026-05-02" });
    assert.deepEqual([moved, added, dropped], [[], [], []]);
    assert.equal(ledger.generated, "2026-09-05");
  });

  it("advances the day for a page whose rendered output changed", () => {
    const previous: PageLastmodLedger = {
      version: 1,
      generated: "2026-08-01",
      pages: {
        "/guides/a": { hash: "aaaa", changed: "2026-05-02" },
        "/guides/b": { hash: "bbbb", changed: "2026-05-02" },
      },
    };
    const { ledger, moved } = updatePageLastmod(
      previous,
      new Map([["/guides/a", "aaaa"], ["/guides/b", "cccc"]]),
      "2026-09-05",
    );
    assert.deepEqual(ledger.pages["/guides/b"], { hash: "cccc", changed: "2026-09-05" });
    assert.deepEqual(ledger.pages["/guides/a"], { hash: "aaaa", changed: "2026-05-02" });
    assert.deepEqual(moved, ["/guides/b"]);
  });

  it("stamps a page it has never read with the day it first read it, and forgets a page that is gone", () => {
    const previous = emptyPageLastmod("2026-08-01");
    previous.pages["/gone"] = { hash: "zzzz", changed: "2026-06-01" };
    const { ledger, added, dropped } = updatePageLastmod(previous, new Map([["/new", "nnnn"]]), "2026-09-05");
    assert.deepEqual(ledger.pages["/new"], { hash: "nnnn", changed: "2026-09-05" });
    assert.equal(ledger.pages["/gone"], undefined);
    assert.deepEqual([added, dropped], [["/new"], ["/gone"]]);
  });

  it("reads the same page identically whichever origin served it", () => {
    const body = '<a href="https://agentdeals.dev/guides/a">x</a>';
    const local = '<a href="http://localhost:1234/guides/a">x</a>';
    assert.equal(
      hashPageBody(body, "https://agentdeals.dev"),
      hashPageBody(local, "http://localhost:1234"),
    );
  });

  it("refuses a ledger it cannot trust", () => {
    assert.throws(() => parsePageLastmod('{"version":2,"generated":"2026-09-05","pages":{}}', "x"), /version 2/);
    assert.throws(() => parsePageLastmod('{"version":1,"generated":"today","pages":{}}', "x"), /generated/);
    assert.throws(() => parsePageLastmod('{"version":1,"generated":"2026-09-05"}', "x"), /pages/);
    assert.throws(
      () => parsePageLastmod('{"version":1,"generated":"2026-09-05","pages":{"/a":{"hash":"h","changed":"April"}}}', "x"),
      /changed date/,
    );
    assert.throws(
      () => parsePageLastmod('{"version":1,"generated":"2026-09-05","pages":{"a":{"hash":"h","changed":"2026-09-05"}}}', "x"),
      /beginning with \//,
    );
  });

  it("round-trips through the file format with its pages in a stable order", () => {
    const ledger: PageLastmodLedger = {
      version: 1,
      generated: "2026-09-05",
      pages: { "/b": { hash: "b", changed: "2026-01-01" }, "/a": { hash: "a", changed: "2026-01-02" } },
    };
    const text = serializePageLastmod(ledger);
    assert.ok(text.indexOf('"/a"') < text.indexOf('"/b"'));
    assert.deepEqual(parsePageLastmod(text, "x"), { ...ledger, pages: { "/a": ledger.pages["/a"], "/b": ledger.pages["/b"] } });
  });

  it("answers with the fallback for a page it has never read", () => {
    const ledger = emptyPageLastmod("2026-09-05");
    assert.equal(lastmodFor(ledger, "/unread", "2026-09-01", "2026-09-05"), "2026-09-01");
    assert.equal(newestLastmod(ledger, [], "2026-09-01", "2026-09-05"), "2026-09-01");
  });

  it("reports the newest day across a set of pages", () => {
    const ledger: PageLastmodLedger = {
      version: 1,
      generated: "2026-09-05",
      pages: { "/a": { hash: "a", changed: "2026-07-01" }, "/b": { hash: "b", changed: "2026-08-09" } },
    };
    assert.equal(newestLastmod(ledger, ["/a", "/b"], "2026-01-01", "2026-09-05"), "2026-08-09");
  });

  it("formats a day as an HTTP date and refuses anything else", () => {
    assert.equal(httpDate("2026-09-04"), "Fri, 04 Sep 2026 00:00:00 GMT");
    assert.equal(httpDate("2026-09-05"), "Sat, 05 Sep 2026 00:00:00 GMT");
    assert.equal(httpDate("yesterday"), null);
  });

  it("never dates an unread page earlier than the ledger that shipped with it", () => {
    assert.equal(fallbackDay("2026-09-05", "2026-08-20"), "2026-09-05");
    assert.equal(fallbackDay("1980-01-01", "2026-08-20"), "2026-08-20");
    assert.equal(fallbackDay("2026-08-20", "2026-08-20"), "2026-08-20");
  });

  it("counts the days between two days", () => {
    assert.equal(daysBetween("2026-09-01", "2026-09-08"), 7);
    assert.equal(daysBetween("2026-09-08", "2026-09-01"), -7);
    assert.equal(daysBetween("2026-09-08", "2026-09-08"), 0);
  });
});

describe("a page keeps the day it changed, whenever that was", () => {
  const FIXTURE = {
    version: 1,
    generated: "2026-08-20",
    pages: {
      "/privacy": { hash: "unchanged-since-february", changed: "2026-02-03" },
      "/compare/netlify-vs-vercel": { hash: "moved-in-august", changed: "2026-08-19" },
    },
  };
  let fixtureServer: ChildProcess;
  let fixtureBase = "";
  let fixtureDir = "";

  before(async () => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "page-lastmod-fixture-"));
    const ledgerPath = path.join(fixtureDir, "page-lastmod.json");
    writeFileSync(ledgerPath, JSON.stringify(FIXTURE, null, 2));
    fixtureServer = await new Promise<ChildProcess>((resolve, reject) => {
      const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_PAGE_LASTMOD_PATH: ledgerPath },
      });
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("Server startup timeout"));
      }, 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          fixtureBase = `http://localhost:${match[1]}`;
          clearTimeout(timeout);
          resolve(proc);
        }
      });
      proc.on("error", err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  after(() => {
    if (fixtureServer) fixtureServer.kill();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function entries(name: string): Promise<Map<string, string>> {
    const xml = await (await fetch(`${fixtureBase}/sitemap-${name}.xml`)).text();
    return new Map([...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]
      .map(m => [m[1].replace("http://localhost", ""), m[2]]));
  }

  it("advertises the recorded day, not the day the build shipped", async () => {
    assert.equal((await entries("pages")).get("/privacy"), "2026-02-03");
    assert.equal((await entries("comparisons")).get("/compare/netlify-vs-vercel"), "2026-08-19");
  });

  it("serves that same day as Last-Modified", async () => {
    const response = await fetch(`${fixtureBase}/privacy`);
    await response.text();
    assert.equal(response.headers.get("last-modified"), "Tue, 03 Feb 2026 00:00:00 GMT");
  });

  it("summarises a sitemap by the newest page in it", async () => {
    const xml = await (await fetch(`${fixtureBase}/sitemap.xml`)).text();
    const comparisons = xml.match(/<loc>[^<]*sitemap-comparisons\.xml<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/);
    const listed = await entries("comparisons");
    const newest = [...listed.values()].sort().pop();
    assert.equal(comparisons![1], newest);
  });

  it("falls back to the day the build shipped for a page it has no record of", async () => {
    const listed = await entries("pages");
    const today = new Date().toISOString().slice(0, 10);
    for (const loc of ["/press", "/setup", "/badges", "/guides"]) {
      const day = listed.get(loc);
      assert.ok(day, `${loc} is missing from the pages sitemap`);
      assert.ok(day! > FIXTURE.generated && day! <= today, `${loc} fell back to ${day}`);
    }
  });

  it("answers a request that already holds the page's own day with 304 and no body", async () => {
    const response = await fetch(`${fixtureBase}/privacy`, {
      headers: { "If-Modified-Since": "Tue, 03 Feb 2026 00:00:00 GMT" },
    });
    const body = await response.text();
    assert.equal(response.status, 304);
    assert.equal(body, "");
    assert.equal(response.headers.get("last-modified"), "Tue, 03 Feb 2026 00:00:00 GMT");
    assert.equal(response.headers.get("content-type"), null);
  });

  it("answers a request holding a day older than the page's with the whole page", async () => {
    const response = await fetch(`${fixtureBase}/privacy`, {
      headers: { "If-Modified-Since": "Mon, 02 Feb 2026 00:00:00 GMT" },
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes("</html>"), "the body was withheld from a client whose copy is older than the page");
  });

  it("sends the whole page to a client whose copy is newer than the day it holds, once that page moves", async () => {
    const stale = await fetch(`${fixtureBase}/compare/netlify-vs-vercel`, {
      headers: { "If-Modified-Since": "Tue, 18 Aug 2026 00:00:00 GMT" },
    });
    await stale.text();
    assert.equal(stale.status, 200, "a copy taken the day before the page moved is out of date");
    const current = await fetch(`${fixtureBase}/compare/netlify-vs-vercel`, {
      headers: { "If-Modified-Since": "Wed, 19 Aug 2026 00:00:00 GMT" },
    });
    await current.text();
    assert.equal(current.status, 304);
  });

  it("sends the whole page when the date it was asked about is not one it can read", async () => {
    for (const asked of ["2026-02-03", "yesterday", "Tue, 03 Feb 2026"]) {
      const response = await fetch(`${fixtureBase}/privacy`, { headers: { "If-Modified-Since": asked } });
      await response.text();
      assert.equal(response.status, 200, `${JSON.stringify(asked)} was read as a date`);
    }
  });

  it("dates the URL it hashed, so a query string carries no day and revalidates nothing", async () => {
    const plain = await fetch(`${fixtureBase}/privacy`);
    await plain.text();
    assert.equal(plain.headers.get("last-modified"), "Tue, 03 Feb 2026 00:00:00 GMT");
    const queried = await fetch(`${fixtureBase}/privacy?utm_source=elsewhere`, {
      headers: { "If-Modified-Since": "Tue, 03 Feb 2026 00:00:00 GMT" },
    });
    const body = await queried.text();
    assert.equal(queried.headers.get("last-modified"), null);
    assert.equal(queried.status, 200);
    assert.ok(body.includes("</html>"));
  });

  it("leaves the decision to the entity tag when the client sends one", async () => {
    const response = await fetch(`${fixtureBase}/privacy`, {
      headers: { "If-Modified-Since": "Tue, 03 Feb 2026 00:00:00 GMT", "If-None-Match": '"a-tag-we-never-issued"' },
    });
    await response.text();
    assert.equal(response.status, 200);
  });

  it("tags every page with a fingerprint of the bytes it just sent", async () => {
    for (const page of ["/privacy", "/vendor/supabase", "/"]) {
      const response = await fetch(`${fixtureBase}${page}`);
      const body = await response.text();
      const tag = response.headers.get("etag");
      assert.ok(tag, `${page} served no entity tag`);
      assert.equal(tag, entityTag(body), `${page} tagged something other than the body it sent`);
    }
  });

  it("gives two pages different tags, and the same page the same tag twice", async () => {
    const readTag = async (page: string) => {
      const response = await fetch(`${fixtureBase}${page}`);
      await response.text();
      return response.headers.get("etag");
    };
    const privacy = await readTag("/privacy");
    const comparison = await readTag("/compare/netlify-vs-vercel");
    const privacyAgain = await readTag("/privacy");
    assert.ok(privacy && comparison);
    assert.notEqual(privacy, comparison, "two different pages share an entity tag");
    assert.equal(privacy, privacyAgain, "one unchanged page changed its entity tag between two reads");
  });

  it("answers a client holding our own tag with 304 and no body", async () => {
    const first = await fetch(`${fixtureBase}/privacy`);
    await first.text();
    const tag = first.headers.get("etag")!;
    const second = await fetch(`${fixtureBase}/privacy`, { headers: { "If-None-Match": tag } });
    const body = await second.text();
    assert.equal(second.status, 304);
    assert.equal(body, "");
    assert.equal(second.headers.get("etag"), tag, "the 304 dropped the validator the client must keep");
    assert.equal(second.headers.get("content-type"), null);
  });

  it("revalidates a page the ledger does not hold by its tag, and advertises no day for it", async () => {
    const first = await fetch(`${fixtureBase}/vendor/supabase`);
    const body = await first.text();
    const tag = first.headers.get("etag")!;
    assert.equal(first.headers.get("last-modified"), null, "a page nothing has read advertises a day anyway");
    assert.ok(body.includes("</html>"), "/vendor/supabase served no whole page to compare against");

    const byTag = await fetch(`${fixtureBase}/vendor/supabase`, { headers: { "If-None-Match": tag } });
    assert.equal(await byTag.text(), "");
    assert.equal(byTag.status, 304, "a vendor page re-sent a body the client already holds");

    const byDay = await fetch(`${fixtureBase}/vendor/supabase`, { headers: { "If-Modified-Since": httpDate("2026-01-01")! } });
    await byDay.text();
    assert.equal(byDay.status, 200, "a page with no recorded day answered 304 against a day it never published");
  });

  it("sends the whole page to a client holding a tag that is not ours", async () => {
    for (const asked of ['"0000000000000000"', 'W/"0000000000000000"', '"0000000000000000", "1111111111111111"']) {
      const response = await fetch(`${fixtureBase}/privacy`, { headers: { "If-None-Match": asked } });
      const body = await response.text();
      assert.equal(response.status, 200, `${asked} was read as our own tag`);
      assert.ok(body.includes("</html>"), `the body was withheld from a client holding ${asked}`);
    }
  });

  it("compares weakly, so a cache that weakened our tag still revalidates", async () => {
    const first = await fetch(`${fixtureBase}/privacy`);
    await first.text();
    const tag = first.headers.get("etag")!;
    const response = await fetch(`${fixtureBase}/privacy`, { headers: { "If-None-Match": `W/${tag}` } });
    await response.text();
    assert.equal(response.status, 304);
  });

  it("tags a URL carrying a query string, which carries no day to revalidate against", async () => {
    const first = await fetch(`${fixtureBase}/privacy?utm_source=elsewhere`);
    await first.text();
    const tag = first.headers.get("etag");
    assert.ok(tag, "a query-string URL served no entity tag");
    assert.equal(first.headers.get("last-modified"), null);
    const second = await fetch(`${fixtureBase}/privacy?utm_source=elsewhere`, { headers: { "If-None-Match": tag! } });
    await second.text();
    assert.equal(second.status, 304);
  });

  it("tags an answer to HEAD, which is how a crawler asks what it would get", async () => {
    const head = await fetch(`${fixtureBase}/vendor/supabase`, { method: "HEAD" });
    await head.text();
    const get = await fetch(`${fixtureBase}/vendor/supabase`);
    await get.text();
    assert.ok(head.headers.get("etag"), "HEAD served no entity tag");
    assert.equal(head.headers.get("etag"), get.headers.get("etag"));
  });

  it("leaves a response that is not a page untagged, so nothing revalidates against a guess", async () => {
    const json = await fetch(`${fixtureBase}/api/offers`);
    await json.text();
    assert.equal(json.headers.get("etag"), null, "a JSON response carried an entity tag");
    const missing = await fetch(`${fixtureBase}/vendor/a-vendor-we-do-not-list`);
    await missing.text();
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("etag"), null, "a 404 carried an entity tag");
  });
});

describe("what the sitemaps say about when a page changed", () => {
  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "page-lastmod-test-"));
    server = await startServer(path.join(scratch, "inventory.json"));
    inventory = JSON.parse(readFileSync(path.join(scratch, "inventory.json"), "utf-8"));
  });

  after(() => {
    if (server) server.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("takes every lastmod from the ledger for the pages the ledger covers", async () => {
    const ledger = readPageLastmod();
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set<string>();
    for (const name of SITEMAPS) {
      for (const { loc, lastmod } of await sitemapEntries(name)) {
        const recorded = ledger.pages[loc];
        if (!recorded) continue;
        seen.add(loc);
        const held = entryDay(recorded, today);
        assert.equal(lastmod, held, `${loc} advertises ${lastmod} where the ledger holds ${held}`);
      }
    }
    assert.equal(seen.size, Object.keys(ledger.pages).length);
  });

  it("publishes no URL the ledger does not date", async () => {
    const ledger = readPageLastmod();
    const published = new Set<string>();
    const undated: string[] = [];
    for (const name of SITEMAPS) {
      for (const { loc } of await sitemapEntries(name)) {
        published.add(loc);
        if (!ledger.pages[loc]) undated.push(loc);
      }
    }
    assert.ok(published.size > 0, "the sitemaps published nothing, so this test read no crawl space");
    assert.deepEqual(undated, [], `${undated.length} published URLs are dated from something other than their own rendered body`);
    assert.equal(published.size, Object.keys(ledger.pages).length, "the ledger and the sitemaps do not cover the same URLs");
  });

  it("dates a page it has no record of no earlier than the day the ledger was written", async () => {
    const ledger = readPageLastmod();
    const today = new Date().toISOString().slice(0, 10);
    const known = new Set(inventory);
    assertPopulationFloor(known.size, 1500, "URLs the ledger is asked to date");
    const entries = new Map<string, string>();
    for (const name of SITEMAPS) {
      for (const { loc, lastmod } of await sitemapEntries(name)) entries.set(loc, lastmod);
    }
    for (const page of inventory) {
      const lastmod = entries.get(page);
      assert.ok(lastmod, `${page} is missing from the sitemaps`);
      const recorded = ledger.pages[page];
      if (recorded) assert.equal(lastmod, entryDay(recorded, today));
      else assert.ok(lastmod! >= ledger.generated, `${page} has no record and advertises ${lastmod}, older than the ledger itself`);
    }
  });

  it("reads every URL it publishes, so nothing is published that no run will ever date", async () => {
    const published = new Set<string>();
    for (const name of SITEMAPS) {
      for (const { loc } of await sitemapEntries(name)) published.add(loc);
    }
    const read = new Set(inventory);
    const unread = [...published].filter(loc => !read.has(loc));
    assert.deepEqual(unread, [], `${unread.length} published URLs are outside the inventory the ledger is generated from`);
    assert.equal(read.size, published.size, "the inventory and the sitemaps do not cover the same URLs");
  });

  it("serves the day it advertises, on every URL in every sitemap", async () => {
    const entries: Array<{ loc: string; lastmod: string }> = [];
    for (const name of SITEMAPS) entries.push(...await sitemapEntries(name));
    assert.ok(entries.length > 0, "the sitemaps published nothing, so this test read no crawl space");
    const disagreeing: string[] = [];
    const queue = [...entries];
    const workers = Array.from({ length: 8 }, async () => {
      for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        const response = await fetch(base + next.loc);
        await response.text();
        const served = response.headers.get("last-modified");
        if (served !== httpDate(next.lastmod)) disagreeing.push(`${next.loc} advertises ${next.lastmod} and serves ${served}`);
      }
    });
    await Promise.all(workers);
    assert.deepEqual(disagreeing.slice(0, 10), [], `${disagreeing.length} of ${entries.length} URLs serve a day their own sitemap entry does not give`);
  });

  it("dates no page from before the generation that first read it", () => {
    const ledger = readPageLastmod();
    const early = Object.entries(ledger.pages)
      .filter(([, entry]) => !isDailyEntry(entry) && entry.changed > ledger.generated);
    assert.deepEqual(early.map(([page]) => page), [], "a page is dated after the run that read it, which no run could have observed");
  });

  it("holds no page that no sitemap publishes", async () => {
    const ledger = readPageLastmod();
    const published = new Set<string>();
    for (const name of SITEMAPS) {
      for (const { loc } of await sitemapEntries(name)) published.add(loc);
    }
    const orphans = Object.keys(ledger.pages).filter(p => !published.has(p));
    assert.deepEqual(orphans, [], `The ledger dates pages nothing publishes; run npm run lastmod:pages`);
  });

  it("names no day as a literal in the code that renders a sitemap", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    const sitemapBlocks = source.split("\n").filter(line => line.includes("<lastmod>"));
    assert.ok(sitemapBlocks.length > 20, "Expected to find the sitemap-rendering lines");
    for (const line of sitemapBlocks) {
      assert.doesNotMatch(line, /["']\d{4}-\d{2}-\d{2}["']/, `A sitemap lastmod is a date literal: ${line.trim()}`);
    }
    for (const [, name] of source.matchAll(/const (\w*[Dd]ate)\s*=\s*"\d{4}-\d{2}-\d{2}"/g)) {
      assert.ok(!/lastmod/i.test(name), `${name} is a date literal feeding a sitemap`);
    }
  });

  it("dates the pages whose output changed on the day it changed", async () => {
    const entries = new Map<string, string>();
    for (const name of SITEMAPS) {
      for (const { loc, lastmod } of await sitemapEntries(name)) entries.set(loc, lastmod);
    }
    for (const page of [...RETITLED, REPRICED]) {
      const lastmod = entries.get(page);
      assert.ok(lastmod, `${page} is missing from the sitemaps`);
      assert.ok(
        lastmod! >= THE_DAY_THOSE_PAGES_CHANGED,
        `${page} advertises ${lastmod}, older than ${THE_DAY_THOSE_PAGES_CHANGED} when its rendered output last changed`,
      );
    }
  });

  it("publishes a well-formed day, never one in the future, on every URL in every sitemap", async () => {
    const today = new Date().toISOString().slice(0, 10);
    let counted = 0;
    for (const name of SITEMAPS) {
      for (const { loc, lastmod } of await sitemapEntries(name)) {
        assert.match(lastmod, /^\d{4}-\d{2}-\d{2}$/, `${loc} advertises ${lastmod}`);
        assert.ok(lastmod <= today, `${loc} advertises ${lastmod}, which is in the future`);
        counted++;
      }
    }
    assertPopulationFloor(counted, 1000, "URLs in the crawl space");
  });

  it("serves Last-Modified on a page it can date, and none on a page it cannot", async () => {
    const comparisons = new Map((await sitemapEntries("comparisons")).map(e => [e.loc, e.lastmod]));
    const pages = new Map((await sitemapEntries("pages")).map(e => [e.loc, e.lastmod]));
    for (const page of [...RETITLED, REPRICED]) {
      const lastmod = comparisons.get(page) ?? pages.get(page);
      const response = await fetch(base + page);
      await response.text();
      assert.equal(response.headers.get("last-modified"), httpDate(lastmod!), `${page} header disagrees with its sitemap entry`);
    }
    const vendors = new Map((await sitemapEntries("vendors")).map(e => [e.loc, e.lastmod]));
    const supabase = vendors.get("/vendor/supabase");
    assert.ok(supabase, "/vendor/supabase is missing from the vendors sitemap");
    const vendor = await fetch(`${base}/vendor/supabase`);
    await vendor.text();
    assert.equal(vendor.headers.get("last-modified"), httpDate(supabase!), "a vendor page's header disagrees with its sitemap entry");
  });

  it("serves the sitemap's own day on the vendor and category pages, read from end to end of both lists", async () => {
    const sampled: Array<{ loc: string; lastmod: string }> = [];
    for (const [sitemap, prefix] of [["vendors", "/vendor/"], ["pages", "/category/"]] as const) {
      const listed = (await sitemapEntries(sitemap)).filter(e => e.loc.startsWith(prefix));
      assert.ok(listed.length > 0, `${prefix} publishes nothing, so this test checks nothing`);
      const stride = Math.max(1, Math.ceil(listed.length / 12));
      for (let at = 0; at < listed.length; at += stride) sampled.push(listed[at]!);
      sampled.push(listed[listed.length - 1]!);
    }
    assert.ok(sampled.length >= 8, `read ${sampled.length} pages, too few to cover two lists`);
    const days = new Set<string>();
    for (const { loc, lastmod } of sampled) {
      const response = await fetch(base + loc);
      await response.text();
      assert.equal(response.status, 200, `${loc} answered ${response.status}`);
      assert.equal(response.headers.get("last-modified"), httpDate(lastmod), `${loc} header disagrees with its sitemap entry`);
      days.add(lastmod);
    }
    assert.ok(days.size > 0, "no page was read, so nothing was compared");
    const undated = await fetch(`${base}${sampled[0]!.loc}?ref=x`);
    await undated.text();
    assert.equal(undated.headers.get("last-modified"), null, "a day is served on a URL the ledger does not date, so the header is not read off the URL at all");
  });

  it("dates the homepage and tells a cache how long to hold it", async () => {
    const listed = new Map((await sitemapEntries("pages")).map(e => [e.loc, e.lastmod]));
    const advertised = listed.get("/");
    assert.ok(advertised, "/ is missing from the pages sitemap");
    const response = await fetch(base + "/");
    await response.text();
    assert.equal(response.headers.get("last-modified"), httpDate(advertised!), "the homepage header disagrees with its sitemap entry");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=\d+/, "the homepage tells no cache how long to hold it");
  });

  it("answers a revalidation on every page whose day was read from its own rendered body", async () => {
    const ledger = readPageLastmod();
    const today = new Date().toISOString().slice(0, 10);
    const read = ["/", ...RETITLED, REPRICED].filter(page => ledger.pages[page]);
    assert.ok(read.length >= 4, `only ${read.length} of the pages named here are in the ledger`);
    for (const page of read) {
      const first = await fetch(base + page);
      await first.text();
      const advertised = first.headers.get("last-modified");
      assert.equal(advertised, httpDate(entryDay(ledger.pages[page], today)!), `${page} advertises a day the ledger does not hold`);
      const revalidated = await fetch(base + page, { headers: { "If-Modified-Since": advertised! } });
      const body = await revalidated.text();
      assert.equal(revalidated.status, 304, `${page} re-sent its body to a client already holding ${advertised}`);
      assert.equal(body, "", `${page} answered 304 with a body`);
      const older = await fetch(base + page, { headers: { "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" } });
      const full = await older.text();
      assert.equal(older.status, 200, `${page} withheld its body from a client holding a copy from 2024`);
      assert.ok(full.includes("</html>"), `${page} answered 200 without a page`);
    }
  });

  it("revalidates a vendor and a category page against the day it advertises, which no record could date", async () => {
    const categories = (await sitemapEntries("pages")).filter(e => e.loc.startsWith("/category/"));
    assert.ok(categories.length > 0, "no category page is published, so this test checks nothing");
    for (const page of ["/vendor/supabase", categories[0]!.loc]) {
      const first = await fetch(base + page);
      const served = await first.text();
      const advertised = first.headers.get("last-modified");
      assert.ok(advertised, `${page} carries no day at all`);
      const revalidated = await fetch(base + page, { headers: { "If-Modified-Since": advertised! } });
      const empty = await revalidated.text();
      assert.equal(revalidated.status, 304, `${page} re-sent all ${served.length} bytes to a client already holding ${advertised}`);
      assert.equal(empty, "", `${page} answered 304 with a body`);
      const older = await fetch(base + page, { headers: { "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" } });
      const full = await older.text();
      assert.equal(older.status, 200, `${page} withheld its body from a client holding a copy from 2024`);
      assert.ok(full.includes("</html>"), `${page} answered 200 without a page`);
    }
  });

  it("dates a vendor page from the ledger rather than from the record it renders", async () => {
    const ledger = readPageLastmod();
    const today = new Date().toISOString().slice(0, 10);
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers as Array<{ vendor: string; verifiedDate?: string }>;
    const listed = (await sitemapEntries("vendors")).filter(e => e.loc.startsWith("/vendor/"));
    const stride = Math.max(1, Math.ceil(listed.length / 24));
    const sampled = listed.filter((_, at) => at % stride === 0);
    assert.ok(sampled.length >= 8, `read ${sampled.length} vendor pages, too few to say anything`);
    let awayFromTheRecord = 0;
    for (const { loc, lastmod } of sampled) {
      const held = entryDay(ledger.pages[loc], today);
      assert.equal(lastmod, held, `${loc} advertises ${lastmod} where the ledger holds ${held}`);
      const served = await fetch(base + loc);
      await served.text();
      assert.equal(served.headers.get("last-modified"), httpDate(held!), `${loc} serves a day its own sitemap entry does not give`);
      const slug = loc.slice("/vendor/".length);
      const confirmed = offers.filter(o => toSlug(o.vendor) === slug).map(o => o.verifiedDate ?? "").sort().at(-1);
      if (confirmed && confirmed !== held) awayFromTheRecord++;
    }
    assert.ok(
      awayFromTheRecord > 0,
      `all ${sampled.length} vendor pages advertise the day their record was last confirmed, which is what dating them from their own body was meant to stop`,
    );
  });
});



const WORKFLOWS = path.join(REPO, ".github", "workflows");

interface Workflow {
  file: string;
  text: string;
}

function workflows(): Workflow[] {
  return readdirSync(WORKFLOWS)
    .filter(f => /\.ya?ml$/.test(f))
    .sort()
    .map(file => ({ file, text: readFileSync(path.join(WORKFLOWS, file), "utf8") }));
}

function readsEveryPageToDateIt(workflow: Workflow): boolean {
  return /update-page-lastmod\.js/.test(workflow.text)
    || /npm run lastmod:pages/.test(workflow.text)
    || /GATE_UPDATE_PAGE_LASTMOD:\s*"?1"?/.test(workflow.text);
}

function runsOnAPushToMain(workflow: Workflow): boolean {
  const triggers = workflow.text.split(/^jobs:/m)[0]!;
  return /\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main\s*$/m.test(triggers);
}

describe("the ledger keeps up with the code that renders the pages", () => {
  it("reads the workflows, so the assertions below have subjects", () => {
    assert.ok(workflows().length >= 6, `this test needs the workflows to check, found ${workflows().length}`);
    assert.ok(
      workflows().some(readsEveryPageToDateIt),
      "nothing re-reads the pages, so no page's day can move at all",
    );
  });

  it("re-dates a page on the push that moved it, not only when a scheduled run pushes data", () => {
    const readers = workflows().filter(readsEveryPageToDateIt);
    const onAPush = readers.filter(runsOnAPushToMain);
    assert.ok(
      onAPush.length >= 1,
      `every workflow that re-dates a page waits for a scheduled run (${readers.map(w => w.file).join(", ")}), so a commit that moves a page's rendered body cannot move that page's day`,
    );
  });

  it("re-dates without waiting on the re-verification that pushes the catalogue", () => {
    for (const workflow of workflows().filter(w => readsEveryPageToDateIt(w) && runsOnAPushToMain(w))) {
      assert.doesNotMatch(
        workflow.text,
        /reverify-rolling\.js/,
        `${workflow.file} re-dates the pages only when the re-verification it also runs succeeds`,
      );
    }
  });

  it("reads the pages in a fixed zone, so the same commit gives the same ledger anywhere", () => {
    const updater = readFileSync(path.join(REPO, "scripts", "update-page-lastmod.js"), "utf8");
    assert.match(
      updater,
      /TZ: [A-Z_]+,/,
      "the updater reads the pages in whatever zone the machine is set to, so a ledger generated west of Greenwich disagrees with one generated in CI",
    );
    assert.match(updater, /LEDGER_TIMEZONE = "UTC"/, "the zone the ledger is read in is not UTC");

    const west = spawnSync("node", ["-e", "process.stdout.write(new Date('2026-09-24T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))"], {
      encoding: "utf8",
      env: { ...process.env, TZ: "America/Los_Angeles" },
    });
    const utc = spawnSync("node", ["-e", "process.stdout.write(new Date('2026-09-24T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))"], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    });
    assert.notEqual(
      west.stdout,
      utc.stdout,
      "this test is pointless if the runtime no longer renders a UTC midnight differently west of Greenwich",
    );
  });

  it("sends the days it read to main through the one gate that runs the suite first", () => {
    for (const workflow of workflows().filter(w => readsEveryPageToDateIt(w) && runsOnAPushToMain(w))) {
      assert.match(
        workflow.text,
        /bash scripts\/gate-data-push\.sh/,
        `${workflow.file} reaches main without the gate, so its commit reaches main untested`,
      );
      assert.match(
        workflow.text,
        /data\/page-lastmod\.json/,
        `${workflow.file} does not name the ledger among the paths it may commit, so the days it reads stay in its own workspace`,
      );
    }
  });
});

describe("a page whose rendered body moves is dated the day it moved", () => {
  let bodyServer: ChildProcess;
  let bodyBase = "";
  let bodyDir = "";
  let read: string[] = [];

  const BEFORE = "2026-01-02";
  const AFTER = "2026-01-03";

  before(async () => {
    bodyDir = mkdtempSync(path.join(tmpdir(), "page-lastmod-body-"));
    bodyServer = await startServer(path.join(bodyDir, "inventory.json"));
    bodyBase = base;
    read = JSON.parse(readFileSync(path.join(bodyDir, "inventory.json"), "utf-8"));
  });

  after(() => {
    if (bodyServer) bodyServer.kill();
    if (bodyDir) rmSync(bodyDir, { recursive: true, force: true });
  });

  async function renderedHashes(paths: string[]): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const page of paths) {
      const response = await fetch(bodyBase + page, { redirect: "error" });
      const body = await response.text();
      assert.equal(response.status, 200, `${page} answered ${response.status}`);
      hashes.set(page, hashPageBody(body, bodyBase));
    }
    return hashes;
  }

  function ledgerOf(hashes: Map<string, string>): PageLastmodLedger {
    return {
      version: 1,
      generated: BEFORE,
      pages: Object.fromEntries([...hashes].map(([page, hash]) => [page, { hash, changed: BEFORE }])),
    };
  }

  it("moves the day of the page the test rewrote, and holds the day of every page it left alone", async () => {
    const sample = read.slice(0, 6);
    assert.equal(sample.length, 6, "this test needs six pages of the ledger's own inventory to read");
    const asServed = await renderedHashes(sample);
    const [rewritten, ...untouched] = sample as [string, ...string[]];

    const body = await (await fetch(bodyBase + rewritten, { redirect: "error" })).text();
    const asRewritten = new Map(asServed);
    asRewritten.set(rewritten, hashPageBody(`${body}<p>a sentence this page did not carry</p>`, bodyBase));

    const { ledger, moved, added, dropped } = updatePageLastmod(ledgerOf(asServed), asRewritten, AFTER);
    assert.deepEqual(moved, [rewritten]);
    assert.deepEqual([added, dropped], [[], []]);
    assert.equal(entryDay(ledger.pages[rewritten], AFTER), AFTER, `${rewritten} was rewritten and kept its old day`);
    for (const page of untouched) {
      assert.equal(entryDay(ledger.pages[page], AFTER), BEFORE, `${page} took a new day and its body did not move`);
    }
  });

  it("holds every day when the pages serve exactly what the ledger already recorded", async () => {
    const sample = read.slice(0, 6);
    const asServed = await renderedHashes(sample);
    const { ledger, moved, added, dropped } = updatePageLastmod(ledgerOf(asServed), asServed, AFTER);
    assert.deepEqual([moved, added, dropped], [[], [], []]);
    for (const page of sample) assert.equal(entryDay(ledger.pages[page], AFTER), BEFORE);
  });
});

describe("the ledger keeps up with the data the pages render", () => {
  it("was regenerated no more than a week before the newest record we publish", () => {
    const ledger = readPageLastmod();
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers as Array<{ verifiedDate?: string }>;
    let newest = "";
    for (const offer of offers) {
      if (offer.verifiedDate && offer.verifiedDate > newest) newest = offer.verifiedDate;
    }
    const behind = daysBetween(ledger.generated, newest);
    assert.ok(
      behind <= 7,
      `The newest record we publish is dated ${newest} and the ledger was last regenerated on ${ledger.generated}, ${behind} days earlier — every page it covers is advertising a day that stopped moving`,
    );
  });
});

describe("a page whose body is a function of the UTC day is dated from the day it is served", () => {
  const A_DAY = "2026-04-01";
  const THE_NEXT_DAY = "2026-04-02";

  it("reads an entry that stores no hash", () => {
    const ledger = parsePageLastmod(
      JSON.stringify({ version: 1, generated: A_DAY, pages: { "/best": { daily: true } } }),
      "a ledger",
    );
    assert.ok(isDailyEntry(ledger.pages["/best"]!));
  });

  it("refuses an entry that claims both a stored hash and the day it is served", () => {
    assert.throws(
      () => parsePageLastmod(
        JSON.stringify({ version: 1, generated: A_DAY, pages: { "/best": { daily: true, hash: "abc", changed: A_DAY } } }),
        "a ledger",
      ),
      /both a daily flag and a stored hash/,
    );
  });

  it("refuses a daily flag that is not true", () => {
    assert.throws(
      () => parsePageLastmod(
        JSON.stringify({ version: 1, generated: A_DAY, pages: { "/best": { daily: false } } }),
        "a ledger",
      ),
      /expected true or no flag at all/,
    );
  });

  it("answers with the day it is asked about, not the day it was written", () => {
    assert.equal(entryDay({ daily: true }, THE_NEXT_DAY), THE_NEXT_DAY);
    assert.equal(entryDay({ hash: "abc", changed: A_DAY }, THE_NEXT_DAY), A_DAY);
    assert.equal(entryDay(undefined, THE_NEXT_DAY), null);
  });

  it("serves that day through lastmodFor and newestLastmod, over any stored day", () => {
    const ledger = parsePageLastmod(
      JSON.stringify({ version: 1, generated: A_DAY, pages: { "/best": { daily: true }, "/press": { hash: "abc", changed: A_DAY } } }),
      "a ledger",
    );
    assert.equal(lastmodFor(ledger, "/best", A_DAY, THE_NEXT_DAY), THE_NEXT_DAY);
    assert.equal(lastmodFor(ledger, "/press", A_DAY, THE_NEXT_DAY), A_DAY);
    assert.equal(newestLastmod(ledger, ["/press", "/best"], A_DAY, THE_NEXT_DAY), THE_NEXT_DAY);
  });

  it("stays still across runs, where a stored hash would move every day", () => {
    const first = updatePageLastmod(emptyPageLastmod(A_DAY), new Map([["/best", "monday"]]), A_DAY, ["/best"]);
    assert.deepEqual(first.added, ["/best"]);
    assert.deepEqual(first.daily, ["/best"]);

    const second = updatePageLastmod(first.ledger, new Map([["/best", "tuesday"]]), THE_NEXT_DAY, ["/best"]);
    assert.deepEqual(second.moved, [], "a page dated from the day it is served moved because its rotating body rotated");
    assert.deepEqual(second.ledger.pages["/best"], { daily: true });
  });

  it("moves a page that stops rotating back onto its own stored hash", () => {
    const rotating = updatePageLastmod(emptyPageLastmod(A_DAY), new Map([["/best", "monday"]]), A_DAY, ["/best"]);
    const settled = updatePageLastmod(rotating.ledger, new Map([["/best", "monday"]]), THE_NEXT_DAY, []);
    assert.deepEqual(settled.moved, ["/best"]);
    assert.deepEqual(settled.ledger.pages["/best"], { hash: "monday", changed: THE_NEXT_DAY });
  });

  it("refuses to record a page as rotating when the run never read it", () => {
    assert.throws(
      () => updatePageLastmod(emptyPageLastmod(A_DAY), new Map([["/press", "monday"]]), A_DAY, ["/best"]),
      /was not read this run/,
    );
  });
});
