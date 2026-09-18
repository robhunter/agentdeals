import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirmationCoverage, confirmationCoverageSentence, loadDealChanges, loadOffers, CONFIRMATION_WINDOW_DAYS } from "../dist/data.js";
import { confirmationDate } from "../dist/read-date.js";
import { toSlug } from "../dist/slug.js";
import { assertCoversPopulation, categoriesInTheCatalogue } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const A_DAY_IN_MS = 86400000;

const A_VERIFICATION_ADJECTIVE = /\b(?:verified|human-verified|fact-checked|fact checked)\b/i;
const A_SENTENCE = /[^.!?\n]+[.!?]*/g;
const A_CATALOGUE_SCALE_FIGURE = /\b\d{1,3},?\d{3}\+?\b/;
const A_LISTING_SET = /\b(?:each|every|all)\b/i;
const A_CONFIRMED_OF_A_LISTING_SET =
  /Of the ([\d,]+) (.+?) entr(?:y|ies) we hold, ([\d,]+) (?:carry|carries) terms a read confirmed in the last (\d+) days\./;

interface Served {
  path: string;
  prose: string;
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–").replace(/&rsaquo;/g, "›").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function faqAnswers(html: string): string[] {
  const answers: string[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: any;
    try { parsed = JSON.parse(block[1]); } catch { continue; }
    if (parsed?.["@type"] !== "FAQPage") continue;
    for (const entry of parsed.mainEntity ?? []) {
      const text = entry?.acceptedAnswer?.text;
      if (typeof text === "string") answers.push(text);
    }
  }
  return answers;
}

function metaDescriptionOf(html: string): string {
  return unescapeHtml(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
}

function categoryRoutes(): string[] {
  return [...new Set(loadOffers().map((offer: { category: string }) => offer.category))]
    .map((name) => `/category/${toSlug(name)}`);
}

async function everyListingSetClaim(base: string): Promise<Served[]> {
  const served: Served[] = [];
  for (const route of categoryRoutes()) {
    const html = await (await fetch(`${base}${route}`)).text();
    const prose = [metaDescriptionOf(html), ...faqAnswers(html)].join("\n");
    assert.ok(prose.trim().length > 0, `${route} served no meta description or FAQ answer for this assertion to read`);
    served.push({ path: route, prose });
  }
  const ai = await (await fetch(`${base}/ai-free-tiers`)).text();
  served.push({ path: "/ai-free-tiers", prose: unescapeHtml(ai.replace(/<[^>]+>/g, " ")) });
  return served;
}

async function toolDescriptions(base: string): Promise<Served[]> {
  const opened = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  });
  const session = opened.headers.get("mcp-session-id") ?? "";
  await opened.text();
  assert.ok(session, "the MCP door opened no session for tools/list to be asked on");
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Mcp-Session-Id": session,
  };
  await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const listed = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  const tools = sseResponses(await listed.text()).find((r) => r.id === 2)?.result?.tools ?? [];
  assert.ok(tools.length > 0, "tools/list answered no tool for this assertion to read");
  const card = JSON.parse(await (await fetch(`${base}/.well-known/agent-card.json`)).text());
  const onTheCard = card.tools ?? [];
  assert.ok(onTheCard.length > 0, "the agent card publishes no tools[] for this assertion to read");
  return [
    ...tools.map((tool: any) => ({ path: `tools/list ${tool.name}`, prose: String(tool.description ?? "") })),
    ...onTheCard.map((tool: any) => ({ path: `agent card tools[] ${tool.name}`, prose: String(tool.description ?? "") })),
  ];
}

function startServer(clockShiftMs: number): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const args = clockShiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TZ: "UTC",
        PORT: "0",
        BASE_URL: "http://localhost",
        AGENTDEALS_CLOCK_SHIFT_MS: String(clockShiftMs),
      },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 60000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${match[1]}` }); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function sseResponses(text: string): any[] {
  const results: any[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { results.push(JSON.parse(line.slice(6))); } catch { /* not a JSON frame */ }
    }
  }
  return results;
}

async function initialize(base: string): Promise<{ serverInfo: any; instructions: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  });
  const initResp = sseResponses(await res.text()).find((r) => r.id === 1);
  assert.ok(initResp?.result, "the MCP door answered no initialize result for this assertion to read");
  return { serverInfo: initResp.result.serverInfo ?? {}, instructions: initResp.result.instructions ?? "" };
}

async function everySelfDescription(base: string): Promise<Served[]> {
  const card = JSON.parse(await (await fetch(`${base}/.well-known/agent-card.json`)).text());
  const { serverInfo, instructions } = await initialize(base);
  const documents: Served[] = [
    { path: "/.well-known/agent-card.json", prose: [card.description, JSON.stringify(card.catalogue)].join(" ") },
    { path: "MCP serverInfo.description", prose: String(serverInfo.description ?? "") },
    { path: "MCP instructions", prose: instructions },
    { path: "/llms.txt", prose: await (await fetch(`${base}/llms.txt`)).text() },
    { path: "/llms-full.txt", prose: await (await fetch(`${base}/llms-full.txt`)).text() },
    { path: "/AGENTS.md", prose: await (await fetch(`${base}/AGENTS.md`)).text() },
  ];
  for (const document of documents) {
    assert.ok(document.prose.length > 0, `${document.path} served nothing for this assertion to read`);
  }
  return documents;
}

function censusOn(shiftMs: number): number {
  return confirmationCoverage(loadOffers(), new Date(Date.now() + shiftMs)).confirmed_within_90_days;
}

function aCategoryWhoseCensusMovesBy(days: number): { route: string; held: any[] } | null {
  const offers = loadOffers();
  const later = new Date(Date.now() + days * A_DAY_IN_MS);
  const moving = categoryRoutes()
    .map((route) => ({ route, held: offers.filter((offer: { category: string }) => `/category/${toSlug(offer.category)}` === route) }))
    .filter(({ held }) => confirmationCoverage(held).confirmed_within_90_days !== confirmationCoverage(held, later).confirmed_within_90_days)
    .sort((a, b) => b.held.length - a.held.length);
  return moving[0] ?? null;
}

function theFirstDayTheCensusMoves(): number {
  const today = censusOn(0);
  for (let day = 1; day <= 120; day++) {
    if (censusOn(day * A_DAY_IN_MS) !== today) return day;
  }
  return 0;
}

describe("what the self-description documents claim about confirmation", () => {
  let today: Served[] = [];
  let proc: ChildProcess | null = null;
  let servedFrom = "";

  before(async () => {
    const started = await startServer(0);
    proc = started.proc;
    servedFrom = started.base;
    today = await everySelfDescription(started.base);
  });

  after(() => { if (proc) proc.kill(); });

  it("names no catalogue-scale figure as verified, on any of them", () => {
    const claiming: string[] = [];
    for (const document of today) {
      for (const sentence of document.prose.match(A_SENTENCE) ?? []) {
        if (!A_CATALOGUE_SCALE_FIGURE.test(sentence)) continue;
        if (!A_VERIFICATION_ADJECTIVE.test(sentence)) continue;
        claiming.push(`${document.path}: ${sentence.trim()}`);
      }
    }
    assert.deepEqual(claiming, [], `${claiming.length} self-description sentences call a catalogue-scale figure verified`);
  });

  it("claims no hand-checking of the catalogue on any of them", () => {
    const claiming = today
      .filter((document) => /human-verified|fact-checked|fact checked|verified by hand|read by hand/i.test(document.prose))
      .map((document) => document.path);
    assert.deepEqual(claiming, [], `${claiming.length} self-description documents claim the catalogue is checked by hand`);
  });

  it("states the confirmation figure on every one of them", () => {
    const stated = confirmationCoverageSentence(confirmationCoverage());
    const silent = today.filter((document) => !document.prose.includes(stated)).map((document) => document.path);
    assert.deepEqual(silent, [], `${silent.length} self-description documents state a catalogue size and not how much of it a read confirmed`);
  });

  it("says which end of the range the catalogue dates run to", async () => {
    const card = today.find((document) => document.path === "/.well-known/agent-card.json")!;
    const catalogue = JSON.parse(card.prose.slice(card.prose.indexOf("{")));
    assert.ok(catalogue.catalogue_dated_between.oldest < catalogue.catalogue_dated_between.newest,
      "the card publishes one catalogue date where the entries span a range");
    const dates = loadOffers().map((o: { verifiedDate: string }) => o.verifiedDate).filter(Boolean).sort();
    assert.equal(catalogue.catalogue_dated_between.oldest, dates[0]);
    assert.equal(catalogue.catalogue_dated_between.newest, dates[dates.length - 1]);
  });

  it("reconciles the card with the endpoint that publishes the same measure", async () => {
    const card = today.find((document) => document.path === "/.well-known/agent-card.json")!;
    const catalogue = JSON.parse(card.prose.slice(card.prose.indexOf("{")));
    assert.ok(catalogue.confirmation_url.endsWith("/api/freshness"),
      "the card states a coverage figure and does not say where the same measure is published in full");
    const freshness = await (await fetch(`${servedFrom}/api/freshness`)).json() as any;
    assert.equal(catalogue.confirmed_within_90_days, freshness.confirmed_within_90_days);
    assert.equal(catalogue.freshness_score, freshness.freshness_score);
    assert.equal(catalogue.offers, freshness.total_offers);
    assert.ok(freshness.stamped_within_90_days > freshness.confirmed_within_90_days,
      "the card is publishing the count that flatters, not the one the endpoint calls a confirmation");
  });

  it("states how each change record was read rather than claiming they all were read by hand", async () => {
    const tracker = await (await fetch(`${servedFrom}/free-tier-tracker`)).text();
    assert.ok(!/Each change was read by hand/i.test(tracker), "the tracker still claims every record was read by hand");
    const stated = tracker.match(/(\d[\d,]*) of them were written by the scheduled re-read/);
    assert.ok(stated, "the tracker states no split between the scheduled re-read and a hand reading");
    const scheduled = loadDealChanges().filter((change: { detected_by?: string }) => change.detected_by).length;
    assert.ok(parseInt(stated[1].replace(/,/g, ""), 10) <= scheduled,
      `the tracker counts more scheduled readings than the ${scheduled} records carrying one`);
  });

  it("agrees with itself about one entry and about many", () => {
    assert.equal(
      confirmationCoverageSentence({ offers: 1, confirmed_within_90_days: 1, freshness_score: 100 }),
      `Of the 1 entry we hold, 1 carries terms a read confirmed in the last ${CONFIRMATION_WINDOW_DAYS} days.`,
    );
    assert.equal(
      confirmationCoverageSentence({ offers: 2000, confirmed_within_90_days: 2, freshness_score: 0 }),
      `Of the 2,000 entries we hold, 2 carry terms a read confirmed in the last ${CONFIRMATION_WINDOW_DAYS} days.`,
    );
  });

  it("counts the entries a read confirmed rather than the entries carrying a date", () => {
    const offers = loadOffers();
    const stamped = offers.filter((o: { verifiedDate: string }) => o.verifiedDate).length;
    const coverage = confirmationCoverage();
    assert.ok(coverage.confirmed_within_90_days < stamped,
      `the confirmed count ${coverage.confirmed_within_90_days} is not separating itself from the ${stamped} entries carrying a catalogue date`);
    const holdingNone = offers.filter((o: any) => confirmationDate(o) === null).length;
    assert.ok(holdingNone > 0, "every entry holds a confirmation, so this measure cannot show a shortfall");
  });
});

describe("the date a page prints beside its count", () => {
  let proc: ChildProcess | null = null;
  let base = "";

  before(async () => {
    const started = await startServer(0);
    proc = started.proc;
    base = started.base;
  });

  after(() => { if (proc) proc.kill(); });

  it("names the newest catalogue date as the newest, wherever it prints one", async () => {
    const offers = loadOffers();
    const carrying: string[] = [];
    for (const pagePath of ["/category/databases", "/category/design", "/compare/neon-vs-supabase"]) {
      const html = await (await fetch(`${base}${pagePath}`)).text();
      const meta = html.match(/<p class="(?:cat|page)-meta">([^<]*)<\/p>/)?.[1] ?? "";
      assert.ok(meta.length > 0, `${pagePath} carries no meta line for this assertion to read`);
      const dated = meta.match(/Catalogue dates here run to (\d{4}-\d{2}-\d{2})\./);
      if (!dated) continue;
      carrying.push(pagePath);
      assert.ok(!/\bverified\b/i.test(meta), `${pagePath} prints a date under the word verified: ${meta}`);
      const newest = offers.map((o: { verifiedDate: string }) => o.verifiedDate).filter(Boolean).sort().at(-1)!;
      assert.ok(dated[1] <= newest, `${pagePath} dates itself past the newest catalogue date we hold`);
    }
    assert.ok(carrying.length >= 2, `only ${carrying.length} of the pages checked print a catalogue date`);
  });
});

describe("what a listing page claims about the set it lists", () => {
  let proc: ChildProcess | null = null;
  let listings: Served[] = [];
  let tools: Served[] = [];

  before(async () => {
    const started = await startServer(0);
    proc = started.proc;
    listings = await everyListingSetClaim(started.base);
    tools = await toolDescriptions(started.base);
  });

  after(() => { if (proc) proc.kill(); });

  it("reads every category the catalogue holds", () => {
    const categories = listings.filter((listing) => listing.path.startsWith("/category/")).length;
    assertCoversPopulation(categories, categoriesInTheCatalogue(), "category pages read for a claim over their listings");
  });

  it("calls no set of listings verified, on any of them", () => {
    const claiming: string[] = [];
    for (const listing of listings) {
      for (const sentence of listing.prose.match(A_SENTENCE) ?? []) {
        if (!A_VERIFICATION_ADJECTIVE.test(sentence) || !A_LISTING_SET.test(sentence)) continue;
        claiming.push(`${listing.path}: ${sentence.trim()}`);
      }
    }
    assert.deepEqual(claiming.slice(0, 10), [], `${claiming.length} listing-page sentences call a whole set of listings verified`);
  });

  it("states how many of what it lists a read confirmed instead", () => {
    const silent = listings.filter((listing) => !A_CONFIRMED_OF_A_LISTING_SET.test(listing.prose)).map((listing) => listing.path);
    assert.deepEqual(silent.slice(0, 10), [], `${silent.length} listing pages state no confirmed count over the set they list`);
  });

  it("states the count the census takes over that category, not another one", () => {
    const offers = loadOffers();
    const wrong: string[] = [];
    for (const listing of listings.filter((l) => l.path.startsWith("/category/"))) {
      const stated = listing.prose.match(A_CONFIRMED_OF_A_LISTING_SET)!;
      const held = offers.filter((offer: { category: string }) => `/category/${toSlug(offer.category)}` === listing.path);
      const census = confirmationCoverage(held);
      const says = { held: Number(stated[1].replace(/,/g, "")), confirmed: Number(stated[3].replace(/,/g, "")) };
      if (says.held !== census.offers || says.confirmed !== census.confirmed_within_90_days) {
        wrong.push(`${listing.path} says ${says.confirmed} of ${says.held}, the census says ${census.confirmed_within_90_days} of ${census.offers}`);
      }
    }
    assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} category pages state a confirmed count the census does not`);
    const confirmed = listings
      .filter((l) => l.path.startsWith("/category/"))
      .reduce((total, l) => total + Number(l.prose.match(A_CONFIRMED_OF_A_LISTING_SET)![3].replace(/,/g, "")), 0);
    assert.equal(confirmed, confirmationCoverage().confirmed_within_90_days,
      "the categories do not add up to the catalogue the self-description documents state");
  });

  it("promises no verification in a tool description every client is charged for", () => {
    const claiming = tools.filter((tool) => A_VERIFICATION_ADJECTIVE.test(tool.prose)).map((tool) => tool.path);
    assert.deepEqual(claiming, [], `${claiming.length} tool descriptions promise a verified result`);
    assert.ok(tools.some((tool) => tool.path.startsWith("tools/list ")) && tools.some((tool) => tool.path.startsWith("agent card ")),
      "only one of the two surfaces publishing a tool description was read");
  });
});

describe("the figure moves with the store rather than with an edit", () => {
  it("restates it on a day the census says something different", async () => {
    const moves = theFirstDayTheCensusMoves();
    assert.ok(moves > 0, `the census does not move within ${CONFIRMATION_WINDOW_DAYS + 30} days, so this assertion has no second day to read`);
    const listing = aCategoryWhoseCensusMovesBy(moves);
    assert.ok(listing, `no category's census moves within ${moves} days, so a page-level figure has no second day to read`);

    for (const day of [0, moves]) {
      const shift = day * A_DAY_IN_MS;
      const { proc, base } = await startServer(shift);
      try {
        const documents = await everySelfDescription(base);
        const expected = confirmationCoverage(loadOffers(), new Date(Date.now() + shift));
        const wrong = documents
          .filter((document) => !document.prose.includes(confirmationCoverageSentence(expected)))
          .map((document) => document.path);
        assert.deepEqual(wrong, [], `on +${day} days, ${wrong.length} documents do not state ${expected.confirmed_within_90_days} of ${expected.offers}`);

        const html = await (await fetch(`${base}${listing.route}`)).text();
        const onThePage = [metaDescriptionOf(html), ...faqAnswers(html)].join("\n").match(A_CONFIRMED_OF_A_LISTING_SET);
        const overTheCategory = confirmationCoverage(listing.held, new Date(Date.now() + shift));
        assert.ok(onThePage, `on +${day} days, ${listing.route} states no confirmed count over the set it lists`);
        assert.equal(Number(onThePage[3].replace(/,/g, "")), overTheCategory.confirmed_within_90_days,
          `on +${day} days, ${listing.route} states ${onThePage[3]} where its own census counts ${overTheCategory.confirmed_within_90_days}`);
      } finally {
        proc.kill();
      }
    }

    assert.notEqual(censusOn(0), censusOn(moves * A_DAY_IN_MS),
      "both days were asserted against the same census, so a hard-coded figure would pass");
    assert.notEqual(
      confirmationCoverage(listing.held).confirmed_within_90_days,
      confirmationCoverage(listing.held, new Date(Date.now() + moves * A_DAY_IN_MS)).confirmed_within_90_days,
      `${listing.route} counts the same on both days, so a figure hard-coded into the page would pass`,
    );
  });
});
