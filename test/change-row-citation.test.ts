import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue, type Population } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { changeCitesASource, uncitedChangeNotice, CITATION_CLASS, UNCITED_NOTE_CLASS } = await import(
  "../dist/change-citation.js"
);
const { feedEntrySourceXml, digestSourceXml, VIA_LINK_REL, NO_SOURCE_HELD_ELEMENT, CHANGE_FEED_NAMESPACE_PREFIX, CHANGE_FEED_ENTRY_LIMIT } =
  await import("../dist/change-feed.js");

type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const entriesThePerChangeFeedCanPublish = (): Population => ({
  size: Math.min(changes.length, CHANGE_FEED_ENTRY_LIMIT),
  read: "entries the per-change feed can hold, of the changes the log holds",
});

const PER_CHANGE_FEED = "/pricing-changes/feed.xml";
const WEEKLY_FEED = "/feed.xml";
const CHANGE_LOG_ROUTES = ["/changes", "/pricing-changes"];

const ANCHOR = 45;
const LOOKBEHIND = 900;
const LOOKAHEAD = 260;
const ELLIPSIS = ["...", "…"];

const sourceOf = (change: { source_url?: string | null }): string | null =>
  changeCitesASource(change) ? change.source_url!.trim() : null;

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encode(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const blank = (match: string): string => " ".repeat(match.length);

function renderedPart(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<head>[\s\S]*?<\/head>/g, blank)
    .replace(/<p class="page-claim">[\s\S]*?<\/p>/g, blank);
}

interface RenderableRow {
  summary: string;
  anchors: string[];
  sources: string[];
  notices: string[];
}

function rowsFromTheStore(records: readonly DealChange[]): RenderableRow[] {
  const bySummary = new Map<string, { sources: Set<string>; vendors: Set<string> }>();
  for (const change of records) {
    if (change.summary.length < 25) continue;
    if (!bySummary.has(change.summary)) {
      bySummary.set(change.summary, { sources: new Set(), vendors: new Set() });
    }
    const group = bySummary.get(change.summary)!;
    group.vendors.add(change.vendor);
    const url = sourceOf(change);
    if (url) group.sources.add(url);
  }
  return [...bySummary].map(([summary, group]) => ({
    summary,
    anchors: [...new Set([summary.slice(0, ANCHOR), encode(summary.slice(0, ANCHOR))])],
    sources: [...group.sources],
    notices: [...group.vendors].map(uncitedChangeNotice),
  }));
}

function pageAgreesWithSummary(page: string, at: number, summary: string): boolean {
  const ahead = decode(page.slice(at, at + summary.length * 2 + 96));
  let matched = 0;
  while (matched < summary.length && matched < ahead.length && ahead[matched] === summary[matched]) matched++;
  if (matched === summary.length) return true;
  const tail = ahead.slice(matched, matched + 3);
  return ELLIPSIS.some((mark) => tail.startsWith(mark)) || tail.startsWith("<");
}

function occurrences(page: string, needle: string): number[] {
  const found: number[] = [];
  let at = page.indexOf(needle);
  while (at >= 0) {
    found.push(at);
    at = page.indexOf(needle, at + 1);
  }
  return found;
}

function evidenceBeside(page: string, at: number, row: RenderableRow): "source" | "no-source" | null {
  const runEnd = page.indexOf("<", at);
  const end = (runEnd < 0 ? at + row.summary.length : runEnd) + LOOKAHEAD;
  const window = decode(page.slice(Math.max(0, at - LOOKBEHIND), end));
  if (row.sources.some((url) => window.includes(url))) return "source";
  if (row.notices.some((notice) => window.includes(notice))) return "no-source";
  return null;
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

describe("every published change row carries the page it was read from", () => {
  let proc: ChildProcess;
  let port = 0;
  const bodies = new Map<string, string>();
  let sweptPaths: string[] = [];
  const rows = rowsFromTheStore(changes);

  let rowsChecked = 0;
  let citedRows = 0;
  let statedRows = 0;
  let pagesWithARow = 0;
  const bare: string[] = [];

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
    const paths = new Set<string>(["/", ...CHANGE_LOG_ROUTES]);
    for (const sitemap of indexes) {
      for (const entry of (await fetchPath(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const pathname = new URL(entry[1]).pathname;
        if (!indexes.has(pathname)) paths.add(pathname);
      }
    }
    sweptPaths = [...paths].sort().filter((pathname) => !pathname.endsWith(".xml"));

    let next = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        while (next < sweptPaths.length) await fetchPath(sweptPaths[next++]);
      }),
    );
    await fetchPath(PER_CHANGE_FEED);
    await fetchPath(WEEKLY_FEED);

    for (const pathname of sweptPaths) {
      const page = renderedPart(bodies.get(pathname) ?? "");
      let here = 0;
      for (const row of rows) {
        const spots = [...new Set(row.anchors.flatMap((anchor) => occurrences(page, anchor)))];
        for (const at of spots) {
          if (!pageAgreesWithSummary(page, at, row.summary)) continue;
          here++;
          const evidence = evidenceBeside(page, at, row);
          if (evidence === "source") citedRows++;
          else if (evidence === "no-source") statedRows++;
          else bare.push(`${pathname} :: ${row.summary.slice(0, 70)}`);
        }
      }
      rowsChecked += here;
      if (here > 0) pagesWithARow++;
    }
  });

  after(() => proc?.kill());

  it("reads a population on both sides of the question", () => {
    assertCoversPopulation(sweptPaths.length, vendorsInTheCatalogue(), "paths served for the sweep");
    assertPopulationFloor(pagesWithARow, 800, "served pages render at least one change row");
    assertPopulationFloor(rowsChecked, 6000, "change rows rendered across the site");
    assertPopulationFloor(rows.length, 390, "distinct summaries the store can put on a page");
    assertPopulationFloor(
      rows.filter((row) => row.sources.length === 0).length,
      60,
      "summaries no record holds a source for, so the no-source branch is not vacuous",
    );
  });

  it("shows the page behind every change row it renders, on the page that renders it", () => {
    assert.deepStrictEqual(bare.slice(0, 40), []);
    assert.strictEqual(bare.length, 0, `${bare.length} rendered change rows carry no evidence`);
  });

  it("does not reach that by citing everything — it states the ones we hold no source for", () => {
    assertPopulationFloor(citedRows, 5000, "rows shown beside the page they were read from");
    assertPopulationFloor(statedRows, 400, "rows shown beside a statement that we hold no source");
    assert.strictEqual(citedRows + statedRows, rowsChecked);
  });

  for (const route of CHANGE_LOG_ROUTES) {
    it(`keeps every citation ${route} already carried`, () => {
      const html = bodies.get(route)!;
      const links = (html.match(new RegExp(`class="${CITATION_CLASS}"`, "g")) ?? []).length;
      const sourced = changes.filter(changeCitesASource).length;
      assert.ok(
        links >= sourced,
        `${route} renders ${links} citation links for ${sourced} records that hold a source`,
      );
      const stated = (html.match(new RegExp(`class="${UNCITED_NOTE_CLASS}"`, "g")) ?? []).length;
      assert.ok(stated > 0, `${route} states nothing for the records we hold no source for`);
    });
  }

  it("gives every entry in the per-change feed the page it was read from", () => {
    const feed = bodies.get(PER_CHANGE_FEED)!;
    const entries = feed.split("<entry>").slice(1);
    assertCoversPopulation(entries.length, entriesThePerChangeFeedCanPublish(), "entries in the per-change feed");
    const silent = entries.filter(
      (entry) => !entry.includes(`rel="${VIA_LINK_REL}"`) && !entry.includes(NO_SOURCE_HELD_ELEMENT),
    );
    assert.strictEqual(silent.length, 0, `${silent.length} of ${entries.length} feed entries omit their source`);
    const held = new Set(changes.map(sourceOf).filter((url): url is string => url !== null));
    const viaLinks = [...feed.matchAll(new RegExp(`<link href="([^"]+)" rel="${VIA_LINK_REL}"/>`, "g"))].map((m) =>
      decode(m[1]),
    );
    assert.deepStrictEqual(
      viaLinks.filter((url) => !held.has(url)),
      [],
      "the feed points at a page no change record cites",
    );
  });

  it("gives every entry in the weekly digest feed the sources behind it", () => {
    const feed = bodies.get(WEEKLY_FEED)!;
    const entries = feed.split("<entry>").slice(1);
    assert.ok(entries.length > 0, "the weekly feed published no entry");
    const silent = entries.filter(
      (entry) => !entry.includes(`rel="${VIA_LINK_REL}"`) && !entry.includes(NO_SOURCE_HELD_ELEMENT),
    );
    assert.strictEqual(silent.length, 0, `${silent.length} of ${entries.length} weekly entries omit their sources`);
    assert.ok(
      feed.includes(`xmlns:${CHANGE_FEED_NAMESPACE_PREFIX}=`),
      "the weekly feed can emit a namespaced element it never declares",
    );
  });
});

describe("a record with no source says so in the feed rather than going quiet", () => {
  const withSource = { vendor: "Acme", summary: "x", source_url: "https://acme.test/pricing" };
  const withoutSource = { vendor: "Acme", summary: "x", source_url: "" };
  const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  it("emits a standard via link when we hold the page", () => {
    const xml = feedEntrySourceXml(withSource, esc, CHANGE_FEED_NAMESPACE_PREFIX);
    assert.match(xml, new RegExp(`<link href="https://acme.test/pricing" rel="${VIA_LINK_REL}"/>`));
  });

  it("says we hold none rather than omitting the element", () => {
    const xml = feedEntrySourceXml(withoutSource, esc, CHANGE_FEED_NAMESPACE_PREFIX);
    assert.ok(!xml.includes(`rel="${VIA_LINK_REL}"`), xml);
    assert.match(xml, new RegExp(`<${CHANGE_FEED_NAMESPACE_PREFIX}:${NO_SOURCE_HELD_ELEMENT}>`));
  });

  it("carries one via link per distinct source across a digest of many changes", () => {
    const xml = digestSourceXml(
      [withSource, withSource, { ...withSource, source_url: "https://acme.test/blog" }, withoutSource],
      esc,
      CHANGE_FEED_NAMESPACE_PREFIX,
    );
    assert.strictEqual((xml.match(new RegExp(`rel="${VIA_LINK_REL}"`, "g")) ?? []).length, 2);
  });

  it("says a digest holds no source rather than omitting the element", () => {
    const xml = digestSourceXml([withoutSource], esc, CHANGE_FEED_NAMESPACE_PREFIX);
    assert.match(xml, new RegExp(`<${CHANGE_FEED_NAMESPACE_PREFIX}:${NO_SOURCE_HELD_ELEMENT}>`));
  });
});

const CITING_GENERATORS =
  /changeSummaryHtml|changeSummaryText|changeSummaryMarkdown|citedClaimHtml|changeCitationHtml|citedSummary|feedEntrySummary/;

const TEXT_NODE =
  />\s*(?:\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|'\s*\+\s*([^+]*?)\s*\+\s*'|"\s*\+\s*([^+]*?)\s*\+\s*")\s*</g;

const AFTER_A_COLON = /(?::|\bsays:|\bchanged:)\s*\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;

const NOT_A_RENDERED_RECORD = [
  {
    at: "src/serve.ts",
    expr: "c.summary",
    why: "a code sample on /api-docs showing a caller what the JSON holds, not a record we render",
  },
  {
    at: "src/serve.ts",
    expr: "escXml(fields.summary)",
    why: "the per-change feed's own <summary> element, whose provenance is asserted per entry above",
  },
];

function summariesRenderedWithoutACitation(): string[] {
  const dir = path.join(REPO, "src");
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const lines = readFileSync(path.join(dir, file), "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (!/\.summary\b/.test(line)) return;
      for (const pattern of [TEXT_NODE, AFTER_A_COLON]) {
        for (const match of line.matchAll(pattern)) {
          const expr = (match[1] ?? match[2] ?? match[3] ?? "").trim();
          if (!/\.summary\b/.test(expr) || CITING_GENERATORS.test(expr)) continue;
          if (NOT_A_RENDERED_RECORD.some((e) => e.at === `src/${file}` && e.expr === expr)) continue;
          offenders.push(`src/${file}:${index + 1}: ${expr}`);
        }
      }
    });
  }
  return offenders;
}

describe("a route added later cannot render a change record bare", () => {
  it("routes every change summary that reaches a page through a generator that carries the citation", () => {
    assert.deepStrictEqual(summariesRenderedWithoutACitation(), []);
  });

  it("catches a summary put back into a text node without its source", () => {
    const fires = (line: string): string[] => {
      const found: string[] = [];
      for (const pattern of [TEXT_NODE, AFTER_A_COLON]) {
        for (const match of line.matchAll(pattern)) {
          const expr = (match[1] ?? match[2] ?? match[3] ?? "").trim();
          if (/\.summary\b/.test(expr) && !CITING_GENERATORS.test(expr)) found.push(expr);
        }
      }
      return found;
    };
    assert.deepStrictEqual(fires('<div class="s">${escHtmlServer(c.summary)}</div>'), ["escHtmlServer(c.summary)"]);
    assert.deepStrictEqual(fires("'<td>' + escHtmlServer(c.summary) + '</td>'"), ["escHtmlServer(c.summary)"]);
    assert.deepStrictEqual(fires("`${vendor} warrants caution — ${dateClause}: ${cause.summary}`"), ["cause.summary"]);
    assert.deepStrictEqual(fires('<div class="s">${changeSummaryHtml(c, escHtmlServer)}</div>'), []);
    assert.deepStrictEqual(fires("`Most recently: ${changeSummaryText(vendorChanges[0])}`"), []);
    assert.deepStrictEqual(fires("const long = c.summary.length > 120;"), []);
  });

  it("keeps every exemption pointed at a line that still exists", () => {
    for (const exemption of NOT_A_RENDERED_RECORD) {
      const source = readFileSync(path.join(REPO, exemption.at), "utf-8");
      assert.ok(
        source.includes(exemption.expr),
        `${exemption.at} no longer holds ${exemption.expr} — drop the exemption (${exemption.why})`,
      );
    }
  });
});
