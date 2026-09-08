import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  CHECK_ESTABLISHES,
  CHECK_ESTABLISHES_ON_A_LIST,
  CHECK_FINDING_LEAD,
  PAGE_QUOTE_CLASS,
  freeTierSourceOf,
  pageQuoteHtml,
  readClauseHtml,
} = await import("../dist/source-citation.js");
const { NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE, checkFinding } = await import("../dist/source-check.js");
const { toSlug } = await import("../dist/vendor-slug.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
).offers;

const primaryFor = new Map<string, Offer>();
for (const offer of offers) if (!primaryFor.has(offer.vendor)) primaryFor.set(offer.vendor, offer);
const primaries = [...primaryFor.values()];

const recordsWithAFinding = primaries.filter(
  offer => checkFinding(offer) !== null && freeTierSourceOf(offer).cited,
);

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

const QUOTED_AS_THE_PAGES_OWN_WORDS = new RegExp(
  `<span class="${PAGE_QUOTE_CLASS}">where it says: &ldquo;([^<]*)&rdquo;</span>`,
  "g",
);

function quotedAsPageText(html: string): string[] {
  return [...html.matchAll(QUOTED_AS_THE_PAGES_OWN_WORDS)].map(m => m[1]!);
}

function unescapeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const pageTextWeHold = new Set<string>();
for (const offer of offers) {
  if (offer.product_role?.source_quote) pageTextWeHold.add(offer.product_role.source_quote);
  for (const label of offer.product_subtypes?.labels ?? []) {
    if (label.source_quote) pageTextWeHold.add(label.source_quote);
  }
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

describe("a check result is our finding and never the vendor's words", () => {
  it("publishes what the check found, attributed to the check", () => {
    const detail = 'the page names Example as "example" and states "$0"';
    const source = freeTierSourceOf({
      url: "https://example.com/pricing",
      tier: "Free",
      verifiedDate: "2026-08-01",
      source_check: { checked: "2026-09-05", outcome: "ok", detail },
    });
    assert.ok(source.cited);
    assert.strictEqual(source.cited && source.finding, detail);
    const html = readClauseHtml("2026-09-05", [{ url: "https://example.com/pricing", finding: detail }], (t: string) => t, {
      dateClass: "read-on",
    });
    assert.ok(html.includes(`${CHECK_FINDING_LEAD}: ${detail}`), html);
    assert.deepStrictEqual(quotedAsPageText(html), []);
  });

  it("keeps a detail template nobody has written yet out of the quotation slot", () => {
    const novel = "the page renders a pricing widget we cannot read, and its markup states 3 typed prices";
    const source = freeTierSourceOf({
      url: "https://example.com/pricing",
      tier: "Free",
      verifiedDate: "2026-08-01",
      source_check: { checked: "2026-09-05", outcome: "ok", detail: novel },
    });
    assert.strictEqual(source.cited && source.finding, novel);
    const html = readClauseHtml("2026-09-05", [{ url: "https://example.com/pricing", finding: novel }], (t: string) => t, {
      dateClass: "read-on",
    });
    assert.deepStrictEqual(quotedAsPageText(html), []);
    assert.ok(html.includes(novel), html);
  });

  it("publishes nothing where the check recorded which layer matched rather than a finding", () => {
    for (const token of NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE) {
      const offer = { source_check: { checked: "2026-09-05", outcome: "ok" as const, detail: token } };
      assert.strictEqual(checkFinding(offer), null, token);
    }
  });

  it("reaches the quotation slot only through text held as the page's own", () => {
    const html = pageQuoteHtml("Serverless Redis, Vector and Search databases", (t: string) => t);
    assert.deepStrictEqual(quotedAsPageText(html), ["Serverless Redis, Vector and Search databases"]);
  });

  it("holds a population of check results large enough for the sweeps below to mean something", () => {
    assertPopulationFloor(recordsWithAFinding.length, 150, "records whose source check recorded a finding");
  });
});

const CONTROL_VENDOR_PAGE = "/vendor/upstash";

const FREE_TIER_SOURCE_LINE = /<p class="free-tier-source-line"[\s\S]*?<\/p>/;

const vendorRoutes = [...new Set(primaries.map(offer => `/vendor/${toSlug(offer.vendor)}`))];

interface Swept {
  quotes: string[];
  sourceLine: string;
}

describe("nothing we serve attributes our own sentence to the page it cites", () => {
  let server: { proc: ChildProcess; base: string };
  const swept = new Map<string, Swept>();
  const rendered = new Map<string, string>();

  before(async () => {
    server = await startServer();
    for (const route of [...COMPILED_PAGES, CONTROL_VENDOR_PAGE, ...vendorRoutes]) {
      if (swept.has(route)) continue;
      const res = await fetch(`${server.base}${route}`);
      const html = await res.text();
      if (res.status !== 200) continue;
      swept.set(route, {
        quotes: quotedAsPageText(html).map(unescapeEntities),
        sourceLine: html.match(FREE_TIER_SOURCE_LINE)?.[0] ?? "",
      });
      if (COMPILED_PAGES.includes(route) || route === CONTROL_VENDOR_PAGE) rendered.set(route, html);
    }
  });

  after(() => server?.proc.kill());

  it("reads every vendor page and every compiled comparison page", () => {
    assertPopulationFloor(swept.size, 1000, "pages read for the quotation sweep");
    const unserved = [...COMPILED_PAGES, CONTROL_VENDOR_PAGE].filter(route => !swept.has(route));
    assert.deepStrictEqual(unserved, []);
  });

  it("quotes only text our records hold as the page's own words", () => {
    const attributed: Array<{ route: string; quote: string }> = [];
    for (const [route, page] of swept) {
      for (const quote of page.quotes) attributed.push({ route, quote });
    }
    const invented = attributed.filter(({ quote }) => !pageTextWeHold.has(quote));
    assert.deepStrictEqual(
      invented.slice(0, 10),
      [],
      `${invented.length} of ${attributed.length} quotations are text no record holds as the page's own`,
    );
    assertPopulationFloor(attributed.length, 150, "quotations swept across the served pages");
  });

  it("renders no source-check finding as something the cited page says", () => {
    const misattributed: string[] = [];
    for (const offer of recordsWithAFinding) {
      const page = swept.get(`/vendor/${toSlug(offer.vendor)}`);
      if (page?.quotes.includes(checkFinding(offer)!)) misattributed.push(offer.vendor);
    }
    assert.deepStrictEqual(misattributed.slice(0, 10), []);
  });

  it("tells the reader what the check found, and says it was our check", () => {
    const silent: string[] = [];
    let attributed = 0;
    for (const offer of recordsWithAFinding) {
      const page = swept.get(`/vendor/${toSlug(offer.vendor)}`);
      if (!page || page.sourceLine === "") continue;
      if (page.sourceLine.includes(`${CHECK_FINDING_LEAD}: `)) attributed++;
      else silent.push(offer.vendor);
    }
    assert.deepStrictEqual(silent.slice(0, 10), []);
    assertPopulationFloor(attributed, 150, "vendor pages attributing a finding to our check");
  });

  it("never publishes the name of the layer that matched as a thing we found", () => {
    const leaked: string[] = [];
    for (const [route, page] of swept) {
      for (const token of NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE) {
        if (page.sourceLine.includes(`${CHECK_FINDING_LEAD}: ${token}<`)) leaked.push(`${route} — ${token}`);
      }
    }
    assert.deepStrictEqual(leaked.slice(0, 10), []);
  });

  it("says on the page what a check establishes, wherever a citation sits beside the limits", () => {
    const missing: string[] = [];
    let stated = 0;
    for (const [route, page] of swept) {
      if (page.sourceLine === "") continue;
      if (page.sourceLine.includes(CHECK_ESTABLISHES)) stated++;
      else missing.push(route);
    }
    assert.deepStrictEqual(missing.slice(0, 10), []);
    assertPopulationFloor(stated, 500, "vendor pages stating what their source check establishes");
  });

  it("says the same of the list of sources on every compiled comparison page", () => {
    const missing = COMPILED_PAGES.filter(page => !rendered.get(page)!.includes(CHECK_ESTABLISHES_ON_A_LIST));
    assert.deepStrictEqual(missing, []);
  });

  it("keeps quoting the page where a record holds the page's own words", () => {
    const record = primaryFor.get("Upstash");
    const held = record?.product_role?.source_quote ?? record?.product_subtypes?.labels[0]?.source_quote;
    assert.ok(held, "the positive control needs a record holding page text");
    assert.ok(swept.get(CONTROL_VENDOR_PAGE)?.quotes.includes(held!), "the quotation of held page text is gone");
  });

  it("keeps the source links and read dates the comparison pages ship", () => {
    for (const page of COMPILED_PAGES) {
      const html = rendered.get(page)!;
      assert.ok(html.includes('<ul class="cited-sources"'), page);
      assert.match(html, /class="cited-source-read"/, page);
    }
  });

  it("keeps the note that says we could not read the page we cite", () => {
    const carrying = COMPILED_PAGES.filter(page => rendered.get(page)!.includes("unsourced-tag"));
    assertPopulationFloor(carrying.length, 10, "compiled pages still marking a service unsourced");
  });
});
