import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  compiledClause, dataProvenanceFor, dateModifiedFor, freshnessSegmentFor, overdueReport, parsePageReviews,
  reviewStatus, staleFactPages,
} = await import("../dist/page-reviews.js");
const { faqAnswersIn, faqProvenanceClause, statesVendorFigure } = await import("../dist/faq-provenance.js");

const PAGE = "/database-pricing";

const WITHDRAWN: Record<string, RegExp> = {
  "MongoDB Atlas's paid plans from M10 at $0.08 an hour": /\$0\.08\/hr \(M10\)/,
  "MongoDB Atlas's team cost from M10 alone": /\$57\+ \(M10\)/,
  "MongoDB Atlas's jump from free straight to a $57 cluster": /Jump from free to paid is steep|M10 cluster starts at ~\$57/,
  "Turso's paid plans from Scaler at $29": /\$29\/mo \(Scaler\)/,
  "Turso replicating every database to 26+ locations": /replicate to 26\+ locations/,
  "Turso's free plan with edge replicas": /100 databases, edge replicas/,
  "Cloudflare D1 billed $0.75 per million reads": /\$0\.75\/M reads/,
  "Cloudflare D1 point-in-time recovery on paid plans only": /Point-in-time recovery on paid plans/,
  "edge databases charging for cross-region reads": /may charge for cross-region reads/,
  "DynamoDB billed $0.25 per million write capacity units": /\$0\.25\/M WCU/,
  "DynamoDB's free capacity priced on demand": /~200 million requests\/month with on-demand pricing/,
  "Redis Cloud's paid plans from $7 a month": /\$7\/mo \(Essentials\)|\$0–7(?!\d)|\$7–50\+/,
  "Zilliz Cloud's free tier as 2 collections": /(?<!\d)2 collections|2-collection limit/,
  "BigQuery billed $5 per TiB queried": /\$5\/TiB/,
  "Prisma Accelerate's paid plans from $49 a month": /\$49\b/,
  "Couchbase Capella's paid clusters from $0.093 an hour on 3 nodes": /\$0\.093\/hr|\$67\+|3 nodes minimum/,
  "the figures as never re-checked since they were compiled": /not re-checked since/,
};

const STATED = [
  "Free clusters pause after 30 days with zero connections.",
  "Edge replicas closed to new users in January 2025.",
  "On 2026-10-02 Turso announced that Supabase is acquiring it. Turso says the service keeps running.",
  "(5 GB, 100 databases, embedded replicas)",
  "Point-in-time recovery: 7 days free, 30 days paid.",
  "D1 charges no egress and nothing extra for read replicas; Turso closed edge replicas to new users in January 2025.",
  "Enough for about 200M requests/month on provisioned capacity. A Free-plan AWS account closes after 6 months unless upgraded.",
  "Free instances pause after 72 hours idle and are deleted after 30 days paused.",
  "Retires December 1, 2026. 60,000 cache operations a month",
  "Turns off after 72 hours idle (data kept); deleted after 30 days idle.",
  "Free cluster with up to 5 collections and 5 GB storage; suspended after 7 days of inactivity.",
];

const SCHEMA_ONLY = "CockroachDB's pg_dump exports schema only.";

const ROWS: string[][] = [
  ["Supabase", "60 direct / 200 pooled"],
  ["Turso", "$5.99/mo (Developer)"],
  ["Cloudflare D1", "5 GB (500 MB per DB)", "$0.001/M rows read (Workers Paid)"],
  ["Cloudflare D1", "Generous free tier", "5 GB (500 MB per DB)"],
  ["Amazon DynamoDB", "$0.625/M writes (on-demand)"],
  ["Neo4j AuraDB", "$0.09/GB/hr (Professional, 1 GB min)"],
  ["Neo4j AuraDB", "$0", "≈$66+"],
  ["Convex", "$25/dev/mo (Professional)", "Per-developer"],
  ["Convex", "$0", "$125+ (5 devs)"],
  ["Redis Cloud", "$5/mo (Essentials)"],
  ["Redis Cloud", "$0–5", "$5–50+"],
  ["Zilliz Cloud", "5 collections, 5 GB", "Per-CU"],
  ["Zilliz Cloud", "Limited free tier", "5 collections, 5 GB"],
  ["Google Cloud BigQuery", "$6.25/TiB queried"],
  ["Prisma Accelerate", "$10/mo (Starter)"],
  ["Prisma Accelerate", "$0", "$10+"],
  ["MongoDB Atlas", "$0.011/hr (Flex, up to $30/mo)"],
  [
    "MongoDB Atlas", "$0", "$8-30 (Flex); $57+ (M10 dedicated)",
    "M0 free tier has no backups, no VPC peering, limited to 100 ops/sec. Paid starts with Flex at $8-30 a month; dedicated M10 clusters start at about $57.",
  ],
  ["Couchbase Capella", "$0.15/hr per node (Basic)"],
  ["Couchbase Capella", "$0", "≈$110+"],
];

const KEY_COST_FACTOR_OPENS: Record<string, string> = {
  "Zilliz Cloud": "5-collection limit on free tier; idle clusters suspend after 7 days.",
  "Couchbase Capella": "The free cluster is one 8 GB node. Basic clusters start at 1 node.",
};

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ");
}

function textOf(markup: string): string {
  return decode(
    markup
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

function rowsOf(markup: string): string[][] {
  return [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell)))
    .filter((cells) => cells.length >= 2);
}

function namedFor(firstCell: string, name: string): boolean {
  return firstCell === name || firstCell.startsWith(`${name} `);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function articleDescription(markup: string): string {
  for (const [, block] of markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(block);
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (entry?.["@type"] === "Article" && typeof entry.description === "string") return entry.description;
    }
  }
  return "";
}

function registered(): any[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

async function renderedPage(reviewsPath?: string): Promise<string> {
  let server: ChildProcess | undefined;
  try {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(reviewsPath ? { AGENTDEALS_PAGE_REVIEWS_PATH: reviewsPath } : {}), PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const response = await fetch(`${base}${PAGE}`);
    assert.strictEqual(response.status, 200);
    return await response.text();
  } finally {
    server?.kill();
  }
}

let html = "";

describe("/database-pricing states the 13 services it re-checked as each vendor's own page does", () => {
  before(async () => {
    html = await renderedPage();
  });

  it("serves none of the replaced figures anywhere on the page", () => {
    const found = Object.entries(WITHDRAWN)
      .filter(([, pattern]) => pattern.test(html))
      .map(([claim, pattern]) => `${claim} ("${html.match(pattern)![0]}")`);
    assert.deepStrictEqual(found, []);
  });

  it("states each corrected term in the sentence given for it", () => {
    const text = textOf(html);
    assert.deepStrictEqual(STATED.filter((line) => !text.includes(line)), []);
  });

  it("says CockroachDB's pg_dump exports schema only after each sentence that names it beside pg_dump, and in the structured answer", () => {
    assert.strictEqual(occurrences(textOf(html), SCHEMA_ONLY), 3);
    const migration = faqAnswersIn(PAGE, html).filter((answer: { text: string }) => answer.text.includes("pg_dump works across all of them"));
    assert.strictEqual(migration.length, 1);
    assert.ok(migration[0].text.includes(`pg_dump works across all of them. ${SCHEMA_ONLY}`), migration[0].text);
  });

  it("puts each corrected figure in its vendor's table rows", () => {
    const rows = rowsOf(html);
    const missing = ROWS
      .filter(([name, ...cells]) => !rows.some((row) => namedFor(row[0], name) && cells.every((cell) => row.includes(cell))))
      .map((cells) => cells.join(" | "));
    assert.deepStrictEqual(missing, []);
  });

  it("opens each shortened key cost factor with the corrected sentence", () => {
    const section = html.slice(html.indexOf('id="cost-analysis"'));
    const rows = rowsOf(section.slice(0, section.indexOf("</table>")));
    const wrong = Object.entries(KEY_COST_FACTOR_OPENS).filter(([name, opening]) => {
      const row = rows.find((cells) => namedFor(cells[0], name));
      return !row || !row[3].startsWith(opening);
    }).map(([name]) => name);
    assert.deepStrictEqual(wrong, []);
  });

  it("re-checks only vendors whose figures a registered page puts in a table", () => {
    const strays = registered()
      .filter((p) => p.partial_recheck)
      .flatMap((p) => p.partial_recheck.vendors.filter((slug: string) => !p.vendors_tabulated.includes(slug)).map((slug: string) => `${p.path}: ${slug}`));
    assert.deepStrictEqual(strays, []);
  });
});

function record(overrides: Record<string, unknown> = {}): any {
  return {
    path: "/p", published: "2026-04-09", tier: "A", vendors_asserted: [], vendors_tabulated: ["alpha", "beta"],
    badge_subjects_unresolved: [], stat_card_subjects_unresolved: [], reviewed_at: null, reviewer: null,
    review_outcome: null, review_note: null, partial_recheck: null, reads_index: false, tables_read_index: false,
    table_figures: 4, table_figures_from_records: 0, tables: [], reads_changes: false, data_source: "unsourced",
    data_source_reason: null, ...overrides,
  };
}

const RECHECKED = { on: "2026-10-12", vendors: ["alpha", "beta"] };

describe("a partial re-check dates a page's compiled figures and counts as no review", () => {
  it("names how many services were re-checked and when, on every surface that dates the compilation", () => {
    const page = record({ partial_recheck: RECHECKED });
    assert.strictEqual(compiledClause(page, "2026-10-13"), "Compiled 2026-04-09; 2 services re-checked 2026-10-12");
    assert.strictEqual(dataProvenanceFor(page, 1580, "2026-10-13"), "Figures compiled 2026-04-09; 2 services re-checked 2026-10-12");
    assert.strictEqual(faqProvenanceClause(page, "2026-10-13"), "Figures compiled 2026-04-09; 2 services re-checked 2026-10-12.");
  });

  it("counts one service in the singular", () => {
    const page = record({ partial_recheck: { on: "2026-10-12", vendors: ["alpha"] } });
    assert.strictEqual(compiledClause(page, "2026-10-12"), "Compiled 2026-04-09; 1 service re-checked 2026-10-12");
  });

  it("says nothing of a re-check before its date", () => {
    const page = record({ partial_recheck: RECHECKED });
    assert.strictEqual(compiledClause(page, "2026-10-11"), "Compiled 2026-04-09, not re-checked since");
    assert.strictEqual(faqProvenanceClause(page, "2026-10-11"), "Figures compiled 2026-04-09, not re-checked since.");
  });

  it("gives way to a review that read the whole page", () => {
    const passed = record({ partial_recheck: RECHECKED, reviewed_at: "2026-10-01", reviewer: "x", review_outcome: "pass" });
    assert.strictEqual(compiledClause(passed, "2026-10-13"), "Compiled 2026-04-09, last checked 2026-10-01");
    const failed = record({ partial_recheck: RECHECKED, reviewed_at: "2026-10-01", reviewer: "x", review_outcome: "fail" });
    assert.strictEqual(compiledClause(failed, "2026-10-13"), "Compiled 2026-04-09");
    assert.strictEqual(faqProvenanceClause(failed, "2026-10-13"), "Figures compiled 2026-04-09, last checked 2026-10-01; corrections outstanding.");
  });

  it("leaves the review state, the review queue, the structured date and the stale facts as they were", () => {
    const without = record();
    const withRecheck = record({ partial_recheck: RECHECKED });
    const today = "2026-10-13";
    assert.deepStrictEqual(reviewStatus(withRecheck, today), reviewStatus(without, today));
    assert.strictEqual(freshnessSegmentFor(withRecheck, today), freshnessSegmentFor(without, today));
    assert.strictEqual(dateModifiedFor(withRecheck, "2026-01-01", today), "2026-04-09");
    const index = (page: any) => ({ version: 1, sla_days: { A: 30, B: 90 }, pages: [page] });
    assert.deepStrictEqual(overdueReport(today, index(withRecheck)), overdueReport(today, index(without)));
    const changedAfterPublishing = (slug: string) => (slug === "alpha" ? "2026-06-01" : null);
    const stale = staleFactPages([withRecheck], today, changedAfterPublishing);
    assert.deepStrictEqual(stale, staleFactPages([without], today, changedAfterPublishing));
    assert.deepStrictEqual(stale.flatMap((p: any) => p.facts.map((f: any) => f.slug)), ["alpha"]);
  });

  it("keeps a well-formed re-check through a read of the register and drops one it cannot date", () => {
    const parse = (partial_recheck: unknown) =>
      parsePageReviews(JSON.stringify({ pages: [{ path: "/p", published: "2026-04-09", tier: "A", partial_recheck }] })).pages[0].partial_recheck;
    assert.deepStrictEqual(parse({ on: "2026-10-12", vendors: ["alpha", "beta", "alpha"] }), RECHECKED);
    assert.strictEqual(parse({ on: "2026-04-08", vendors: ["alpha"] }), null);
    assert.strictEqual(parse({ on: "October 12", vendors: ["alpha"] }), null);
    assert.strictEqual(parse({ on: "2026-10-12", vendors: [] }), null);
    assert.strictEqual(parse(undefined), null);
  });
});

describe("a partial re-check on a served page", () => {
  it("prints a synthetic partial re-check in every place the page dates its compiled figures", async () => {
    const page = record({ path: PAGE, partial_recheck: RECHECKED });
    const scratch = mkdtempSync(path.join(tmpdir(), "database-recheck-"));
    const reviewsPath = path.join(scratch, "page-reviews.json");
    let html: string;
    try {
      writeFileSync(reviewsPath, JSON.stringify({ version: 1, sla_days: { A: 30, B: 90 }, pages: [page] }));
      html = await renderedPage(reviewsPath);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const { on, vendors } = page.partial_recheck;
    const tail = `${page.published}; ${vendors.length} services re-checked ${on}`;
    const metaOf = (attribute: string) => html.match(new RegExp(`<meta ${attribute} content="([^"]*)"`))?.[1] ?? "";
    const places: Record<string, string> = {
      "meta description": decode(metaOf('name="description"')),
      "og:description": decode(metaOf('property="og:description"')),
      "Article structured data": articleDescription(html),
      byline: textOf(html.match(/<p class="pub-date">[\s\S]*?<\/p>/)?.[0] ?? ""),
      "table note": textOf(html.match(/<p class="section-intro">[\s\S]*?<\/p>/)?.[0] ?? ""),
    };
    const answers = faqAnswersIn(PAGE, html).filter((answer: { text: string }) => statesVendorFigure(answer.text));
    assert.ok(answers.length >= 5, `only ${answers.length} structured answers state a figure`);
    for (const answer of answers) places[`answer: ${answer.question}`] = answer.text;
    const dated = new RegExp(`(?:Figures compiled|Compiled) ${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const silent = Object.entries(places).filter(([, text]) => !dated.test(text)).map(([place]) => place);
    assert.deepStrictEqual(silent, []);
    assert.ok(places.byline.includes("Not yet reviewed"), places.byline);
  });

});
