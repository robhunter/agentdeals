import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { companyFormationPageUrls, parseCompanyFormationPrices } = await import("../dist/company-formation-prices.js");
const { archiveCaptureDate } = await import("../dist/guide-data.js");

type CompanyFormationPrices = import("../src/company-formation-prices.ts").CompanyFormationPrices;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/company-formation-pricing-2026";
const DATA_FILE = path.join(REPO, "data", "company_formation_prices.json");
const committed: CompanyFormationPrices = JSON.parse(readFileSync(DATA_FILE, "utf8"));

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
  const start = page.indexOf('<article class="formation-guide">');
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

const linkedTextsIn = (html: string) => [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map(([, inner]) => cellText(inner));

const sourceItems = (page: string) => {
  const article = articleOf(page);
  return [...article.slice(article.indexOf('<ul class="formation-sources">')).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, inner]) => inner);
};

const FIGURE = /\d{4}-\d{2}-\d{2}|\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?%|\d+¢|(?:January|February|March|April|May|June|July|August|September|October|November|December)(?: \d{1,2}\b)?(?:,? \d{4}\b)?|\b(?:19|20)\d{2}\b/g;

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function figuresTheFileHolds(prices: CompanyFormationPrices): Set<string> {
  const strings = stringsIn(prices);
  const captureDays = strings.map((text) => archiveCaptureDate(text)).filter((day): day is string => day !== null);
  return new Set([...strings.flatMap((text) => text.match(FIGURE) ?? []), ...captureDays]);
}

function servedFrom(dataFile: string | null) {
  const state = { page: "", status: 0, sitemap: "", guides: "", llms: "" };
  let server: ChildProcess | null = null;
  before(async () => {
    const { child, base } = await startServer(dataFile ? { AGENTDEALS_COMPANY_FORMATION_PRICES_PATH: dataFile } : {});
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

describe("the company formation guide, built from data/company_formation_prices.json", () => {
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

  it("prints the lead, the read line, the three tables, the checked claim and the sources in the draft's order", () => {
    const article = articleOf(served.page);
    const text = prose(article);
    const order = [
      committed.lead,
      committed.read_line,
      committed.services.heading,
      committed.services.intro,
      committed.services.note,
      committed.changes.heading,
      committed.changes.intro,
      committed.delaware_costs.heading,
      committed.delaware_costs.intro,
      committed.checked_claim.heading,
      committed.checked_claim.text,
      "Sources",
    ].map((fragment) => text.indexOf(prose(fragment)));
    assert.ok(order.every((at) => at > -1), JSON.stringify(order));
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
    const tables = [...article.matchAll(/<table class="pricing-table ([^"]+)">/g)].map(([, cls]) => cls);
    assert.deepStrictEqual(tables, ["formation-services", "formation-changes", "formation-delaware-costs"]);
  });

  it("prints the formation services table with the file's columns and a row for each package", () => {
    const rows = tableRows(served.page, "formation-services");
    const services = committed.services;
    assert.deepStrictEqual(rows.map((row) => row.map(cellText)), [services.columns, ...services.rows.map((row) => [row.label, ...row.cells])]);
  });

  it("prints the services note directly after the formation services table", () => {
    const article = articleOf(served.page);
    const after = article.slice(article.indexOf("</table>", article.indexOf('<table class="pricing-table formation-services">')));
    assert.match(after, /^<\/table>\s*<\/div>\s*<p class="section-intro">([^<]*)<\/p>/);
    assert.strictEqual(cellText(after.match(/<p class="section-intro">([^<]*)<\/p>/)?.[1] ?? ""), committed.services.note);
  });

  it("prints every change with what changed, the terms before and after, when, and its source with each named span linked", () => {
    const rows = tableRows(served.page, "formation-changes");
    assert.deepStrictEqual(rows[0].map(cellText), ["Who", "What changed", "Before", "After", "When", "Source"]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => row.map(cellText)),
      committed.changes.rows.map((row) => [row.who, row.change, row.before, row.after, row.when, row.source.text]),
    );
    rows.slice(1).forEach((row, n) => {
      const source = committed.changes.rows[n].source;
      assert.deepStrictEqual(hrefsIn(row[5]), source.links.map((link) => link.url));
      assert.deepStrictEqual(linkedTextsIn(row[5]), source.links.map((link) => link.text));
    });
  });

  it("prints Delaware's state costs with the file's columns and a row for each item", () => {
    const rows = tableRows(served.page, "formation-delaware-costs");
    const costs = committed.delaware_costs;
    assert.deepStrictEqual(rows.map((row) => row.map(cellText)), [costs.columns, ...costs.rows.map((row) => [row.label, ...row.cells])]);
  });

  it("prints the checked claim as written, each named span linked to the page that shows it", () => {
    const article = articleOf(served.page);
    const claim = article.slice(article.indexOf('<h2 id="checked-claim">'), article.indexOf('<h2 id="sources">'));
    assert.ok(prose(claim).endsWith(committed.checked_claim.text), prose(claim));
    assert.deepStrictEqual(hrefsIn(claim), committed.checked_claim.links.map((link) => link.url));
    assert.deepStrictEqual(linkedTextsIn(claim), committed.checked_claim.links.map((link) => link.text));
  });

  it("prints each source's pages, linked, with the day we read them and each page's note where it has one", () => {
    const items = sourceItems(served.page);
    assert.strictEqual(items.length, committed.sources.length);
    committed.sources.forEach((source, n) => {
      assert.deepStrictEqual(hrefsIn(items[n]), source.sources.map((page) => page.url));
      const linkTexts = linkedTextsIn(items[n]);
      const expected = `${source.name}, read ${source.read_on}: ${source.sources.map((page, m) => `${linkTexts[m]}${page.covers ? ` (${page.covers})` : ""}`).join("; ")}`;
      assert.strictEqual(prose(items[n]), expected);
      assert.strictEqual((items[n].match(/rel="nofollow noopener"/g) ?? []).length, source.sources.length);
    });
    assert.ok(committed.sources.some((source) => source.sources.some((page) => page.covers === "")), "no page without a note, so this test read none");
  });

  it("keeps each day in the tables and the source list on one line", () => {
    const article = articleOf(served.page);
    const regions = [
      ...[...article.matchAll(/<table class="pricing-table [^"]+">[\s\S]*?<\/table>/g)].map(([table]) => table),
      article.slice(article.indexOf('<ul class="formation-sources">')),
    ];
    const kept = regions.flatMap((html) => [...html.matchAll(/<span class="day">(\d{4}-\d{2}-\d{2})<\/span>/g)].map(([, day]) => day));
    const printed = regions.flatMap((html) => prose(html).match(/\d{4}-\d{2}-\d{2}/g) ?? []);
    assert.ok(printed.length > 0, "the tables and the source list print no day");
    assert.deepStrictEqual(kept, printed);
    assert.ok(served.page.includes(".formation-guide .day{white-space:nowrap}"), "no rule keeps a day on one line");
  });

  it("lists every page a change row links among its own source's pages, and the claim's among some source's", () => {
    const pagesOf = new Map(committed.sources.map((source) => [source.name, new Set(source.sources.map((page) => page.url))]));
    const unlisted = committed.changes.rows.flatMap((row) =>
      row.source.links.filter((link) => !pagesOf.get(row.who)?.has(link.url)).map((link) => `${row.who}: ${link.url}`));
    assert.deepStrictEqual(unlisted, []);
    const listed = new Set(committed.sources.flatMap((source) => source.sources.map((page) => page.url)));
    assert.deepStrictEqual(companyFormationPageUrls(committed).filter((url: string) => !listed.has(url)), []);
  });

  it("prints no dollar amount, percentage, date or year that the data file does not hold", () => {
    const held = figuresTheFileHolds(committed);
    const printed = new Set(prose(articleOf(served.page)).match(FIGURE) ?? []);
    const inTheTables = stringsIn([
      committed.services.rows,
      committed.changes.rows.map(({ source, ...row }) => [row, source.text]),
      committed.delaware_costs.rows,
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

describe("the company formation guide, built from another data file", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "company-formation-prices-"));
  const file = path.join(scratch, "company_formation_prices.json");
  const changed: CompanyFormationPrices = JSON.parse(JSON.stringify(committed));
  changed.services.rows[0] = { ...changed.services.rows[0], cells: changed.services.rows[0].cells.map((cell, n) => (n === 1 ? "$4,321 one-time, a figure only this scratch file holds" : cell)) };
  changed.services.note = "A services note only this scratch file holds.";
  changed.delaware_costs.columns.push("LP");
  changed.delaware_costs.rows.forEach((row, n) => row.cells.push(`partnership ${n}`));
  changed.sources = changed.sources.map((source, n) => ({ ...source, read_on: `2026-11-${String(20 + n).padStart(2, "0")}` }));
  changed.published = "2026-11-19";
  writeFileSync(file, JSON.stringify(changed));
  const served = servedFrom(file);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("prints that file's price in place of the committed one", () => {
    const row = tableRows(served.page, "formation-services")[1];
    assert.strictEqual(cellText(row[2]), "$4,321 one-time, a figure only this scratch file holds");
    assert.ok(!prose(articleOf(served.page)).includes(committed.services.rows[0].cells[1]));
  });

  it("prints that file's services note", () => {
    assert.ok(prose(articleOf(served.page)).includes("A services note only this scratch file holds."));
    assert.ok(!prose(articleOf(served.page)).includes(committed.services.note));
  });

  it("prints a column that file adds to Delaware's state costs", () => {
    const rows = tableRows(served.page, "formation-delaware-costs");
    assert.deepStrictEqual(rows.map((row) => cellText(row[row.length - 1])), ["LP", ...changed.delaware_costs.rows.map((_, n) => `partnership ${n}`)]);
  });

  it("prints each source's own read day from that file", () => {
    const items = sourceItems(served.page);
    changed.sources.forEach((source, n) => assert.ok(prose(items[n]).startsWith(`${source.name}, read ${source.read_on}:`), source.name));
  });

  it("states that file's publication day in the JSON-LD", () => {
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd.datePublished, "2026-11-19");
  });
});

describe("a data file the company formation guide can be built from", () => {
  const variant = (change: (prices: CompanyFormationPrices) => void) => {
    const prices: CompanyFormationPrices = JSON.parse(JSON.stringify(committed));
    change(prices);
    return JSON.stringify(prices);
  };

  it("is the committed file", () => {
    assert.doesNotThrow(() => parseCompanyFormationPrices(readFileSync(DATA_FILE, "utf8"), DATA_FILE));
  });

  it("is refused when a services row or a Delaware cost row lacks a cell for a column", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.services.rows[4].cells.pop(); }), "scratch.json"), /^Error: scratch\.json services\.rows\[4\] needs one cell for each of the 6 columns after the first/);
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.delaware_costs.rows[1].cells.pop(); }), "scratch.json"), /delaware_costs\.rows\[1\] needs one cell for each of the 2 columns after the first/);
  });

  it("is refused when the services note is missing", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { delete (prices.services as { note?: string }).note; }), "scratch.json"), /services\.note is missing/);
  });

  it("is refused when a read day or the publication day is not a calendar day", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.sources[7].read_on = "2026-02-30"; }), "scratch.json"), /sources\[7\]\.read_on is not a calendar day/);
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.published = "10/08/2026"; }), "scratch.json"), /published is not a calendar day/);
  });

  it("is refused when a change's linked words are missing or out of reading order", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.changes.rows[3].source.links[1].text = "stripe.com/billing"; }), "scratch.json"), /changes\.rows\[3\]\.source\.links\[1\]\.text is not words of changes\.rows\[3\]\.source\.text/);
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.changes.rows[6].source.links.reverse(); }), "scratch.json"), /changes\.rows\[6\]\.source\.links\[1\]\.text does not come after the words linked before it/);
  });

  it("is refused when a change cites no page", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.changes.rows[1].source.links = []; }), "scratch.json"), /changes\.rows\[1\]\.source\.links is empty/);
  });

  it("is refused when a source page has no note field, and accepts an empty one", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { delete (prices.sources[0].sources[0] as { covers?: string }).covers; }), "scratch.json"), /sources\[0\]\.sources\[0\]\.covers is missing/);
    assert.doesNotThrow(() => parseCompanyFormationPrices(variant((prices) => { prices.sources[0].sources[0].covers = ""; }), "scratch.json"));
  });

  it("is refused when a source address is not https", () => {
    assert.throws(() => parseCompanyFormationPrices(variant((prices) => { prices.sources[1].sources[0].url = "http://www.clerky.com/pricing"; }), "scratch.json"), /sources\[1\]\.sources\[0\]\.url is not an https address/);
  });
});
