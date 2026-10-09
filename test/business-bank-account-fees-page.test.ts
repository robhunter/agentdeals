import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { bankingPageUrls, parseBankingFees } = await import("../dist/banking-fees.js");
const { archiveCaptureDate } = await import("../dist/guide-data.js");

type BankingFees = import("../src/banking-fees.ts").BankingFees;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/business-bank-account-fees-2026";
const DATA_FILE = path.join(REPO, "data", "banking_fees.json");
const committed: BankingFees = JSON.parse(readFileSync(DATA_FILE, "utf8"));

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
  const start = page.indexOf('<article class="banking-guide">');
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

const FIGURE = /\d{4}-\d{2}-\d{2}|\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?%|\d+¢|(?:January|February|March|April|May|June|July|August|September|October|November|December)(?: \d{1,2}\b)?(?:,? \d{4}\b)?|\b(?:19|20)\d{2}\b/g;

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function figuresTheFileHolds(fees: BankingFees): Set<string> {
  const strings = stringsIn(fees);
  const captureDays = strings.map((text) => archiveCaptureDate(text)).filter((day): day is string => day !== null);
  return new Set([...strings.flatMap((text) => text.match(FIGURE) ?? []), ...captureDays]);
}

function servedFrom(dataFile: string | null) {
  const state = { page: "", status: 0, sitemap: "", guides: "", llms: "" };
  let server: ChildProcess | null = null;
  before(async () => {
    const { child, base } = await startServer(dataFile ? { AGENTDEALS_BANKING_FEES_PATH: dataFile } : {});
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

describe("the business bank account guide, built from data/banking_fees.json", () => {
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
      committed.free_accounts.heading,
      committed.free_accounts.intro,
      committed.changes.heading,
      committed.changes.intro,
      committed.paid_plans.heading,
      committed.paid_plans.intro,
      committed.checked_claim.heading,
      committed.checked_claim.text,
      "Sources",
    ].map((fragment) => text.indexOf(prose(fragment)));
    assert.ok(order.every((at) => at > -1), JSON.stringify(order));
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
    const tables = [...article.matchAll(/<table class="pricing-table ([^"]+)">/g)].map(([, cls]) => cls);
    assert.deepStrictEqual(tables, ["banking-free-accounts", "banking-changes", "banking-paid-plans"]);
  });

  it("prints the free accounts table with the file's columns and a row for each account", () => {
    const rows = tableRows(served.page, "banking-free-accounts");
    const free = committed.free_accounts;
    assert.deepStrictEqual(rows.map((row) => row.map(cellText)), [free.columns, ...free.rows.map((row) => [row.label, ...row.cells])]);
  });

  it("prints every change with what changed, the terms before and after, when, and its source with each named span linked", () => {
    const rows = tableRows(served.page, "banking-changes");
    assert.deepStrictEqual(rows[0].map(cellText), ["Bank", "What changed", "Before", "After", "When", "Source"]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => row.map(cellText)),
      committed.changes.rows.map((row) => [row.bank, row.change, row.before, row.after, row.when, row.source.text]),
    );
    rows.slice(1).forEach((row, n) => {
      const source = committed.changes.rows[n].source;
      assert.deepStrictEqual(hrefsIn(row[5]), source.links.map((link) => link.url));
      assert.deepStrictEqual(linkedTextsIn(row[5]), source.links.map((link) => link.text));
    });
  });

  it("prints every paid plan with its monthly price and notes", () => {
    const rows = tableRows(served.page, "banking-paid-plans");
    assert.deepStrictEqual(rows[0].map(cellText), ["Bank", "Plan", "Per month", "Notes"]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => row.map(cellText)),
      committed.paid_plans.rows.map((row) => [row.bank, row.plan, row.per_month, row.notes]),
    );
  });

  it("prints the checked claim as written, each named span linked to the page that shows it", () => {
    const article = articleOf(served.page);
    const claim = article.slice(article.indexOf('<h2 id="checked-claim">'), article.indexOf('<h2 id="sources">'));
    assert.ok(prose(claim).endsWith(committed.checked_claim.text), prose(claim));
    assert.deepStrictEqual(hrefsIn(claim), committed.checked_claim.links.map((link) => link.url));
    assert.deepStrictEqual(linkedTextsIn(claim), committed.checked_claim.links.map((link) => link.text));
  });

  it("prints each bank's sources, linked, with the day we read them", () => {
    const article = articleOf(served.page);
    const items = [...article.slice(article.indexOf('<ul class="banking-sources">')).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, inner]) => inner);
    assert.strictEqual(items.length, committed.banks.length);
    committed.banks.forEach((bank, n) => {
      assert.ok(prose(items[n]).startsWith(`${bank.name}, read ${bank.read_on}:`), prose(items[n]));
      assert.deepStrictEqual(hrefsIn(items[n]), bank.sources.map((source) => source.url));
      for (const source of bank.sources) assert.ok(cellText(items[n]).includes(`(${source.covers})`), source.covers);
      assert.strictEqual((items[n].match(/rel="nofollow noopener"/g) ?? []).length, bank.sources.length);
    });
  });

  it("keeps each day in the tables and the source list on one line", () => {
    const article = articleOf(served.page);
    const regions = [
      ...[...article.matchAll(/<table class="pricing-table [^"]+">[\s\S]*?<\/table>/g)].map(([table]) => table),
      article.slice(article.indexOf('<ul class="banking-sources">')),
    ];
    const kept = regions.flatMap((html) => [...html.matchAll(/<span class="day">(\d{4}-\d{2}-\d{2})<\/span>/g)].map(([, day]) => day));
    const printed = regions.flatMap((html) => prose(html).match(/\d{4}-\d{2}-\d{2}/g) ?? []);
    assert.ok(printed.length > 0, "the tables and the source list print no day");
    assert.deepStrictEqual(kept, printed);
    assert.ok(served.page.includes(".banking-guide .day{white-space:nowrap}"), "no rule keeps a day on one line");
  });

  it("lists every page a change row links among that bank's own sources, and the claim's among some bank's", () => {
    const sourcesOf = new Map(committed.banks.map((bank) => [bank.name, new Set(bank.sources.map((source) => source.url))]));
    const unlisted = committed.changes.rows.flatMap((row) =>
      row.source.links.filter((link) => !sourcesOf.get(row.bank)?.has(link.url)).map((link) => `${row.bank}: ${link.url}`));
    assert.deepStrictEqual(unlisted, []);
    const listed = new Set(committed.banks.flatMap((bank) => bank.sources.map((source) => source.url)));
    assert.deepStrictEqual(bankingPageUrls(committed).filter((url: string) => !listed.has(url)), []);
  });

  it("prints no dollar amount, percentage, date or year that the data file does not hold", () => {
    const held = figuresTheFileHolds(committed);
    const printed = new Set(prose(articleOf(served.page)).match(FIGURE) ?? []);
    const inTheTables = stringsIn([
      committed.free_accounts.rows,
      committed.changes.rows.map(({ source, ...row }) => [row, source.text]),
      committed.paid_plans.rows,
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

describe("the business bank account guide, built from another data file", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "banking-fees-"));
  const file = path.join(scratch, "banking_fees.json");
  const changed: BankingFees = JSON.parse(JSON.stringify(committed));
  changed.paid_plans.rows[0] = { ...changed.paid_plans.rows[0], per_month: "$4,321", notes: "a figure only this scratch file holds" };
  changed.free_accounts.columns.push("Overdraft");
  changed.free_accounts.rows.forEach((row, n) => row.cells.push(`overdraft ${n}`));
  changed.changes.rows[0].source = {
    text: "docs.example.com/scratch/terms; example.com/scratch",
    links: [{ text: "docs.example.com/scratch/terms", url: "https://docs.example.com/scratch/terms" }, { text: "example.com/scratch", url: "https://example.com/scratch" }],
  };
  changed.banks = changed.banks.map((bank, n) => ({ ...bank, read_on: `2026-11-${String(20 + n).padStart(2, "0")}` }));
  changed.published = "2026-11-19";
  writeFileSync(file, JSON.stringify(changed));
  const served = servedFrom(file);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("prints that file's paid plan price in place of the committed one", () => {
    const text = prose(articleOf(served.page));
    assert.ok(text.includes("$4,321 a figure only this scratch file holds"), "the changed paid plan price is not printed");
    assert.ok(!text.includes(`${committed.paid_plans.rows[0].per_month} ${committed.paid_plans.rows[0].notes}`));
  });

  it("prints a column that file adds to the free accounts table", () => {
    const rows = tableRows(served.page, "banking-free-accounts");
    assert.deepStrictEqual(rows.map((row) => cellText(row[row.length - 1])), ["Overdraft", ...changed.free_accounts.rows.map((_, n) => `overdraft ${n}`)]);
  });

  it("prints that file's source for a change, each link on its words in reading order, even where those words occur earlier inside another link's", () => {
    const row = tableRows(served.page, "banking-changes")[1];
    assert.strictEqual(cellText(row[5]), "docs.example.com/scratch/terms; example.com/scratch");
    assert.deepStrictEqual(hrefsIn(row[5]), ["https://docs.example.com/scratch/terms", "https://example.com/scratch"]);
    assert.deepStrictEqual(linkedTextsIn(row[5]), ["docs.example.com/scratch/terms", "example.com/scratch"]);
  });

  it("prints each bank's own read day from that file", () => {
    const text = prose(articleOf(served.page));
    for (const bank of changed.banks) assert.ok(text.includes(`${bank.name}, read ${bank.read_on}:`), bank.name);
  });

  it("states that file's publication day in the JSON-LD", () => {
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd.datePublished, "2026-11-19");
  });
});

describe("a data file the business bank account guide can be built from", () => {
  const variant = (change: (fees: BankingFees) => void) => {
    const fees: BankingFees = JSON.parse(JSON.stringify(committed));
    change(fees);
    return JSON.stringify(fees);
  };

  it("is the committed file", () => {
    assert.doesNotThrow(() => parseBankingFees(readFileSync(DATA_FILE, "utf8"), DATA_FILE));
  });

  it("is refused when a free account row lacks a cell for a column", () => {
    const text = variant((fees) => { fees.free_accounts.rows[2].cells.pop(); });
    assert.throws(() => parseBankingFees(text, "scratch.json"), /^Error: scratch\.json free_accounts\.rows\[2\] needs one cell for each of the 5 columns after the first/);
  });

  it("is refused when a read day or the publication day is not a calendar day", () => {
    assert.throws(() => parseBankingFees(variant((fees) => { fees.banks[1].read_on = "2026-02-30"; }), "scratch.json"), /banks\[1\]\.read_on is not a calendar day/);
    assert.throws(() => parseBankingFees(variant((fees) => { fees.published = "10/08/2026"; }), "scratch.json"), /published is not a calendar day/);
  });

  it("is refused when a change's source links words it does not contain", () => {
    const text = variant((fees) => { fees.changes.rows[0].source.links[0].text = "2024-01-01"; });
    assert.throws(() => parseBankingFees(text, "scratch.json"), /changes\.rows\[0\]\.source\.links\[0\]\.text is not words of changes\.rows\[0\]\.source\.text/);
  });

  it("is refused when a change's linked words are not in reading order", () => {
    const text = variant((fees) => { fees.changes.rows[0].source.links.reverse(); });
    assert.throws(() => parseBankingFees(text, "scratch.json"), /changes\.rows\[0\]\.source\.links\[1\]\.text does not come after the words linked before it in changes\.rows\[0\]\.source\.text/);
  });

  it("is refused when a change cites no page", () => {
    const text = variant((fees) => { fees.changes.rows[3].source.links = []; });
    assert.throws(() => parseBankingFees(text, "scratch.json"), /changes\.rows\[3\]\.source\.links is empty/);
  });

  it("is refused when a source address is not https", () => {
    assert.throws(() => parseBankingFees(variant((fees) => { fees.banks[0].sources[0].url = "http://mercury.com/pricing"; }), "scratch.json"), /banks\[0\]\.sources\[0\]\.url is not an https address/);
    assert.throws(() => parseBankingFees(variant((fees) => { fees.checked_claim.links[0].url = "relayfi.com/pricing/"; }), "scratch.json"), /checked_claim\.links\[0\]\.url is not an https address/);
  });
});
