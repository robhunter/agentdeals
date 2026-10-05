import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;
type ListingCondition = import("../src/types.ts").ListingCondition;
type CardItem = Pick<Offer, "vendor" | "tier" | "description" | "conditions"> & { terms_superseded?: unknown };

const { conditionsHtmlBesidePublishedTerms } = await import("../dist/listing-conditions.js");
const { offerRetired } = await import("../dist/retirement.js");
const { quotesTheStoredTermsAsPrevious, supersededTermsRecordFor, supersedingChange } = await import("../dist/superseded-description.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const storedChanges = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
const changeLog: DealChange[] = storedChanges.changes;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function codeFor(index: number): string {
  return LETTERS[Math.floor(index / 676) % 26]! + LETTERS[Math.floor(index / 26) % 26]! + LETTERS[index % 26]!;
}

const ANY_TOKEN = /Zqk[a-z]{3}[12]\b/g;

function conditionNaming(token: string): ListingCondition {
  return {
    text: `The free plan carries condition ${token} & "quoted" <terms>.`,
    quote: `Condition ${token} applies.`,
    url: `https://www.conditions.example/terms?plan=free&use="any"`,
    read_on: TODAY,
  };
}

const scratchOffers: Offer[] = catalogue.offers.map((offer: Offer, index: number) => {
  const code = codeFor(index);
  const conditions = [conditionNaming(`Zqk${code}1`)];
  if (index % 5 === 0) conditions.push(conditionNaming(`Zqk${code}2`));
  return { ...offer, conditions };
});

const dir = mkdtempSync(path.join(tmpdir(), "conditions-on-client-cards-"));
const indexPath = path.join(dir, "index.json");
writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers: scratchOffers }));

let server: ChildProcess;
let base = "";

function startServer(env: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath, ...env },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

before(async () => {
  ({ child: server, base } = await startServer());
});
after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function body(route: string): Promise<string> {
  const response = await fetch(`${base}${route}`);
  assert.strictEqual(response.status, 200, route);
  return response.text();
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs!) && !/type\s*=\s*["'][^"']*json/i.test(attrs!))
    .map(([, , source]) => source!);
}

type PageElement = {
  value: string;
  innerHTML: string;
  textContent: string;
  className: string;
  disabled: boolean;
  firstChild: null;
  children: unknown[];
  style: Record<string, string>;
  dataset: Record<string, string>;
  classList: { add(): void; remove(): void; toggle(): void };
  addEventListener(): void;
  insertBefore(): void;
  setAttribute(): void;
  querySelectorAll(): unknown[];
};

function pageElement(): PageElement {
  let text = "";
  return {
    value: "",
    innerHTML: "",
    get textContent() { return text; },
    set textContent(value: string) {
      text = String(value);
      this.innerHTML = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    className: "",
    disabled: false,
    firstChild: null,
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    insertBefore() {},
    setAttribute() {},
    querySelectorAll() { return []; },
  };
}

type PageFetch = (url: string) => Promise<{ json(): Promise<any> }>;

const noRequests: PageFetch = (url) => Promise.reject(new Error(`unexpected request for ${url}`));

function forwardedTo(scratch: (url: string) => string, adjust: (data: any) => void = () => {}, from: string = base): PageFetch {
  return async (url) => {
    const data = await (await fetch(`${from}${scratch(url)}`)).json();
    adjust(data);
    return { json: async () => data };
  };
}

function runScriptDefining(html: string, functionName: string, search: string, pageFetch: PageFetch) {
  const elements = new Map<string, PageElement>();
  const alerts: string[] = [];
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, pageElement());
      return elements.get(id)!;
    },
    createElement: () => pageElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { location: { search, pathname: "/", origin: base, href: `${base}/${search}` }, open() {} };
  const context = vm.createContext({
    window,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState() {} },
    alert: (message: string) => { alerts.push(message); },
    fetch: pageFetch,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  });
  const blocks = inlineScripts(html).filter((source) => source.includes(`function ${functionName}(`));
  assert.strictEqual(blocks.length, 1, `one script block defines ${functionName}`);
  vm.runInContext(blocks[0]!, context, { timeout: 10000 });
  return { context: context as Record<string, unknown>, elements, alerts };
}

async function rendered(elements: Map<string, PageElement>, id: string): Promise<string> {
  for (let attempt = 0; attempt < 1000 && !elements.get(id)?.innerHTML; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const html = elements.get(id)?.innerHTML ?? "";
  assert.notStrictEqual(html, "", `#${id} was never rendered`);
  return html;
}

function printsItsOwnTerms(item: CardItem): boolean {
  return !item.terms_superseded && !offerRetired(item);
}

function ownTokens(item: CardItem): string[] {
  return (item.conditions ?? []).map((condition) => condition.text.match(ANY_TOKEN)![0]!);
}

function assertConditionsFollowTheTerms(card: string, termsEnd: RegExp, item: CardItem, whatFollows: RegExp): void {
  const end = card.match(termsEnd);
  assert.ok(end, `${item.vendor}: the card prints its terms\n${card}`);
  const afterTheTerms = card.slice(end.index! + end[0].length);
  const conditions = conditionsHtmlBesidePublishedTerms(item);
  assert.ok(afterTheTerms.startsWith(conditions), `${item.vendor}: the listing's conditions follow its terms\n${card}`);
  assert.match(afterTheTerms.slice(conditions.length), whatFollows, `${item.vendor}: nothing else sits between the terms and the rest of the card\n${card}`);
  assert.deepStrictEqual(card.match(ANY_TOKEN) ?? [], printsItsOwnTerms(item) ? ownTokens(item) : [], `${item.vendor}: the card names exactly its own conditions\n${card}`);
  assert.strictEqual(card.split('<ul class="listing-conditions"').length - 1, printsItsOwnTerms(item) ? 1 : 0, `${item.vendor}: one list of conditions, or none\n${card}`);
}

function listNaming(html: string, token: string): string | undefined {
  return html.match(new RegExp(`<ul class="listing-conditions"[^>]*>(?:(?!</ul>)[\\s\\S])*${token}(?:(?!</ul>)[\\s\\S])*</ul>`))?.[0];
}

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const SUPERSEDED = { notice: "A later record of ours supersedes these terms." };

describe("conditions of use on the cards a page builds in the browser", () => {
  it("the home page's deal cards print each listing's conditions right after its description, and none beside superseded or retired terms", async () => {
    let items: CardItem[] = [];
    const pageFetch = forwardedTo(
      (url) => url.replace(/([?&])limit=\d+/, `$1limit=${scratchOffers.length}`),
      (data) => {
        data.offers.forEach((item: CardItem, index: number) => {
          if (index % 7 === 3) item.terms_superseded = SUPERSEDED;
          if (index % 11 === 5) item.tier = "Retired";
        });
        items = data.offers;
      },
    );

    const { elements } = runScriptDefining(await body("/"), "renderCards", "", pageFetch);
    const cards = (await rendered(elements, "deal-cards")).split('<div class="deal-card"').slice(1);

    assert.strictEqual(items.length, scratchOffers.length);
    assert.strictEqual(cards.length, items.length);
    cards.forEach((card, index) => assertConditionsFollowTheTerms(card, /<div class="deal-desc">[^<]*<\/div>/, items[index]!, /^(<a class="deal-link"|<\/div>)/));
    assert.ok(items.some((item) => printsItsOwnTerms(item) && item.conditions!.length === 2), "a listing with two conditions prints both");
    assert.ok(items.some((item) => item.terms_superseded && !offerRetired(item)), "a superseded listing is among the cards");
    assert.ok(items.some((item) => offerRetired(item) && !item.terms_superseded), "a retired listing is among the cards");

    const sameAsTheVendorPage: string[] = [];
    for (const [index, item] of items.entries()) {
      if (sameAsTheVendorPage.length === 3) break;
      if (!printsItsOwnTerms(item)) continue;
      const vendorPage = await fetch(`${base}/vendor/${slugOf(item.vendor)}`);
      const onTheVendorPage = vendorPage.ok ? listNaming(await vendorPage.text(), ownTokens(item)[0]!) : undefined;
      if (!onTheVendorPage) continue;
      assert.strictEqual(listNaming(cards[index]!, ownTokens(item)[0]!), onTheVendorPage, `${item.vendor}: the card's list is the vendor page's, byte for byte`);
      sameAsTheVendorPage.push(item.vendor);
    }
    assert.strictEqual(sameAsTheVendorPage.length, 3, `compared with a vendor page: ${sameAsTheVendorPage.join(", ")}`);
  });

  it("a comparison card prints its listing's conditions right after its terms, for every vendor in the catalogue", async () => {
    const vendors = [...new Set(scratchOffers.map((offer) => offer.vendor))];
    const { context, elements } = runScriptDefining(await body("/compare-tool"), "renderComparison", "", noRequests);
    const renderComparison = context.renderComparison as (data: unknown) => void;

    const unresolved: string[] = [];
    let checked = 0;
    for (let at = 0; at < vendors.length; at += 2) {
      const pair = [vendors[at]!, vendors[(at + 1) % vendors.length]!];
      const comparison = await (await fetch(`${base}/api/compare?a=${encodeURIComponent(pair[0]!)}&b=${encodeURIComponent(pair[1]!)}`)).json();
      if (comparison.error) { unresolved.push(pair.join(" vs ")); continue; }

      renderComparison(comparison);

      const cards = elements.get("results")!.innerHTML.split('<div class="vendor-card">').slice(1);
      assert.strictEqual(cards.length, 2, pair.join(" vs "));
      assertConditionsFollowTheTerms(cards[0]!, /<div class="vendor-desc">[^<]*<\/div>/, comparison.vendor_a, /^<div class="vendor-meta">/);
      assertConditionsFollowTheTerms(cards[1]!, /<div class="vendor-desc">[^<]*<\/div>/, comparison.vendor_b, /^<div class="vendor-meta">/);
      checked += 2;
    }

    assert.deepStrictEqual(unresolved, []);
    assert.strictEqual(checked, vendors.length + (vendors.length % 2));
  });

  it("a comparison loaded from a shared link prints the conditions, and none beside a superseded-terms notice or a retired tier", async () => {
    const [first, second] = scratchOffers.filter((offer) => !offerRetired(offer)).map((offer) => offer.vendor);
    const search = `?a=${encodeURIComponent(first!)}&b=${encodeURIComponent(second!)}`;
    const html = await body("/compare-tool");

    let served: { vendor_a: CardItem; vendor_b: CardItem } | undefined;
    const asServed = runScriptDefining(html, "renderComparison", search, forwardedTo((url) => url, (data) => { served = data; }));
    const servedCards = (await rendered(asServed.elements, "results")).split('<div class="vendor-card">').slice(1);
    assert.ok(printsItsOwnTerms(served!.vendor_a) && printsItsOwnTerms(served!.vendor_b));
    assertConditionsFollowTheTerms(servedCards[0]!, /<div class="vendor-desc">[^<]*<\/div>/, served!.vendor_a, /^<div class="vendor-meta">/);
    assertConditionsFollowTheTerms(servedCards[1]!, /<div class="vendor-desc">[^<]*<\/div>/, served!.vendor_b, /^<div class="vendor-meta">/);

    let withheld: { vendor_a: CardItem; vendor_b: CardItem } | undefined;
    const asWithheld = runScriptDefining(html, "renderComparison", search, forwardedTo((url) => url, (data) => {
      data.vendor_a.terms_superseded = SUPERSEDED;
      data.vendor_b.tier = "Retired";
      withheld = data;
    }));
    const withheldCards = (await rendered(asWithheld.elements, "results")).split('<div class="vendor-card">').slice(1);
    assert.ok(withheldCards[0]!.includes(`<div class="vendor-desc">${SUPERSEDED.notice}</div>`));
    assertConditionsFollowTheTerms(withheldCards[0]!, /<div class="vendor-desc">[^<]*<\/div>/, withheld!.vendor_a, /^<div class="vendor-meta">/);
    assertConditionsFollowTheTerms(withheldCards[1]!, /<div class="vendor-desc">[^<]*<\/div>/, withheld!.vendor_b, /^<div class="vendor-meta">/);
    assert.deepStrictEqual([...asServed.alerts, ...asWithheld.alerts], []);
  });

  it("each gap the stack check recommends prints the listing's conditions after its row, and none beside superseded or retired terms", async () => {
    let gaps: Array<{ category: string; recommendation: CardItem }> = [];
    const pageFetch = forwardedTo((url) => url, (data) => {
      gaps = data.gaps;
      gaps[0]!.recommendation.terms_superseded = SUPERSEDED;
      gaps[1]!.recommendation.tier = "Retired";
    });

    const { elements, alerts } = runScriptDefining(await body("/stack-check"), "renderResults", "?s=No%20Such%20Vendor", pageFetch);
    const rows = (await rendered(elements, "gaps-list")).split('<div class="gap-item">').slice(1);

    assert.ok(gaps.length >= 3, `expected a gap in several core categories, got ${gaps.length}`);
    assert.strictEqual(rows.length, gaps.length);
    rows.forEach((row, index) => assertConditionsFollowTheTerms(row, /<\/span><\/div>/, gaps[index]!.recommendation, /^$/));
    assert.ok(rows[0]!.includes(SUPERSEDED.notice));
    assert.ok(gaps.slice(2).every((gap) => printsItsOwnTerms(gap.recommendation)), "the other recommendations print their own terms");
    assert.deepStrictEqual(alerts, []);
  });
});

function changesOf(vendor: string): DealChange[] {
  return changeLog.filter((change) => change.vendor.toLowerCase() === vendor.toLowerCase());
}

function soleListingWhoseTermsNoRecordQuotes(offer: Offer): boolean {
  const listings = scratchOffers.filter((listing) => listing.vendor.toLowerCase() === offer.vendor.toLowerCase());
  return listings.length === 1
    && !offerRetired(offer)
    && changesOf(offer.vendor).every((change) => !quotesTheStoredTermsAsPrevious(change, offer.description));
}

function aRecordNamingTheTermsOf(offer: Offer): DealChange {
  return {
    vendor: offer.vendor,
    category: offer.category,
    tier: offer.tier,
    change_type: "limits_reduced",
    date: "2026-08-28",
    date_source: "discovered",
    summary: "The free plan now allows one project.",
    previous_state: offer.description,
    current_state: "Free plan: 1 project, 100 MB storage",
    impact: "high",
    source_url: offer.url,
    alternatives: [],
  } as unknown as DealChange;
}

function eventStreamMessages(text: string): any[] {
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

async function compareVendorsOverMcp(at: string, vendors: string[]): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await fetch(`${at}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conditions-on-client-cards", version: "1" } } }),
  });
  await initialized.text();
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  await (await fetch(`${at}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const response = await fetch(`${at}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compare_vendors", arguments: { vendors } } }) });
  const [message] = eventStreamMessages(await response.text());
  return JSON.parse(message.result.content[0].text);
}

function supersededSides(comparison: { vendor_a: CardItem; vendor_b: CardItem }): Record<string, unknown> {
  return {
    [comparison.vendor_a.vendor]: comparison.vendor_a.terms_superseded,
    [comparison.vendor_b.vendor]: comparison.vendor_b.terms_superseded,
  };
}

describe("a comparison naming a listing whose terms the catalogue's own records supersede", () => {
  const [subject, other] = scratchOffers.filter(soleListingWhoseTermsNoRecordQuotes);
  const record = aRecordNamingTheTermsOf(subject!);
  const expected = supersededTermsRecordFor(subject!, [record]);
  const changesPath = path.join(dir, "changes.json");
  let superseding: { child: ChildProcess; base: string } | undefined;

  before(async () => {
    writeFileSync(changesPath, JSON.stringify({ ...storedChanges, changes: [...changeLog, record] }));
    superseding = await startServer({ AGENTDEALS_CHANGES_PATH: changesPath });
  });
  after(() => {
    superseding?.child.kill();
  });

  it("the added record supersedes the listing's terms by the catalogue's own rule", () => {
    assert.ok(subject && other, "two listings whose terms no record quotes");
    assert.strictEqual(supersedingChange(subject!, [...changesOf(subject!.vendor), record]), record);
    assert.ok(expected?.notice, "the record carries a notice");
  });

  it("/api/compare carries the record on that listing's side and null on the other, in either order", async () => {
    for (const [a, b] of [[subject!, other!], [other!, subject!]]) {
      const route = `/api/compare?a=${encodeURIComponent(a.vendor)}&b=${encodeURIComponent(b.vendor)}`;
      const asListed = await (await fetch(`${base}${route}`)).json();
      const asSuperseded = await (await fetch(`${superseding!.base}${route}`)).json();
      assert.deepStrictEqual(supersededSides(asListed), { [subject!.vendor]: null, [other!.vendor]: null }, route);
      assert.deepStrictEqual(supersededSides(asSuperseded), { [subject!.vendor]: expected, [other!.vendor]: null }, route);
    }
  });

  it("MCP compare_vendors carries the same record on the same side", async () => {
    const answer = await compareVendorsOverMcp(superseding!.base, [other!.vendor, subject!.vendor]);
    assert.deepStrictEqual(supersededSides(answer), { [subject!.vendor]: expected, [other!.vendor]: null });
  });

  it("the comparison card prints the record's notice and none of the listing's conditions, and the other card its own", async () => {
    const search = `?a=${encodeURIComponent(subject!.vendor)}&b=${encodeURIComponent(other!.vendor)}`;
    const { context, elements, alerts } = runScriptDefining(await body("/compare-tool"), "renderComparison", search, forwardedTo((url) => url, undefined, superseding!.base));
    const cards = (await rendered(elements, "results")).split('<div class="vendor-card">').slice(1);
    const escHtml = context.escHtml as (text: string) => string;

    assert.strictEqual(cards.length, 2);
    assert.ok(cards[0]!.includes(`<div class="vendor-desc">${escHtml(expected!.notice)}</div><div class="vendor-meta">`), `${subject!.vendor}: the card prints the notice in place of the terms, with nothing after it\n${cards[0]}`);
    assert.deepStrictEqual(cards[0]!.match(ANY_TOKEN) ?? [], [], `${subject!.vendor}: the card names none of the listing's conditions\n${cards[0]}`);
    assertConditionsFollowTheTerms(cards[1]!, /<div class="vendor-desc">[^<]*<\/div>/, other!, /^<div class="vendor-meta">/);
    assert.deepStrictEqual(alerts, []);
  });
});
