import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { centsFor, dollarsAndCents, formatCount, parseWhatsAppPrices, whatsAppPageUrls } = await import("../dist/whatsapp-prices.js");

type WhatsAppPrices = import("../src/whatsapp-prices.ts").WhatsAppPrices;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/whatsapp-business-api-pricing-2026";
const DATA_FILE = path.join(REPO, "data", "whatsapp_prices.json");
const committed: WhatsAppPrices = JSON.parse(readFileSync(DATA_FILE, "utf8"));

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

const unticked = (text: string) => text.replace(/`/g, "");

const articleOf = (page: string) => {
  const start = page.indexOf('<article class="whatsapp-guide">');
  const end = page.indexOf("</article>");
  assert.ok(start > -1 && end > start, "the page holds its guide in one article");
  return page.slice(start, end);
};

const tableRows = (page: string, tableClass: string) => {
  const table = articleOf(page).match(new RegExp(`<table class="pricing-table ${tableClass}">[\\s\\S]*?</table>`))?.[0] ?? "";
  assert.ok(table, `the page has no ${tableClass} table`);
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, inner]) => inner));
};

const tableText = (page: string, tableClass: string) => tableRows(page, tableClass).map((row) => row.map(cellText));

const labelledRows = (table: { columns: string[]; rows: { label: string; cells: string[] }[] }) =>
  [table.columns, ...table.rows.map((row) => [row.label, ...row.cells])].map((row) => row.map(unticked));

const hrefsIn = (html: string) => [...html.matchAll(/<a href="([^"]+)"/g)].map(([, href]) => decoded(href));

const linkedTextsIn = (html: string) => [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map(([, inner]) => cellText(inner));

const sectionOf = (page: string, id: string) => {
  const article = articleOf(page);
  const start = article.indexOf(`<h2 id="${id}">`);
  assert.ok(start > -1, `the page has no ${id} section`);
  const next = article.indexOf("<h2 ", start + 1);
  return article.slice(start, next > -1 ? next : undefined);
};

const filled = (prices: WhatsAppPrices, text: string) => {
  const charged = Math.max(0, prices.cost_example.replies - prices.free_service_messages_per_number);
  return text
    .replace(/\{replies\}/g, prices.cost_example.replies.toLocaleString("en-US"))
    .replace(/\{charged\}/g, charged.toLocaleString("en-US"))
    .replace(/\{free\}/g, prices.free_service_messages_per_number.toLocaleString("en-US"));
};

function expectedCost(prices: WhatsAppPrices, marketName: string): string {
  const market = prices.rates.markets.find((candidate) => candidate.name === marketName);
  assert.ok(market, `no market named ${marketName}`);
  const charged = Math.max(0, prices.cost_example.replies - prices.free_service_messages_per_number);
  const [whole, fraction = ""] = market.service.split(".");
  const cents = Math.round((charged * Number(`${whole}${fraction}`) * 100) / 10 ** fraction.length);
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const FIGURE = /\d{4}-\d{2}-\d{2}|\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?%|(?:January|February|March|April|May|June|July|August|September|October|November|December)(?: \d{1,2}\b)?(?:,? \d{4}\b)?|\d{1,3}(?:,\d{3})+|\d+/g;

const RATE_FIELDS = new Set(["marketing", "utility", "authentication", "service"]);

function proseStrings(value: unknown, key = ""): string[] {
  if (typeof value === "string") return RATE_FIELDS.has(key) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => proseStrings(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([field, item]) => proseStrings(item, field));
  return [];
}

function figuresComputedOrHeld(prices: WhatsAppPrices): Set<string> {
  const { cost_example: example, ...rest } = prices;
  const strings = [
    ...proseStrings(rest),
    ...proseStrings(example.rows),
    ...[example.heading, example.intro, ...example.columns].map((text) => filled(prices, text)),
  ];
  const rates = prices.rates.markets.flatMap((market) => [market.marketing, market.utility, market.authentication, market.service].map((rate) => `$${rate}`));
  const costs = prices.cost_example.rows.map((row) => expectedCost(prices, row.market));
  return new Set([...strings.flatMap((text) => text.match(FIGURE) ?? []), ...rates, ...costs]);
}

function servedFrom(dataFile: string | null) {
  const state = { page: "", status: 0, sitemap: "", guides: "", llms: "" };
  let server: ChildProcess | null = null;
  before(async () => {
    const { child, base } = await startServer(dataFile ? { AGENTDEALS_WHATSAPP_PRICES_PATH: dataFile } : {});
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

describe("the WhatsApp Business API pricing guide, built from data/whatsapp_prices.json", () => {
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

  it("prints the lead, the five sections, the deadline paragraph and the note in the draft's order", () => {
    const text = prose(articleOf(served.page));
    const fragments = [
      committed.lead,
      committed.read_line,
      committed.changes.heading,
      committed.changes.intro,
      committed.rates.heading,
      committed.rates.intro,
      committed.rates.note,
      filled(committed, committed.cost_example.heading),
      filled(committed, committed.cost_example.intro),
      committed.free_messages.heading,
      committed.deadlines.heading,
      committed.deadlines.text,
      committed.other_pages.heading,
      committed.other_pages.text,
      committed.other_pages.sources.text,
    ].map((fragment) => prose(unticked(fragment)));
    let from = 0;
    const missing = fragments.filter((fragment) => {
      const at = text.indexOf(fragment, from);
      if (at > -1) from = at + fragment.length;
      return at === -1;
    });
    assert.deepStrictEqual(missing, [], "fragments not found after the one before them");
    const tables = [...articleOf(served.page).matchAll(/<table class="pricing-table ([^"]+)">/g)].map(([, cls]) => cls);
    assert.deepStrictEqual(tables, ["whatsapp-changes", "whatsapp-rates", "whatsapp-business-agent", "whatsapp-cost-example", "whatsapp-free-messages", "whatsapp-pricing-calendar"]);
  });

  it("prints what changed with the file's columns and rows, each backticked name set as code", () => {
    assert.deepStrictEqual(tableText(served.page, "whatsapp-changes"), labelledRows(committed.changes));
    const codeIn = (html: string) => [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(([, inner]) => decoded(inner));
    const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map(([, inner]) => inner);
    assert.deepStrictEqual(
      tableRows(served.page, "whatsapp-changes").slice(1).map((row) => row.flatMap(codeIn)),
      committed.changes.rows.map((row) => [row.label, ...row.cells].flatMap(ticked)),
    );
    assert.ok(committed.changes.rows.some((row) => row.label.includes("`")), "no row names code, so this test read none");
    assert.doesNotMatch(articleOf(served.page), /`/);
  });

  it("prints one rate row for each market: its marketing rate, with its note, and the one rate utility, authentication and service share", () => {
    const rows = tableRows(served.page, "whatsapp-rates");
    assert.deepStrictEqual(rows[0].map(cellText), committed.rates.columns);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => row.map(cellText)),
      committed.rates.markets.map((market) => [
        market.name,
        market.marketing_note ? `$${market.marketing} (${market.marketing_note.text})` : `$${market.marketing}`,
        `$${market.service}`,
      ]),
    );
    committed.rates.markets.forEach((market, n) => {
      assert.deepStrictEqual(hrefsIn(rows[n + 1][1]), market.marketing_note?.links.map((link) => link.url) ?? []);
      assert.deepStrictEqual(linkedTextsIn(rows[n + 1][1]), market.marketing_note?.links.map((link) => link.text) ?? []);
    });
    assert.ok(committed.rates.markets.some((market) => market.marketing_note), "no market has a note, so this test read none");
  });

  it("prints the Meta Business Agent table and the rate card note after the market rates", () => {
    assert.deepStrictEqual(tableText(served.page, "whatsapp-business-agent"), labelledRows(committed.rates.business_agent));
    const rates = sectionOf(served.page, "rates");
    const after = rates.slice(rates.indexOf("</table>", rates.indexOf('<table class="pricing-table whatsapp-business-agent">')));
    assert.match(after, /^<\/table>\s*<\/div>\s*<p class="section-intro">[\s\S]*?<\/p>\s*$/);
    assert.strictEqual(cellText(after.match(/<p class="section-intro">([\s\S]*?)<\/p>/)?.[1] ?? ""), committed.rates.note);
  });

  it("computes each cost from the file: replies past the free allowance, times the market's service rate", () => {
    const rows = tableText(served.page, "whatsapp-cost-example");
    assert.deepStrictEqual(rows[0], committed.cost_example.columns.map((column) => filled(committed, column)));
    assert.deepStrictEqual(
      rows.slice(1),
      committed.cost_example.rows.map((row) => {
        const market = committed.rates.markets.find((candidate) => candidate.name === row.market);
        return [row.label, `$${market?.service}`, expectedCost(committed, row.market)];
      }),
    );
  });

  it("states the replies, the charged messages and the free allowance the costs are computed from", () => {
    const section = prose(sectionOf(served.page, "cost-example"));
    const charged = committed.cost_example.replies - committed.free_service_messages_per_number;
    assert.ok(section.startsWith(filled(committed, committed.cost_example.heading)), section);
    assert.ok(section.includes(filled(committed, committed.cost_example.intro)), section);
    for (const count of [committed.cost_example.replies, charged, committed.free_service_messages_per_number]) {
      assert.ok(section.includes(count.toLocaleString("en-US")), `${count} is not stated in the cost section`);
    }
    assert.doesNotMatch(articleOf(served.page), /\{[a-z_]+\}/);
  });

  it("prints the free messages table, the deadline paragraph and the pricing calendar as the file gives them", () => {
    assert.deepStrictEqual(tableText(served.page, "whatsapp-free-messages"), labelledRows(committed.free_messages));
    assert.deepStrictEqual(tableText(served.page, "whatsapp-pricing-calendar"), labelledRows(committed.deadlines.calendar));
    const deadlines = sectionOf(served.page, "deadlines");
    assert.strictEqual(cellText(deadlines.match(/<p class="section-intro">([\s\S]*?)<\/p>/)?.[1] ?? ""), committed.deadlines.text);
    assert.doesNotMatch(sectionOf(served.page, "free-messages"), /<p /);
  });

  it("prints the note on other pages and its sources line, each named page linked", () => {
    const section = sectionOf(served.page, "other-pages");
    const paragraphs = [...section.matchAll(/<p class="([^"]+)">([\s\S]*?)<\/p>/g)].map(([, cls, inner]) => [cls, inner]);
    assert.deepStrictEqual(paragraphs.map(([cls, inner]) => [cls, cellText(inner)]), [["section-intro", committed.other_pages.text], ["whatsapp-sources", committed.other_pages.sources.text]]);
    assert.deepStrictEqual(hrefsIn(paragraphs[1][1]), committed.other_pages.sources.links.map((link) => link.url));
    assert.deepStrictEqual(linkedTextsIn(paragraphs[1][1]), committed.other_pages.sources.links.map((link) => link.text));
  });

  it("keeps each day on the page on one line", () => {
    const article = articleOf(served.page);
    const kept = [...article.matchAll(/<span class="day">(\d{4}-\d{2}-\d{2})<\/span>/g)].map(([, day]) => day);
    const printed = prose(article).match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    assert.ok(printed.length > 10, `the page prints only ${printed.length} days`);
    assert.deepStrictEqual(kept, printed);
    assert.ok(served.page.includes(".whatsapp-guide .day{white-space:nowrap}"), "no rule keeps a day on one line");
  });

  it("prints no dollar amount, count or date that the data file does not hold or compute", () => {
    const allowed = figuresComputedOrHeld(committed);
    const printed = prose(articleOf(served.page)).match(FIGURE) ?? [];
    assert.deepStrictEqual(printed.filter((figure) => !allowed.has(figure)), []);
    const dollarsPrinted = new Set(printed.filter((figure) => figure.startsWith("$")));
    const inTheTables = [
      ...committed.rates.markets.flatMap((market) => [`$${market.marketing}`, `$${market.service}`]),
      ...committed.cost_example.rows.map((row) => expectedCost(committed, row.market)),
    ];
    assert.deepStrictEqual(inTheTables.filter((figure) => !dollarsPrinted.has(figure)), [], "amounts the tables hold that this scan did not read off the page");
  });

  it("links only the pages the data file names, each as a citation in a new tab, and no vendor page, /go/ address or sponsored page", () => {
    const article = articleOf(served.page);
    assert.deepStrictEqual(hrefsIn(article), whatsAppPageUrls(committed));
    const anchors = article.match(/<a [^>]*>/g) ?? [];
    assert.ok(anchors.length > 0);
    assert.deepStrictEqual(anchors.filter((anchor) => !/ target="_blank" rel="nofollow noopener"/.test(anchor)), []);
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

describe("the WhatsApp Business API pricing guide, built from another data file", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "whatsapp-prices-"));
  const file = path.join(scratch, "whatsapp_prices.json");
  const changed: WhatsAppPrices = JSON.parse(JSON.stringify(committed));
  const northAmerica = changed.cost_example.rows[0].market;
  const germany = changed.rates.markets.find((market) => market.name === "Germany");
  assert.ok(germany, "the committed file lists no Germany");
  changed.rates.markets = changed.rates.markets.map((market) =>
    market.name === northAmerica ? { ...market, utility: "0.0041", authentication: "0.0041", service: "0.0041" } : market);
  changed.rates.markets.push({ name: "A market only this scratch file holds", marketing: "0.0999", utility: "0.0111", authentication: "0.0111", service: "0.0111" });
  changed.free_service_messages_per_number = 250;
  changed.cost_example.replies = 25000;
  changed.cost_example.rows = [{ label: "Users in the scratch market", market: "A market only this scratch file holds" }, ...changed.cost_example.rows];
  changed.published = "2026-11-19";
  writeFileSync(file, JSON.stringify(changed));
  const served = servedFrom(file);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("prints that file's rates, and a row for the market it adds", () => {
    const rows = tableText(served.page, "whatsapp-rates");
    assert.deepStrictEqual(rows.find((row) => row[0] === northAmerica)?.[2], "$0.0041");
    assert.deepStrictEqual(rows[rows.length - 1], ["A market only this scratch file holds", "$0.0999", "$0.0111"]);
  });

  it("computes its costs from that file's allowance, replies and rates, to the cent", () => {
    const rows = tableText(served.page, "whatsapp-cost-example");
    assert.deepStrictEqual(rows[0], ["Users in", "Service rate", "25,000 replies a month"]);
    assert.deepStrictEqual(rows[1], ["Users in the scratch market", "$0.0111", "$274.73"]);
    assert.deepStrictEqual(rows[2], ["United States or Canada", "$0.0041", "$101.48"]);
    assert.deepStrictEqual(rows.find((row) => row[0] === "Germany"), ["Germany", "$0.055", "$1,361.25"]);
  });

  it("states that file's replies, charged messages and allowance in the cost section", () => {
    const section = prose(sectionOf(served.page, "cost-example"));
    assert.ok(section.startsWith("What 25,000 replies a month cost"), section);
    assert.ok(section.includes("The table counts 24,750 charged messages after the 250 free ones"), section);
  });

  it("states that file's publication day in the JSON-LD", () => {
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd.datePublished, "2026-11-19");
  });
});

describe("the cost arithmetic", () => {
  it("multiplies a message count by a rate exactly, rounding half a cent up", () => {
    assert.strictEqual(centsFor(9000, "0.0034"), 3060n);
    assert.strictEqual(centsFor(24750, "0.0041"), 10148n);
    assert.strictEqual(centsFor(1, "0.005"), 1n);
    assert.strictEqual(centsFor(1, "0.0049"), 0n);
    assert.strictEqual(centsFor(0, "0.1365"), 0n);
    assert.strictEqual(centsFor(3, "2"), 600n);
  });

  it("writes dollars and cents with thousands separated", () => {
    assert.strictEqual(dollarsAndCents(3060n), "$30.60");
    assert.strictEqual(dollarsAndCents(19800n), "$198.00");
    assert.strictEqual(dollarsAndCents(136125n), "$1,361.25");
    assert.strictEqual(dollarsAndCents(5n), "$0.05");
    assert.strictEqual(formatCount(1000), "1,000");
    assert.strictEqual(formatCount(999), "999");
    assert.strictEqual(formatCount(1234567), "1,234,567");
  });
});

describe("a data file the WhatsApp Business API pricing guide can be built from", () => {
  const variant = (change: (prices: WhatsAppPrices) => void) => {
    const prices: WhatsAppPrices = JSON.parse(JSON.stringify(committed));
    change(prices);
    return JSON.stringify(prices);
  };
  const refused = (change: (prices: WhatsAppPrices) => void, problem: RegExp) =>
    assert.throws(() => parseWhatsAppPrices(variant(change), "scratch.json"), problem);

  it("is the committed file", () => {
    assert.doesNotThrow(() => parseWhatsAppPrices(readFileSync(DATA_FILE, "utf8"), DATA_FILE));
  });

  it("is refused when a rate is not a plain dollar figure", () => {
    refused((prices) => { prices.rates.markets[1].marketing = "$0.0118"; }, /^Error: scratch\.json rates\.markets\[1\]\.marketing is not a rate in dollars/);
    refused((prices) => { prices.rates.markets[2].service = "0,0068"; }, /rates\.markets\[2\]\.service is not a rate in dollars/);
  });

  it("is refused when utility, authentication and service differ, since the table prints one rate for all three", () => {
    refused((prices) => { prices.rates.markets[3].authentication = "0.0086"; }, /rates\.markets\[3\] gives utility, authentication and service different rates/);
  });

  it("is refused when a market is listed twice", () => {
    refused((prices) => { prices.rates.markets.push({ ...prices.rates.markets[4] }); }, /repeats the market/);
  });

  it("is refused when the free allowance or the replies are not a whole number", () => {
    refused((prices) => { (prices as { free_service_messages_per_number: unknown }).free_service_messages_per_number = "1,000"; }, /free_service_messages_per_number is not a whole number/);
    refused((prices) => { prices.cost_example.replies = 10000.5; }, /cost_example\.replies is not a whole number/);
  });

  it("is refused when a cost row names a market the rates table does not list", () => {
    refused((prices) => { prices.cost_example.rows[1].market = "Atlantis"; }, /cost_example\.rows\[1\]\.market names no market in rates\.markets/);
  });

  it("is refused when the cost section asks for a figure it does not compute, or another section asks for one", () => {
    refused((prices) => { prices.cost_example.intro = "The table counts {monthly} messages."; }, /cost_example\.intro asks for \{monthly\}/);
    refused((prices) => { prices.lead = "Each number gets {free} free service messages."; }, /lead holds a \{figure\}/);
  });

  it("is refused when a backtick opens a code span it does not close", () => {
    refused((prices) => { prices.changes.rows[3].cells[0] = "`free_customer_service"; }, /changes\.rows\[3\]\.cells\[0\] opens a code span it does not close/);
  });

  it("is refused when a note's linked words are not its words, or the sources line links no page", () => {
    refused((prices) => { prices.rates.markets[0].marketing_note!.links[0].text = "US numbers are not delivered"; }, /rates\.markets\[0\]\.marketing_note\.links\[0\]\.text is not words of/);
    refused((prices) => { prices.other_pages.sources.links = []; }, /other_pages\.sources\.links is empty/);
  });

  it("is refused when a key-value table row lacks its cell, and accepts a blank second heading", () => {
    refused((prices) => { prices.rates.business_agent.rows[1].cells.pop(); }, /rates\.business_agent\.rows\[1\] needs one cell for each of the 1 columns after the first/);
    assert.strictEqual(committed.deadlines.calendar.columns[1], "");
    refused((prices) => { prices.deadlines.calendar.columns[0] = ""; }, /deadlines\.calendar\.columns\[0\] is missing/);
  });

  it("is refused when the publication day is not a calendar day", () => {
    refused((prices) => { prices.published = "2026-02-30"; }, /published is not a calendar day/);
  });
});
