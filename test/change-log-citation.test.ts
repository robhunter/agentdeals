import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { changeCitesASource, citationLabel } = await import("../dist/change-citation.js");
const { isNoLongerInForce } = await import("../dist/change-resolution.js");

type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const CITATION_CLASS = "change-source";
const UNSOURCED_NOTE_CLASS = "unsourced-note";
const UNSOURCED_TAG_CLASS = "unsourced-tag";
const CHANGE_LOG_ROUTES = ["/pricing-changes", "/changes"];
const ENTRY_CLASS: Record<string, string> = {
  "/pricing-changes": "pc-entry",
  "/changes": "chg-entry",
  "/q1-2026-developer-pricing-report": "change-card",
  "/q2-pricing-preview-2026": "change-card",
};

const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

function sourceOf(change: { source_url?: string | null }): string | null {
  return changeCitesASource(change) ? change.source_url!.trim() : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function citationTags(html: string): string[] {
  return [...html.matchAll(/<a [^>]*class="change-source"[^>]*>/g)].map((m) => m[0]);
}

function citedUrls(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)"[^>]*class="change-source"[^>]*>/g)].map((m) =>
    decodeEntities(m[1]),
  );
}

function entriesOn(html: string, route: string): string[] {
  return html.split(new RegExp(`<div class="${ENTRY_CLASS[route]}[^"]*"`)).slice(1);
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

describe("every change we publish reaches the page it was read from", () => {
  let proc: ChildProcess;
  let port = 0;
  const pages = new Map<string, string>();
  let sweptPaths: string[] = [];

  async function page(pathname: string): Promise<string> {
    const cached = pages.get(pathname);
    if (cached !== undefined) return cached;
    const body = await (await fetch(`http://localhost:${port}${pathname}`)).text();
    pages.set(pathname, body);
    return body;
  }

  before(async () => {
    const started = await startServer({ BASE_URL: "http://localhost" });
    proc = started.proc;
    port = started.port;
    const paths = new Set<string>(["/", ...CHANGE_LOG_ROUTES]);
    const indexes = new Set<string>(["/sitemap.xml"]);
    for (const entry of (await page("/sitemap.xml")).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      indexes.add(new URL(entry[1]).pathname);
    }
    for (const sitemap of indexes) {
      for (const entry of (await page(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const pathname = new URL(entry[1]).pathname;
        if (!indexes.has(pathname)) paths.add(pathname);
      }
    }
    sweptPaths = [...paths].sort();
    let next = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        while (next < sweptPaths.length) await page(sweptPaths[next++]);
      }),
    );
  });

  after(() => proc?.kill());

  it("has a population on both sides of the question", () => {
    const inForceWithSource = changes.filter((c) => !isNoLongerInForce(c) && changeCitesASource(c));
    assert.ok(
      inForceWithSource.length > 100,
      `only ${inForceWithSource.length} in-force records hold a source, so the citation sweep has almost no subject`,
    );
    assert.ok(
      changes.some((c) => !changeCitesASource(c)),
      "no record is missing a source, so nothing here exercises the entry that says we hold none",
    );
    assert.ok(sweptPaths.length > 1000, `swept only ${sweptPaths.length} paths`);
  });

  it("cites the page behind every in-force record on some page we serve", () => {
    const cited = new Set<string>();
    for (const p of sweptPaths) {
      for (const url of citedUrls(pages.get(p) ?? "")) cited.add(url);
    }
    const uncited = changes
      .filter((c) => !isNoLongerInForce(c) && changeCitesASource(c))
      .filter((c) => !cited.has(sourceOf(c)!))
      .map((c) => `${c.vendor} ${c.date} -> ${sourceOf(c)}`);
    assert.deepStrictEqual(uncited, []);
  });

  it("does not depend on the vendor page to do it, so a retirement cannot take the citation away", () => {
    const cited = new Set<string>();
    for (const route of CHANGE_LOG_ROUTES) {
      for (const url of citedUrls(pages.get(route)!)) cited.add(url);
    }
    const missing = changes
      .filter(changeCitesASource)
      .filter((c) => !cited.has(sourceOf(c)!))
      .map((c) => `${c.vendor} ${c.date} -> ${sourceOf(c)}`);
    assert.deepStrictEqual(missing, []);
  });

  for (const route of [...CHANGE_LOG_ROUTES, "/q1-2026-developer-pricing-report", "/q2-pricing-preview-2026"]) {
    it(`gives every entry on ${route} either its source or the reason we have none`, () => {
      const entries = entriesOn(pages.get(route)!, route);
      assert.ok(entries.length > 0, `${route} rendered no change entry at all`);
      const silent = entries.filter(
        (e) => !e.includes(`class="${CITATION_CLASS}"`) && !e.includes(`class="${UNSOURCED_NOTE_CLASS}"`),
      );
      const both = entries.filter(
        (e) => e.includes(`class="${CITATION_CLASS}"`) && e.includes(`class="${UNSOURCED_NOTE_CLASS}"`),
      );
      assert.strictEqual(silent.length, 0, `${route} renders ${silent.length} of ${entries.length} entries with neither`);
      assert.strictEqual(both.length, 0, `${route} renders ${both.length} entries claiming both`);
    });

    it(`counts the citations on ${route} off the entries rather than a fixed number`, () => {
      const html = pages.get(route)!;
      const entries = entriesOn(html, route);
      const cited = entries.filter((e) => e.includes(`class="${CITATION_CLASS}"`)).length;
      assert.strictEqual(citationTags(html).length, cited, `${route} carries citation links outside its entries`);
      assert.ok(cited > 0, `${route} cites nothing`);
    });
  }

  it("gives every change a vendor page renders either its source or the reason we have none", () => {
    const ENTRY_END = "\n      </div>";
    const offenders: string[] = [];
    let checked = 0;
    for (const p of sweptPaths.filter((s) => s.startsWith("/vendor/"))) {
      for (const chunk of (pages.get(p) ?? "").split(/<div class="change-item[^"]*"/).slice(1)) {
        const end = chunk.indexOf(ENTRY_END);
        assert.notStrictEqual(end, -1, `a change entry on ${p} does not close where this test looks for its end`);
        const block = chunk.slice(0, end);
        checked++;
        if (!block.includes(`class="${CITATION_CLASS}"`) && !block.includes(`class="${UNSOURCED_NOTE_CLASS}"`)) {
          offenders.push(p);
        }
      }
    }
    assert.ok(checked > 100, `only ${checked} change entries render on a vendor page`);
    assert.deepStrictEqual([...new Set(offenders)].slice(0, 5), []);
  });

  it("reaches the source from the page of an offer that has ended, where the offer's own link is gone", () => {
    const offers: Array<{ vendor: string; url: string; tier: string }> = JSON.parse(
      readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
    ).offers;
    const sources = new Set(changes.filter(changeCitesASource).map((c) => sourceOf(c)!));
    const ended = offers.filter((o) => o.tier.toLowerCase() === "retired" && sources.has(o.url));
    if (ended.length === 0) return;
    for (const offer of ended) {
      const slug = offer.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const html = pages.get(`/vendor/${slug}`) ?? "";
      assert.ok(html.length > 0, `/vendor/${slug} was not served`);
      assert.ok(
        citedUrls(html).includes(offer.url),
        `/vendor/${slug} no longer reaches ${offer.url}, which is the source of a change we publish about it`,
      );
    }
  });

  it("sends no reader to a citation with no destination", () => {
    const offenders: string[] = [];
    for (const p of sweptPaths) {
      const empty = citationTags(pages.get(p) ?? "").filter((tag) => tag.includes('href=""'));
      if (empty.length > 0) offenders.push(`${p} x${empty.length}`);
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("names the page in the citation's title so the reader sees where it goes", () => {
    for (const route of Object.keys(ENTRY_CLASS)) {
      const tags = citationTags(pages.get(route)!);
      assert.ok(tags.length > 50, `${route} carries only ${tags.length} citations`);
      const wrong = tags.filter((tag) => {
        const href = decodeEntities(tag.match(/href="([^"]*)"/)![1]);
        const title = decodeEntities(tag.match(/title="([^"]*)"/)?.[1] ?? "");
        return title !== citationLabel(href);
      });
      assert.deepStrictEqual(wrong.slice(0, 3), [], `${route} carries ${wrong.length} citations whose title is not the page`);
    }
  });

  it("shortens the page to a label rather than repeating the URL", () => {
    const labelled = citationTags(pages.get("/pricing-changes")!).map((tag) => ({
      href: decodeEntities(tag.match(/href="([^"]*)"/)![1]),
      title: decodeEntities(tag.match(/title="([^"]*)"/)?.[1] ?? ""),
    }));
    assert.ok(labelled.every((c) => !c.title.startsWith("http")), "a citation title is a bare URL");
    const wwwStripped = labelled.filter((c) => c.href.includes("://www.") && !c.title.startsWith("www."));
    assert.ok(wwwStripped.length > 0, "no cited page is on a www host, so nothing here exercises the label");
  });

  it("carries the source of each entry in the machine-readable list on /changes", () => {
    const html = pages.get("/changes")!;
    const lists = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .filter((b) => b["@type"] === "ItemList");
    assert.strictEqual(lists.length, 1, "/changes publishes no single ItemList");
    const items = lists[0].itemListElement.map((el: { item: Record<string, any> }) => el.item);
    assert.ok(items.length > 0, "/changes publishes an empty ItemList");
    const byHeadline = new Map<string, Record<string, any>>(items.map((i: Record<string, any>) => [i.headline, i]));
    let checked = 0;
    for (const item of items) {
      const vendor = String(item.headline).split(":")[0];
      const record = changes.find((c) => c.vendor === vendor && c.summary === item.description);
      if (!record) continue;
      checked++;
      const source = sourceOf(record);
      if (source === null) {
        assert.ok(!("citation" in item), `${item.headline} publishes a citation for a record holding no source`);
        continue;
      }
      assert.strictEqual(item.citation?.url, source, `${item.headline} publishes no citation for ${source}`);
      assert.strictEqual(item.citation?.["@type"], "WebPage");
      assert.strictEqual(item.citation?.name, citationLabel(source));
    }
    assert.ok(checked > items.length / 2, `matched only ${checked} of ${items.length} list items back to a record`);
    assert.strictEqual(byHeadline.size > 0, true);
  });
});

describe("a record with no source says so where a record with one is cited", () => {
  const CITED = "Neon";
  const UNCITED = "Xata";
  const BLANK = "Fauna";
  const SOURCE = "https://neon.example/pricing?plan=free";
  let proc: ChildProcess;
  let tmp: string;
  const bodies = new Map<string, string>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "change-log-citation-"));
    const changesPath = path.join(tmp, "changes.json");
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const base = {
      change_type: "limits_reduced",
      date_source: "vendor_page",
      previous_state: "15 GB storage",
      current_state: "5 GB storage",
      impact: "high",
      category: "Databases",
      alternatives: [],
    };
    writeFileSync(
      changesPath,
      JSON.stringify({
        changes: [
          { ...base, vendor: CITED, date: day(-5), recorded_date: day(-5), summary: `${CITED} cut its free storage.`, source_url: SOURCE },
          { ...base, vendor: UNCITED, date: day(-6), recorded_date: day(-6), summary: `${UNCITED} cut its free storage.` },
          { ...base, vendor: BLANK, date: day(-7), recorded_date: day(-7), summary: `${BLANK} cut its free storage.`, source_url: "   " },
        ],
      }),
    );
    const started = await startServer({ BASE_URL: "http://localhost", AGENTDEALS_CHANGES_PATH: changesPath });
    proc = started.proc;
    for (const route of CHANGE_LOG_ROUTES) {
      bodies.set(route, await (await fetch(`http://localhost:${started.port}${route}`)).text());
    }
  });

  after(() => {
    proc?.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  for (const route of CHANGE_LOG_ROUTES) {
    it(`links the source of the sourced record on ${route}`, () => {
      const html = bodies.get(route)!;
      assert.deepStrictEqual(citedUrls(html), [SOURCE]);
      const tag = citationTags(html)[0];
      assert.ok(tag.includes('target="_blank"') && tag.includes('rel="noopener"'), tag);
      assert.ok(tag.includes(`title="${citationLabel(SOURCE)}"`), tag);
    });

    for (const vendor of [UNCITED, BLANK]) {
      it(`says in words that it holds no source for ${vendor} on ${route}`, () => {
        const entries = entriesOn(bodies.get(route)!, route);
        assert.strictEqual(entries.length, 3, `${route} rendered ${entries.length} entries for three records`);
        const subject = entries.filter((e) => e.includes(vendor));
        assert.strictEqual(subject.length, 1);
        assert.ok(subject[0].includes(`class="${UNSOURCED_NOTE_CLASS}"`), `${route} says nothing about the missing source`);
        assert.ok(subject[0].includes(vendor), `${route} does not name the vendor in the note`);
        assert.ok(subject[0].includes(`class="${UNSOURCED_TAG_CLASS}"`), `${route} does not mark the entry as unsourced`);
        assert.ok(!subject[0].includes(`class="${CITATION_CLASS}"`), `${route} cites something for a record with no source`);
      });
    }

    it(`marks only the entries with no source on ${route}`, () => {
      const entries = entriesOn(bodies.get(route)!, route);
      const tagged = entries.filter((e) => e.includes(`class="${UNSOURCED_TAG_CLASS}"`)).length;
      const cited = entries.filter((e) => e.includes(`class="${CITATION_CLASS}"`)).length;
      assert.strictEqual(tagged, 2, `${route} tags ${tagged} of 3 entries`);
      assert.strictEqual(cited, 1, `${route} cites ${cited} of 3 entries`);
    });
  }

  it("leaves the citation out of the machine-readable entry that has no source", () => {
    const list = [...bodies.get("/changes")!.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .find((b) => b["@type"] === "ItemList");
    const items = list.itemListElement.map((el: { item: Record<string, any> }) => el.item);
    const cited = items.find((i: Record<string, any>) => String(i.headline).startsWith(CITED));
    assert.strictEqual(cited.citation.url, SOURCE);
    assert.strictEqual(cited.citation.name, citationLabel(SOURCE));
    for (const vendor of [UNCITED, BLANK]) {
      const item = items.find((i: Record<string, any>) => String(i.headline).startsWith(vendor));
      assert.ok(item, `${vendor} is absent from the list`);
      assert.ok(!("citation" in item), `${vendor} publishes ${JSON.stringify(item.citation)}`);
    }
  });
});
