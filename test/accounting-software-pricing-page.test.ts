import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { accountingPageUrls, parseAccountingPrices } = await import("../dist/accounting-prices.js");
const { archiveCaptureDate } = await import("../dist/guide-data.js");

type AccountingPrices = import("../src/accounting-prices.ts").AccountingPrices;
type AccountingSource = import("../src/accounting-prices.ts").AccountingSource;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/accounting-software-pricing-2026";
const DATA_FILE = path.join(REPO, "data", "accounting_prices.json");
const committed: AccountingPrices = JSON.parse(readFileSync(DATA_FILE, "utf8"));

function startServer(env: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, base: `http://localhost:${m[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const decoded = (html: string) =>
  html.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const prose = (html: string) =>
  decoded(html.replace(/<\/(?:td|th|p|h1|h2|li)>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

const cellText = (html: string) => decoded(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

const articleOf = (page: string) => {
  const start = page.indexOf('<article class="accounting-guide">');
  const end = page.indexOf("</article>");
  assert.ok(start > -1 && end > start, "the page holds its guide in one article");
  return page.slice(start, end);
};

const tableRows = (page: string, tableClass: string) => {
  const table = articleOf(page).match(new RegExp(`<table class="pricing-table ${tableClass}">[\\s\\S]*?</table>`))?.[0] ?? "";
  assert.ok(table, `the page has no ${tableClass} table`);
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, inner]) => inner));
};

const hrefsIn = (html: string) => [...html.matchAll(/<a href="([^"]+)"/g)].map(([, href]) => decoded(href));

const sourceText = (source: AccountingSource) =>
  source.urls.length === 1 ? source.label : `${source.label} (${source.urls.map((url) => archiveCaptureDate(url)).join(", ")})`;

const FIGURE = /\d{4}-\d{2}-\d{2}|\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?%|\d+¢|(?:January|February|March|April|May|June|July|August|September|October|November|December)(?: \d{1,2}\b)?(?:,? \d{4}\b)?/g;

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function figuresTheFileHolds(prices: AccountingPrices): Set<string> {
  const strings = stringsIn(prices);
  const captureDays = strings.map((text) => archiveCaptureDate(text)).filter((day): day is string => day !== null);
  return new Set([...strings.flatMap((text) => text.match(FIGURE) ?? []), ...captureDays]);
}

function servedFrom(dataFile: string | null) {
  const state = { page: "", status: 0, sitemap: "", guides: "", llms: "" };
  let server: ChildProcess | null = null;
  before(async () => {
    const { child, base } = await startServer(dataFile ? { AGENTDEALS_ACCOUNTING_PRICES_PATH: dataFile } : {});
    server = child;
    const res = await fetch(`${base}${ROUTE}`);
    state.status = res.status;
    state.page = await res.text();
    state.sitemap = await (await fetch(`${base}/sitemap-pages.xml`)).text();
    state.guides = await (await fetch(`${base}/guides`)).text();
    state.llms = await (await fetch(`${base}/llms.txt`)).text();
  });
  after(() => { if (server) server.kill(); });
  return state;
}

describe("the accounting software guide, built from data/accounting_prices.json", () => {
  const served = servedFrom(null);

  it("answers 200 with the title, meta description, lead and read line the data file gives", () => {
    assert.strictEqual(served.status, 200);
    assert.ok(served.page.includes(`<title>${committed.title} — AgentDeals</title>`));
    assert.strictEqual(decoded(served.page.match(/<meta name="description" content="([^"]*)">/)?.[1] ?? ""), committed.meta_description);
    const article = articleOf(served.page);
    assert.strictEqual(cellText(article.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ""), committed.title);
    const paragraphs = [...article.matchAll(/<p class="([^"]+)">([\s\S]*?)<\/p>/g)].map(([, cls, inner]) => [cls, cellText(inner)]);
    assert.deepStrictEqual(paragraphs.slice(0, 2), [["section-intro", committed.lead], ["pub-date", committed.read_line]]);
  });

  it("prints the lead, the read line, the four tables, the checked claim and the sources in the draft's order", () => {
    const article = articleOf(served.page);
    const text = prose(article);
    const order = [
      committed.lead,
      committed.read_line,
      committed.free_plans.heading,
      committed.free_plans.intro,
      committed.price_changes.heading,
      committed.price_changes.intro,
      committed.price_changes.note,
      committed.list_prices.heading,
      committed.list_prices.intro,
      committed.list_prices.offers,
      committed.payment_fees.heading,
      committed.checked_claim.heading,
      committed.checked_claim.text,
      "Sources",
    ].map((fragment) => text.indexOf(prose(fragment)));
    assert.ok(order.every((at) => at > -1), JSON.stringify(order));
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
    const tables = [...article.matchAll(/<table class="pricing-table ([^"]+)">/g)].map(([, cls]) => cls);
    assert.deepStrictEqual(tables, ["accounting-free-plans", "accounting-price-changes", "accounting-list-prices", "accounting-payment-fees"]);
  });

  it("prints the free plans table with a column for each plan, each row's label and cells, and each plan's sources linked", () => {
    const rows = tableRows(served.page, "accounting-free-plans");
    const free = committed.free_plans;
    assert.deepStrictEqual(rows.map((row) => row.map(cellText)), [
      ["", ...free.plans],
      ...free.rows.map((row) => [row.label, ...row.cells]),
      ["Source", ...free.sources.map((list) => list.map(sourceText).join("; "))],
    ]);
    const sourceCells = rows[rows.length - 1].slice(1);
    free.sources.forEach((list, n) => assert.deepStrictEqual(hrefsIn(sourceCells[n]), list.flatMap((source) => source.urls)));
  });

  it("prints every price change with its plan, old and new price, who pays it, the day it applies from, and its source linked", () => {
    const rows = tableRows(served.page, "accounting-price-changes");
    assert.deepStrictEqual(rows[0].map(cellText), ["Vendor", "Plan", "Old", "New", "Who pays it", "From", "Source"]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => row.map(cellText)),
      committed.price_changes.rows.map((row) => [row.vendor, row.plan, row.old, row.new, row.who, row.from, sourceText(row.source)]),
    );
    rows.slice(1).forEach((row, n) => assert.deepStrictEqual(hrefsIn(row[6]), committed.price_changes.rows[n].source.urls));
  });

  it("prints every current list price, then the introductory offers", () => {
    const rows = tableRows(served.page, "accounting-list-prices");
    assert.deepStrictEqual(rows[0].map(cellText), ["Vendor", "Plan", "Per month", "Notes"]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => row.map(cellText)),
      committed.list_prices.rows.map((row) => [row.vendor, row.plan, row.per_month, row.notes]),
    );
  });

  it("prints every payment processing fee", () => {
    const rows = tableRows(served.page, "accounting-payment-fees");
    assert.deepStrictEqual(rows[0].map(cellText), ["Vendor", "Card payments", "ACH bank payments"]);
    assert.deepStrictEqual(rows.slice(1).map((row) => row.map(cellText)), committed.payment_fees.rows.map((row) => [row.vendor, row.card, row.ach]));
  });

  it("prints the checked claim as written, each named span linked to the page that shows it", () => {
    const article = articleOf(served.page);
    const claim = article.slice(article.indexOf('<h2 id="checked-claim">'), article.indexOf('<h2 id="sources">'));
    assert.ok(prose(claim).endsWith(committed.checked_claim.text), prose(claim));
    for (const link of committed.checked_claim.links) {
      assert.ok(claim.includes(`<a href="${link.url}" target="_blank" rel="nofollow noopener">${link.text}</a>`), link.text);
    }
  });

  it("prints each vendor's sources, linked, with the day we read them", () => {
    const article = articleOf(served.page);
    const items = [...article.slice(article.indexOf('<ul class="accounting-sources">')).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, inner]) => inner);
    assert.strictEqual(items.length, committed.vendors.length);
    committed.vendors.forEach((vendor, n) => {
      assert.ok(prose(items[n]).startsWith(`${vendor.name}, read ${vendor.read_on}:`), prose(items[n]));
      assert.deepStrictEqual(hrefsIn(items[n]), vendor.sources.map((source) => source.url));
      for (const source of vendor.sources) assert.ok(cellText(items[n]).includes(`(${source.covers})`), source.covers);
      assert.strictEqual((items[n].match(/rel="nofollow noopener"/g) ?? []).length, vendor.sources.length);
    });
  });

  it("lists every page a table or the checked claim links among its vendor's sources", () => {
    const listed = new Set(committed.vendors.flatMap((vendor) => vendor.sources.map((source) => source.url)));
    assert.deepStrictEqual(accountingPageUrls(committed).filter((url: string) => !listed.has(url)), []);
  });

  it("prints no dollar amount, percentage or date that the data file does not hold", () => {
    const held = figuresTheFileHolds(committed);
    const printed = new Set(prose(articleOf(served.page)).match(FIGURE) ?? []);
    const inTheTables = stringsIn([
      committed.free_plans.rows,
      committed.price_changes.rows.map(({ source: _source, ...row }) => row),
      committed.list_prices.rows,
      committed.payment_fees.rows,
    ]).flatMap((text) => text.match(FIGURE) ?? []);
    assert.deepStrictEqual(inTheTables.filter((figure) => !printed.has(figure)), [], "figures the tables hold that this scan did not read off the page");
    assert.deepStrictEqual([...printed].filter((figure) => !held.has(figure)), []);
  });

  it("links no vendor page, /go/ address or sponsored page, and no page outside the data file", () => {
    const article = articleOf(served.page);
    const files = new Set(stringsIn(committed));
    assert.deepStrictEqual(hrefsIn(article).filter((href) => !files.has(href)), []);
    assert.doesNotMatch(served.page, /href="\/vendor\/|href="\/go\/|sponsored/);
  });

  it("is listed in the pages sitemap, on /guides and in /llms.txt", () => {
    assert.ok(served.sitemap.includes(`<loc>http://localhost${ROUTE}</loc>`), "not in /sitemap-pages.xml");
    assert.ok(served.guides.includes(`href="${ROUTE}"`), "not on /guides");
    assert.ok(served.llms.includes(`- [${committed.title}](http://localhost${ROUTE})`), "not in /llms.txt");
  });

  it("is dated by the page-dates ledger like every other page", () => {
    const ledger = JSON.parse(readFileSync(path.join(REPO, "data", "page-lastmod.json"), "utf8"));
    const entry = ledger.pages[ROUTE];
    assert.ok(entry, `${ROUTE} has no entry in data/page-lastmod.json`);
    assert.match(entry.hash, /^[0-9a-f]{16}$/);
    assert.match(entry.changed, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("states its headline, description and publication day in its JSON-LD", () => {
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd["@type"], "Article");
    assert.strictEqual(jsonLd.headline, committed.title);
    assert.strictEqual(jsonLd.description, committed.meta_description);
    assert.strictEqual(jsonLd.datePublished, committed.published);
  });
});

describe("the accounting software guide, built from another data file", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "accounting-prices-"));
  const file = path.join(scratch, "accounting_prices.json");
  const changed: AccountingPrices = JSON.parse(JSON.stringify(committed));
  changed.list_prices.rows[0] = { ...changed.list_prices.rows[0], per_month: "$4,321", notes: "a figure only this scratch file holds" };
  changed.vendors = changed.vendors.map((vendor, n) => ({ ...vendor, read_on: `2026-11-${String(20 + n).padStart(2, "0")}` }));
  changed.published = "2026-11-19";
  writeFileSync(file, JSON.stringify(changed));
  const served = servedFrom(file);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("prints that file's list price in place of the committed one", () => {
    const text = prose(articleOf(served.page));
    assert.ok(text.includes("$4,321 a figure only this scratch file holds"), "the changed list price is not printed");
    assert.ok(!text.includes(`${committed.list_prices.rows[0].per_month} ${committed.list_prices.rows[0].notes}`));
  });

  it("prints each vendor's own read day from that file", () => {
    const text = prose(articleOf(served.page));
    for (const vendor of changed.vendors) assert.ok(text.includes(`${vendor.name}, read ${vendor.read_on}:`), vendor.name);
  });

  it("states that file's publication day in the JSON-LD", () => {
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd.datePublished, "2026-11-19");
  });
});

describe("a data file the guide can be built from", () => {
  const variant = (change: (prices: AccountingPrices) => void) => {
    const prices: AccountingPrices = JSON.parse(JSON.stringify(committed));
    change(prices);
    return JSON.stringify(prices);
  };

  it("is the committed file", () => {
    assert.doesNotThrow(() => parseAccountingPrices(readFileSync(DATA_FILE, "utf8"), DATA_FILE));
  });

  it("is refused when a free plan row lacks a cell for a plan", () => {
    const text = variant((prices) => { prices.free_plans.rows[0].cells.pop(); });
    assert.throws(() => parseAccountingPrices(text, "scratch.json"), /^Error: scratch\.json free_plans\.rows\[0\] needs one cell for each of the 3 plans/);
  });

  it("is refused when a read day or the publication day is not a calendar day", () => {
    assert.throws(() => parseAccountingPrices(variant((prices) => { prices.vendors[1].read_on = "2026-02-30"; }), "scratch.json"), /vendors\[1\]\.read_on is not a calendar day/);
    assert.throws(() => parseAccountingPrices(variant((prices) => { prices.published = "10/08/2026"; }), "scratch.json"), /published is not a calendar day/);
  });

  it("is refused when a source gives several addresses that are not all Internet Archive captures", () => {
    const text = variant((prices) => { prices.price_changes.rows[0].source.urls.push("https://www.xero.com/us/pricing-plans/"); });
    assert.throws(() => parseAccountingPrices(text, "scratch.json"), /price_changes\.rows\[0\]\.source gives several addresses, which is allowed only for Internet Archive captures/);
  });

  it("is refused when a linked span is not words of the checked claim", () => {
    const text = variant((prices) => { prices.checked_claim.links[0].text = "March 2024"; });
    assert.throws(() => parseAccountingPrices(text, "scratch.json"), /checked_claim\.links\[0\]\.text is not words of checked_claim\.text/);
  });

  it("is refused when a source address is not https", () => {
    const text = variant((prices) => { prices.vendors[0].sources[0].url = "http://quickbooks.intuit.com/pricing/"; });
    assert.throws(() => parseAccountingPrices(text, "scratch.json"), /vendors\[0\]\.sources\[0\]\.url is not an https address/);
  });
});
