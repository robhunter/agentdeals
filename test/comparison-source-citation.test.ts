import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  catalogueMarkersOffRowsNoFetchablePageStates,
  citedSourcesListHtml,
  freeTierSourceOf,
  methodologyBlockEnd,
  missingSourceLabel,
  readClauseHtml,
  sourceAnchorId,
  withCitedSources,
  CHECK_FINDING_LEAD,
  MISSING_SOURCE_LABELS,
  NO_CATALOGUE_RECORD,
  NO_CATALOGUE_RECORD_SOURCE,
  NO_FETCHABLE_PAGE_STATES_THE_ROW,
  FIGURE_SOURCE_CLASS,
} = await import("../dist/source-citation.js");
const { SOURCE_CHECK_OUTCOMES, unconfirmedTermsClause } = await import("../dist/source-check.js");
const { tabulatedSubjectSlots, tabulatedVendorSlots, vendorFactRows, SOURCE_MARKER_IN_A_CELL } =
  await import("../dist/page-reviews.js");
const { RECORD_SOURCE_CLASS, SOURCE_MARKER_MARKUP } = await import("../dist/change-citation.js");
const { ENDED_OFFER_CLAUSE, offerRetired } = await import("../dist/retirement.js");
const { namedVendorSlug, vendorSlugMap } = await import("../dist/vendor-slug.js");
const { unconfirmedTermsForOffer } = await import("../dist/vendor-verdict-input.js");
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

const [VENDOR_SLUG, VENDOR_WE_CAN_CONFIRM] = (() => {
  for (const [slug, vendor] of vendorSlugMap) {
    const record = primaryFor.get(vendor);
    if (record && freeTierSourceOf(record).cited && unconfirmedTermsForOffer(record) === null) return [slug, vendor];
  }
  throw new Error("no vendor publishes terms we can confirm beside the read they came from");
})();

const VENDOR_PAGE = `/vendor/${VENDOR_SLUG}`;

const OURS = /localhost|agentdeals\.dev|fonts\.(?:googleapis|gstatic)\.com/;

const MARKS_A_SOURCE_OR_A_REASON = /class="(?:record-source|unsourced-tag)"/;

function rowCitesItsOwnSource(html: string, at: number): boolean {
  const row = html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
  return row.includes(`class="${FIGURE_SOURCE_CLASS}"`);
}

const AZURE_GUIDE = "/azure-free-tier-2026";
const AWS_GUIDE = "/aws-free-tier-2026";
const GCP_GUIDE = "/gcp-free-tier-2026";
const DIGITALOCEAN_GUIDE = "/digitalocean-free-tier-2026";
const CLOUD_COMPARISON = "/cloud-free-tier-comparison-2026";

const ROWS_NO_FETCHABLE_PAGE_STATES: Record<string, string[]> = {
  [AZURE_GUIDE]: ["Azure Virtual Machines", "Azure Blob Storage", "Azure Files", "Azure Service Bus", "AWS"],
  [AWS_GUIDE]: ["AWS X-Ray"],
  [GCP_GUIDE]: ["AWS"],
  [DIGITALOCEAN_GUIDE]: ["AWS"],
  [CLOUD_COMPARISON]: ["AWS"],
};

const RECORDED_SINCE_BADGE = / CHANGED [A-Z]{3} \d{1,2}$/;

function rowName(subject: string): string {
  return subject.replace(RECORDED_SINCE_BADGE, "");
}

interface TabulatedSlot {
  slug: string | null;
  subject: string;
  cell: string;
  cellEnd: number;
}

type SlotsOf = (html: string, resolve: typeof namedVendorSlug) => TabulatedSlot[];

function rowsWithNeitherASourceNorAReason(page: string, html: string, slotsOf: SlotsOf): { rows: number; bare: string[] } {
  const bare: string[] = [];
  let rows = 0;
  for (const slot of slotsOf(html, namedVendorSlug)) {
    if (slot.slug === null) continue;
    rows += 1;
    if (MARKS_A_SOURCE_OR_A_REASON.test(slot.cell) || rowCitesItsOwnSource(html, slot.cellEnd)) continue;
    if (ROWS_NO_FETCHABLE_PAGE_STATES[page]?.includes(rowName(slot.subject))) continue;
    bare.push(`${page}: ${slot.subject}`);
  }
  return { rows, bare };
}

function withRowBefore(html: string, subject: string, row: string): string {
  const at = html.lastIndexOf("<tr", html.indexOf(`>${subject}`));
  assert.ok(at >= 0, `no row for ${subject} to put a scratch row beside`);
  return html.slice(0, at) + row + html.slice(at);
}

function outboundHosts(html: string): string[] {
  const hrefs = html.match(/href="https?:\/\/[^"]+"/g) ?? [];
  return [...new Set(hrefs.map(h => h.slice(6, -1)).filter(url => !OURS.test(url)))];
}

const CITED_SOURCE_LINK =
  /<a href="(https?:\/\/[^"]+)" rel="nofollow noopener" class="record-source"[^>]*title="([^"]*)"/g;

function citedSourceLinks(html: string): Array<{ url: string; title: string }> {
  return [...html.matchAll(CITED_SOURCE_LINK)].map(m => ({ url: m[1]!, title: m[2]! }));
}

const MISSING_SOURCE_MARKER = /<(a|span)\b([^>]*\bclass="unsourced-tag"[^>]*)>([^<]*)<\/\1>/g;

interface RenderedMarker {
  label: string;
  clause: string | null;
  anchor: string | null;
}

function markersMissingASource(html: string): RenderedMarker[] {
  return [...html.matchAll(new RegExp(MISSING_SOURCE_MARKER.source, "g"))].map(marker => ({
    label: marker[3]!.trim(),
    clause: marker[2]!.match(/\btitle="([^"]*)"/)?.[1] ?? null,
    anchor: marker[2]!.match(/\bhref="#([^"]*)"/)?.[1] ?? null,
  }));
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
      findingEnded: [],
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
      findingEnded: [],
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
    assert.ok(!source.cited && source.kind === "ended");
  });

  it("says a service we hold no record for has none, rather than citing nothing", () => {
    const source = freeTierSourceOf(undefined);
    assert.deepStrictEqual(source, { cited: false, kind: "no_record", clause: NO_CATALOGUE_RECORD });
  });

  it("keeps a service the catalogue holds no pricing page for apart from one whose page it read", () => {
    const source = freeTierSourceOf({ url: "   ", tier: "Free", verifiedDate: "2026-08-01" });
    assert.ok(!source.cited && source.kind === "no_record");
  });

  it("settles every outcome short of ok as a read that could not confirm the terms", () => {
    const settled = SOURCE_CHECK_OUTCOMES.filter((outcome: string) => outcome !== "ok").map(
      (outcome: string) =>
        freeTierSourceOf({
          url: "https://example.com/pricing",
          verifiedDate: "2026-08-01",
          source_check: { checked: "2026-09-05", outcome, detail: "" },
        }),
    );
    assert.deepStrictEqual(
      [...new Set(settled.map((source: { cited: boolean; kind?: string }) => source.kind))],
      ["unconfirmed"],
    );
    assert.strictEqual(new Set(settled.map((source: { clause?: string }) => source.clause)).size, settled.length);
  });

  it("gives a different word to each thing a marker can stand for", () => {
    const kinds = Object.keys(MISSING_SOURCE_LABELS);
    assert.strictEqual(new Set(Object.values(MISSING_SOURCE_LABELS)).size, kinds.length);
    assert.ok(kinds.length >= 3, `a marker stands for ${kinds.length} things and the reader acts on three`);
    for (const kind of kinds) {
      assert.strictEqual(missingSourceLabel({ cited: false, kind, clause: "" }), MISSING_SOURCE_LABELS[kind]);
    }
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
      [{ vendor: "Example", slug: "example", source: NO_CATALOGUE_RECORD_SOURCE }],
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

  it("takes the catalogue record's link or tag off a row that says no page a reader can fetch states it, and off no other row", () => {
    const recordLink = ` <a href="https://example.com/pricing" rel="nofollow noopener" class="${RECORD_SOURCE_CLASS}">Source</a>`;
    const reasonTag = ` <a href="#source-example" class="unsourced-tag" title="We could not confirm it.">Unconfirmed</a>`;
    const cells = (marker: string) => `<td>Example Queue${marker}</td><td>750 hours/month</td>`;
    for (const marker of [recordLink, reasonTag]) {
      assert.strictEqual(
        catalogueMarkersOffRowsNoFetchablePageStates(`<table><tr ${NO_FETCHABLE_PAGE_STATES_THE_ROW}>${cells(marker)}</tr></table>`),
        `<table><tr ${NO_FETCHABLE_PAGE_STATES_THE_ROW}>${cells("")}</tr></table>`);
      for (const row of [`<tr>${cells(marker)}</tr>`, `<tr ${NO_FETCHABLE_PAGE_STATES_THE_ROW}-elsewhere>${cells(marker)}</tr>`, `<tr><td ${NO_FETCHABLE_PAGE_STATES_THE_ROW}>Example Queue${marker}</td></tr>`]) {
        assert.strictEqual(catalogueMarkersOffRowsNoFetchablePageStates(`<table>${row}</table>`), `<table>${row}</table>`);
      }
    }
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
    const found = COMPILED_PAGES.map(page => rowsWithNeitherASourceNorAReason(page, staticHalfOf(rendered.get(page)!), tabulatedSubjectSlots));
    assert.deepStrictEqual(found.flatMap(one => one.bare), []);
    assertPopulationFloor(found.reduce((n, one) => n + one.rows, 0), 100, "table rows naming a service we hold a record for");
  });

  it("leaves no row linking a service's own page without a source or a reason", () => {
    const found = COMPILED_PAGES.map(page => rowsWithNeitherASourceNorAReason(page, staticHalfOf(rendered.get(page)!), tabulatedVendorSlots));
    assert.deepStrictEqual(found.flatMap(one => one.bare), []);
    assertPopulationFloor(found.reduce((n, one) => n + one.rows, 0), 200, "table rows naming a service we hold a record for");
  });

  it("serves each row it lets carry neither, because no page a reader can fetch states its figures", () => {
    const servedBare = Object.entries(ROWS_NO_FETCHABLE_PAGE_STATES).flatMap(([page, subjects]) => {
      const html = staticHalfOf(rendered.get(page)!);
      return tabulatedSubjectSlots(html, namedVendorSlug)
        .filter((slot: TabulatedSlot) => subjects.includes(rowName(slot.subject)))
        .filter((slot: TabulatedSlot) => !MARKS_A_SOURCE_OR_A_REASON.test(slot.cell) && !rowCitesItsOwnSource(html, slot.cellEnd))
        .map((slot: TabulatedSlot) => `${page}: ${rowName(slot.subject)}`);
    });
    const named = Object.entries(ROWS_NO_FETCHABLE_PAGE_STATES).flatMap(([page, subjects]) => subjects.map(subject => `${page}: ${subject}`));
    assert.deepStrictEqual(servedBare.sort(), named.sort());
  });

  it("lets those rows carry neither on their own page only, so the same rows elsewhere still need a source or a reason", () => {
    const html = staticHalfOf(rendered.get(AZURE_GUIDE)!);
    const elsewhere = "/database-free-tier-comparison-2026";
    assert.deepStrictEqual(rowsWithNeitherASourceNorAReason(elsewhere, html, tabulatedSubjectSlots).bare,
      ROWS_NO_FETCHABLE_PAGE_STATES[AZURE_GUIDE]!.map(subject => `${elsewhere}: ${subject}`));
  });

  it("still flags any other row in those tables that carries neither, whatever the row's markup says", () => {
    const html = staticHalfOf(rendered.get(AZURE_GUIDE)!);
    const cells = `<td style="font-weight:600">Azure Event Grid</td><td style="font-family:var(--mono);font-size:.8rem">100,000 operations/month</td><td style="color:var(--text-muted);font-size:.8rem">Messaging</td>`;
    for (const row of [`<tr>${cells}</tr>`, `<tr ${NO_FETCHABLE_PAGE_STATES_THE_ROW}>${cells}</tr>`]) {
      const scratch = withRowBefore(html, "Azure Virtual Machines", row);
      for (const slotsOf of [tabulatedSubjectSlots, tabulatedVendorSlots]) {
        assert.deepStrictEqual(rowsWithNeitherASourceNorAReason(AZURE_GUIDE, scratch, slotsOf).bare, [`${AZURE_GUIDE}: Azure Event Grid`]);
      }
    }
  });

  it("marks a row whose terms are stated in words as readily as one stating a figure", () => {
    const statedInWords: string[] = [];
    const bare: string[] = [];
    for (const page of COMPILED_PAGES) {
      const html = staticHalfOf(rendered.get(page)!);
      const figured = new Set(tabulatedSubjectSlots(html, namedVendorSlug).map(slot => slot.cellEnd));
      for (const slot of tabulatedVendorSlots(html, namedVendorSlug)) {
        if (slot.slug === null || figured.has(slot.cellEnd)) continue;
        statedInWords.push(`${page}: ${slot.subject}`);
        if (!/class="(?:record-source|unsourced-tag)"/.test(slot.cell)) bare.push(`${page}: ${slot.subject}`);
      }
    }
    assert.deepStrictEqual(bare, []);
    assertPopulationFloor(statedInWords.length, 1, "rows stating a service's terms without a numeral");
  });

  it("gives each thing a marker stands for its own word, on every page that marks one", () => {
    const labelForClause = new Map<string, string>([
      [ENDED_OFFER_CLAUSE, MISSING_SOURCE_LABELS.ended],
      [NO_CATALOGUE_RECORD, MISSING_SOURCE_LABELS.no_record],
      ...SOURCE_CHECK_OUTCOMES.filter((outcome: string) => outcome !== "ok").map(
        (outcome: string) => [unconfirmedTermsClause(outcome), MISSING_SOURCE_LABELS.unconfirmed] as [string, string],
      ),
    ]);
    const wrong: string[] = [];
    let marked = 0;
    for (const page of COMPILED_PAGES) {
      for (const tag of markersMissingASource(rendered.get(page)!)) {
        marked += 1;
        if (tag.clause === null) {
          wrong.push(`${page}: a marker reading ${tag.label} states nothing about what is missing`);
          continue;
        }
        const expected = labelForClause.get(tag.clause);
        if (expected === undefined) wrong.push(`${page}: no word is settled for ${tag.clause}`);
        else if (expected !== tag.label) wrong.push(`${page}: ${tag.clause} reads ${tag.label}, not ${expected}`);
      }
    }
    assert.deepStrictEqual(wrong, []);
    assertPopulationFloor(marked, 60, "markers standing in for a source across the compiled comparison pages");
  });

  it("never calls an offer that has ended by the word it uses for one it could not confirm", () => {
    const ended: string[] = [];
    for (const page of COMPILED_PAGES) {
      for (const tag of markersMissingASource(rendered.get(page)!)) {
        if (tag.clause !== ENDED_OFFER_CLAUSE) continue;
        ended.push(`${page}: ${tag.label}`);
        assert.strictEqual(tag.label, MISSING_SOURCE_LABELS.ended, `${page} marks an offer that has ended as ${tag.label}`);
        assert.notStrictEqual(tag.label, MISSING_SOURCE_LABELS.unconfirmed);
        assert.notStrictEqual(tag.label, MISSING_SOURCE_LABELS.no_record);
      }
    }
    assertPopulationFloor(ended.length, 1, "markers on offers our own record says have ended");
  });

  it("reaches the sentence that spells out the clause, or carries the whole of it", () => {
    const unreachable: string[] = [];
    let reaching = 0;
    for (const page of COMPILED_PAGES) {
      const html = rendered.get(page)!;
      const entries = new Map(
        [...html.matchAll(/<li id="(source-[a-z0-9-]+)">([\s\S]*?)<\/li>/g)].map(entry => [
          entry[1]!,
          entry[2]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
        ]),
      );
      for (const tag of markersMissingASource(html)) {
        if (tag.anchor === null) {
          if (tag.clause !== NO_CATALOGUE_RECORD) {
            unreachable.push(`${page}: ${tag.clause} is carried in an attribute and nowhere a reader can see it`);
          }
          continue;
        }
        reaching += 1;
        const entry = entries.get(tag.anchor);
        if (entry === undefined) unreachable.push(`${page}: ${tag.label} points at ${tag.anchor}, which is not on the page`);
        else if (!entry.includes(tag.clause!)) unreachable.push(`${page}: ${tag.anchor} does not spell out ${tag.clause}`);
      }
    }
    assert.deepStrictEqual(unreachable, []);
    assertPopulationFloor(reaching, 50, "markers reaching a sentence on the page that spells the clause out");
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
    assertPopulationFloor(retired.size, 9, "records whose tier says the offer has ended");
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
    assert.match(
      rendered.get("/vercel-vs-netlify")!,
      /figures in (?:the tables below|the &ldquo;[^&]+&rdquo; table) come from our records for [\d,]+ developer tools/i,
    );
    assert.match(rendered.get("/vercel-vs-netlify")!, /verified against/i);
  });

  it("reaches a vendor's own pricing page from the free tier it publishes", () => {
    const html = rendered.get(VENDOR_PAGE)!;
    const record = primaryFor.get(VENDOR_WE_CAN_CONFIRM)!;
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
