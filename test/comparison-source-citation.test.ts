import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  citedSourcesListHtml,
  freeTierSourceOf,
  methodologyBlockEnd,
  readClauseHtml,
  sourceAnchorId,
  withCitedSources,
  CHECK_FINDING_LEAD,
  NO_CATALOGUE_RECORD,
} = await import("../dist/source-citation.js");
const { tabulatedSubjectSlots, vendorFactRows, SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");
const { RECORD_SOURCE_CLASS, SOURCE_MARKER_MARKUP } = await import("../dist/change-citation.js");
const { ENDED_OFFER_CLAUSE, offerRetired } = await import("../dist/retirement.js");
const { namedVendorSlug, vendorSlugMap } = await import("../dist/vendor-slug.js");
const { staticHalfOf } = await import("../dist/compiled-figures.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
).offers;

const primaryFor = new Map<string, Offer>();
for (const offer of offers) if (!primaryFor.has(offer.vendor)) primaryFor.set(offer.vendor, offer);

const COMPILED_PAGES = [
  "/cloud-free-tier-comparison-2026",
  "/database-free-tier-comparison-2026",
  "/cicd-free-tier-comparison-2026",
  "/serverless-free-tier-comparison-2026",
  "/testing-free-tier-comparison-2026",
  "/analytics-free-tier-comparison-2026",
  "/api-development-free-tier-comparison-2026",
  "/security-free-tier-comparison-2026",
  "/hosting-free-tier-comparison-2026",
  "/auth-comparison-2026",
  "/email-comparison-2026",
  "/storage-comparison-2026",
  "/monitoring-comparison-2026",
  "/aws-free-tier-2026",
  "/gcp-free-tier-2026",
  "/azure-free-tier-2026",
  "/digitalocean-free-tier-2026",
  "/ai-coding-pricing-2026",
];

const PAGES_THAT_ALREADY_LINKED_OUT = [
  "/vercel-vs-netlify",
  "/railway-vs-render",
  "/neon-vs-supabase",
  "/supabase-vs-firebase",
  "/datadog-vs-new-relic",
  "/hetzner-pricing-2026",
  "/gemini-api-pricing-2026",
  "/google-developer-program-2026",
  "/openai-assistants-migration-2026",
  "/q2-pricing-preview-2026",
];

const VENDOR_PAGE = "/vendor/upstash";

const OURS = /localhost|agentdeals\.dev|fonts\.(?:googleapis|gstatic)\.com/;

function outboundHosts(html: string): string[] {
  const hrefs = html.match(/href="https?:\/\/[^"]+"/g) ?? [];
  return [...new Set(hrefs.map(h => h.slice(6, -1)).filter(url => !OURS.test(url)))];
}

const CITED_SOURCE_LINK =
  /<a href="(https?:\/\/[^"]+)" rel="nofollow noopener" class="record-source"[^>]*title="([^"]*)"/g;

function citedSourceLinks(html: string): Array<{ url: string; title: string }> {
  return [...html.matchAll(CITED_SOURCE_LINK)].map(m => ({ url: m[1]!, title: m[2]! }));
}

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${m[1]}` });
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("what a record says about its source, without loading the catalogue", () => {
  it("cites the page it read, the date it read it and what it found there", () => {
    const source = freeTierSourceOf({
      url: "https://example.com/pricing",
      tier: "Free",
      verifiedDate: "2026-08-01",
      source_check: { checked: "2026-09-05", outcome: "ok", detail: 'the page names Example and states "$0"' },
    });
    assert.deepStrictEqual(source, {
      cited: true,
      url: "https://example.com/pricing",
      readOn: "2026-09-05",
      finding: 'the page names Example and states "$0"',
    });
  });

  it("cites the page and the date alone where the check recorded which layer matched and no finding", () => {
    const source = freeTierSourceOf({
      url: "https://example.com/pricing",
      tier: "Free",
      verifiedDate: "2026-08-01",
      source_check: { checked: "2026-09-05", outcome: "ok", detail: "text" },
    });
    assert.deepStrictEqual(source, {
      cited: true,
      url: "https://example.com/pricing",
      readOn: "2026-09-05",
      finding: null,
    });
  });

  for (const outcome of ["unreadable", "states_no_terms", "does_not_name_vendor", "states_no_amount"] as const) {
    it(`declines to cite a source the check settled as ${outcome}, and says so`, () => {
      const source = freeTierSourceOf({
        url: "https://example.com/pricing",
        verifiedDate: "2026-08-01",
        source_check: { checked: "2026-09-05", outcome, detail: "" },
      });
      assert.strictEqual(source.cited, false);
      assert.ok(!source.cited && source.clause.length > 0);
    });
  }

  it("sends nobody to the pricing page of an offer our own tier records as ended", () => {
    const source = freeTierSourceOf({
      url: "https://example.com/pricing",
      tier: "Retired",
      verifiedDate: "2026-08-01",
      source_check: { checked: "2026-09-05", outcome: "ok", detail: 'the page names Example and states "$0"' },
    });
    assert.strictEqual(source.cited, false);
    assert.ok(!source.cited && source.clause === ENDED_OFFER_CLAUSE);
  });

  it("says a service we hold no record for has none, rather than citing nothing", () => {
    const source = freeTierSourceOf(undefined);
    assert.deepStrictEqual(source, { cited: false, clause: NO_CATALOGUE_RECORD });
  });

  it("renders the read as a link, a date and the quote, with a rel that endorses nobody", () => {
    const html = readClauseHtml(
      "2026-09-05",
      [{ url: "https://example.com/pricing", quote: "free forever" }],
      (t: string) => t,
      { dateClass: "read-on" },
    );
    assert.match(html, /We read that on <span class="read-on"[^>]*>2026-09-05<\/span> from /);
    assert.match(html, new RegExp(`<a href="https://example\\.com/pricing" rel="nofollow noopener" class="${RECORD_SOURCE_CLASS}">`));
    assert.match(html, /where it says: &ldquo;free forever&rdquo;/);
  });

  it("drops the quote clause and keeps the link when there is nothing quoted", () => {
    const html = readClauseHtml("2026-09-05", [{ url: "https://example.com/pricing" }], (t: string) => t, {
      dateClass: "read-on",
    });
    assert.doesNotMatch(html, /where it says/);
    assert.match(html, /<a href="https:\/\/example\.com\/pricing"/);
  });

  it("attributes a finding to our own check and never to the page", () => {
    const finding = 'the page names Example as "example" and states "$0"';
    const html = readClauseHtml("2026-09-05", [{ url: "https://example.com/pricing", finding }], (t: string) => t, {
      dateClass: "read-on",
    });
    assert.doesNotMatch(html, /where it says/);
    assert.ok(html.includes(`${CHECK_FINDING_LEAD}: ${finding}`), html);
  });

  it("puts the list of sources inside the methodology block it belongs to", () => {
    const page = '<h2 id="data-source">Data Source</h2>\n<div class="methodology">Compiled by hand. <div>x</div></div>\n<h2>Next</h2>';
    const list = citedSourcesListHtml(
      [{ vendor: "Example", slug: "example", source: { cited: false, clause: NO_CATALOGUE_RECORD } }],
      (t: string) => t,
      "read-on",
    );
    const out = withCitedSources(page, list);
    assert.ok(methodologyBlockEnd(page) !== null);
    assert.match(out, /<ul class="cited-sources"[\s\S]*<\/ul>\s*<\/div>\s*<h2>Next<\/h2>/);
    assert.match(out, /<li id="source-example">/);
  });

  it("leaves a page with no methodology block untouched", () => {
    const page = "<p>nothing to attach to</p>";
    assert.strictEqual(withCitedSources(page, "<ul></ul>"), page);
    assert.strictEqual(methodologyBlockEnd(page), null);
  });

  it("strips a source marker by the same pattern wherever a subject is read out of markup", () => {
    assert.strictEqual(SOURCE_MARKER_IN_A_CELL.source, SOURCE_MARKER_MARKUP.source);
  });

  it("anchors a service on its slug so a row can reach its own entry", () => {
    assert.strictEqual(sourceAnchorId({ vendor: "Fly.io", slug: "fly-io" }), "source-fly-io");
    assert.strictEqual(sourceAnchorId({ vendor: "Dead Man's Snitch", slug: null }), "source-dead-man-s-snitch");
  });
});

describe("every comparison page reaches the pages its figures were read from", () => {
  let server: { proc: ChildProcess; base: string };
  const rendered = new Map<string, string>();

  before(async () => {
    server = await startServer();
    for (const page of [...COMPILED_PAGES, ...PAGES_THAT_ALREADY_LINKED_OUT, VENDOR_PAGE]) {
      rendered.set(page, await fetch(`${server.base}${page}`).then(r => r.text()));
    }
  });

  after(() => server?.proc.kill());

  it("links out of every compiled comparison page", () => {
    const silent = COMPILED_PAGES.filter(page => outboundHosts(rendered.get(page)!).length === 0);
    assert.deepStrictEqual(silent, []);
  });

  it("lists the services it compares in the data source section of every one of them", () => {
    const missing = COMPILED_PAGES.filter(page => !rendered.get(page)!.includes('<ul class="cited-sources"'));
    assert.deepStrictEqual(missing, []);
    const listed = COMPILED_PAGES.map(page => (rendered.get(page)!.match(/<li id="source-/g) ?? []).length);
    assertPopulationFloor(
      listed.reduce((a, b) => a + b, 0),
      100,
      "services listed with a source across the compiled comparison pages",
    );
  });

  it("gives every cited link the url, the read date and the outcome its own record holds", () => {
    const wrong: string[] = [];
    let checked = 0;
    const byUrl = new Map<string, Offer[]>();
    for (const offer of offers) byUrl.set(offer.url, [...(byUrl.get(offer.url) ?? []), offer]);
    for (const page of COMPILED_PAGES) {
      for (const link of citedSourceLinks(rendered.get(page)!)) {
        const records = byUrl.get(link.url) ?? [];
        if (records.length === 0) {
          wrong.push(`${page}: ${link.url} is on no record`);
          continue;
        }
        checked += 1;
        if (!records.some(r => r.source_check?.outcome === "ok")) {
          wrong.push(`${page}: ${link.url} cited, and no record holding it passed its check`);
        }
        if (!records.some(r => link.title.includes(r.source_check?.checked ?? "\u0000"))) {
          wrong.push(`${page}: ${link.url} dated ${link.title}, no record holding it was read then`);
        }
      }
    }
    assert.deepStrictEqual(wrong, []);
    assertPopulationFloor(checked, 100, "cited source links checked against the record behind them");
  });

  it("marks a figure whose source we could not read rather than linking it as though we had", () => {
    const wrong: string[] = [];
    let marked = 0;
    for (const page of COMPILED_PAGES) {
      const html = rendered.get(page)!;
      for (const entry of html.matchAll(/<li id="source-([a-z0-9-]+)">([\s\S]*?)<\/li>/g)) {
        const vendor = vendorSlugMap.get(entry[1]!);
        const record = vendor ? primaryFor.get(vendor) : undefined;
        const outcome = record?.source_check?.outcome;
        const ended = record !== undefined && offerRetired(record);
        const claimsARead = entry[2]!.includes("We read that on");
        if (outcome === "ok" && !ended && !claimsARead) {
          wrong.push(`${page}: ${entry[1]} passed its check and cites nothing`);
        }
        if (outcome !== undefined && outcome !== "ok" && claimsARead) {
          wrong.push(`${page}: ${entry[1]} is ${outcome} and claims a read`);
        }
        if (ended && claimsARead) wrong.push(`${page}: ${entry[1]} has ended and claims a read`);
        if (!claimsARead) marked += 1;
      }
    }
    assert.deepStrictEqual(wrong, []);
    assertPopulationFloor(marked, 20, "listed services that say what is missing instead of citing a source");
  });

  it("leaves no row that puts a number beside a service without a source or a reason", () => {
    const bare: string[] = [];
    let rows = 0;
    for (const page of COMPILED_PAGES) {
      const html = staticHalfOf(rendered.get(page)!);
      for (const slot of tabulatedSubjectSlots(html, namedVendorSlug)) {
        if (slot.slug === null) continue;
        rows += 1;
        if (!/class="(?:record-source|unsourced-tag)"/.test(slot.cell)) {
          bare.push(`${page}: ${slot.subject}`);
        }
      }
    }
    assert.deepStrictEqual(bare, []);
    assertPopulationFloor(rows, 100, "table rows naming a service we hold a record for");
  });

  it("counts the same rows the page register counts, once the markers are stripped", () => {
    for (const page of COMPILED_PAGES) {
      const html = rendered.get(page)!;
      const named = vendorFactRows(html, namedVendorSlug);
      assert.ok(
        named.every(row => !row.subject.includes("Source")),
        `${page} reads a source marker as part of a service name: ${JSON.stringify(named.slice(0, 3))}`,
      );
    }
  });

  it("cites no page for an offer our own tier records as ended", () => {
    const retired = new Set(offers.filter(offerRetired).map(o => o.url));
    const offenders: string[] = [];
    for (const page of COMPILED_PAGES) {
      for (const link of citedSourceLinks(rendered.get(page)!)) {
        if (retired.has(link.url)) offenders.push(`${page} -> ${link.url}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
    assertPopulationFloor(retired.size, 12, "records whose tier says the offer has ended");
  });

  it("endorses nobody it cites", () => {
    const endorsing: string[] = [];
    for (const page of COMPILED_PAGES) {
      for (const link of rendered.get(page)!.matchAll(/<a href="(https?:\/\/[^"]+)"([^>]*)>/g)) {
        if (OURS.test(link[1]!)) continue;
        if (!/rel="[^"]*nofollow[^"]*"/.test(link[2]!)) endorsing.push(`${page}: ${link[1]}`);
      }
    }
    assert.deepStrictEqual(endorsing, []);
  });

  it("keeps the outbound links on the pages that already had them", () => {
    const lost = PAGES_THAT_ALREADY_LINKED_OUT.filter(page => outboundHosts(rendered.get(page)!).length === 0);
    assert.deepStrictEqual(lost, []);
  });

  it("keeps the methodology block on the head-to-head page that already carried one", () => {
    assert.match(rendered.get("/vercel-vs-netlify")!, /Free tier data sourced from our verified index/);
    assert.match(rendered.get("/vercel-vs-netlify")!, /verified against/i);
  });

  it("reaches a vendor's own pricing page from the free tier it publishes", () => {
    const html = rendered.get(VENDOR_PAGE)!;
    const record = primaryFor.get("Upstash")!;
    const block = html.slice(html.indexOf("Free Tier Details"));
    const line = block.slice(0, block.indexOf("</div>"));
    assert.match(
      line,
      new RegExp(
        `<a href="${record.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" rel="nofollow noopener" class="${RECORD_SOURCE_CLASS}">`,
      ),
    );
    assert.ok(line.includes(record.source_check!.checked), `the free tier line omits ${record.source_check!.checked}`);
  });
});
