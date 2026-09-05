import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daysBetween, emptyPageLastmod, hashPageBody, httpDate, lastmodFor, newestLastmod, parsePageLastmod,
  readPageLastmod, serializePageLastmod, updatePageLastmod, type PageLastmodLedger,
} from "../dist/page-lastmod.js";

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
    assert.equal(ledger.pages["/guides/a"].changed, "2026-05-02");
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
    assert.equal(ledger.pages["/guides/b"].changed, "2026-09-05");
    assert.equal(ledger.pages["/guides/a"].changed, "2026-05-02");
    assert.deepEqual(moved, ["/guides/b"]);
  });

  it("stamps a page it has never read with the day it first read it, and forgets a page that is gone", () => {
    const previous = emptyPageLastmod("2026-08-01");
    previous.pages["/gone"] = { hash: "zzzz", changed: "2026-06-01" };
    const { ledger, added, dropped } = updatePageLastmod(previous, new Map([["/new", "nnnn"]]), "2026-09-05");
    assert.equal(ledger.pages["/new"].changed, "2026-09-05");
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
    assert.equal(lastmodFor(ledger, "/unread", "2026-09-01"), "2026-09-01");
    assert.equal(newestLastmod(ledger, [], "2026-09-01"), "2026-09-01");
  });

  it("reports the newest day across a set of pages", () => {
    const ledger: PageLastmodLedger = {
      version: 1,
      generated: "2026-09-05",
      pages: { "/a": { hash: "a", changed: "2026-07-01" }, "/b": { hash: "b", changed: "2026-08-09" } },
    };
    assert.equal(newestLastmod(ledger, ["/a", "/b"], "2026-01-01"), "2026-08-09");
  });

  it("formats a day as an HTTP date and refuses anything else", () => {
    assert.equal(httpDate("2026-09-04"), "Fri, 04 Sep 2026 00:00:00 GMT");
    assert.equal(httpDate("2026-09-05"), "Sat, 05 Sep 2026 00:00:00 GMT");
    assert.equal(httpDate("yesterday"), null);
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
    const seen = new Set<string>();
    for (const name of SITEMAPS) {
      for (const { loc, lastmod } of await sitemapEntries(name)) {
        const recorded = ledger.pages[loc];
        if (!recorded) continue;
        seen.add(loc);
        assert.equal(lastmod, recorded.changed, `${loc} advertises ${lastmod} where the ledger holds ${recorded.changed}`);
      }
    }
    assert.equal(seen.size, Object.keys(ledger.pages).length);
  });

  it("covers every page whose date has no other derivation", async () => {
    const ledger = readPageLastmod();
    const uncovered = inventory.filter(p => !ledger.pages[p]);
    assert.deepEqual(uncovered, [], `${uncovered.length} pages would fall back to the build day`);
    assert.equal(inventory.length, Object.keys(ledger.pages).length);
    assert.ok(inventory.length > 400, `Expected the ledger to cover the comparison and editorial pages, got ${inventory.length}`);
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
    assert.ok(counted > 2000, `Expected the whole crawl space, got ${counted} URLs`);
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
    const vendor = await fetch(`${base}/vendor/supabase`);
    await vendor.text();
    assert.equal(vendor.headers.get("last-modified"), null, "A page with no per-page day should carry no Last-Modified");
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
