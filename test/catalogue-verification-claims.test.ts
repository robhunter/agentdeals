import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirmationCoverage, confirmationCoverageSentence, loadDealChanges, loadOffers, CONFIRMATION_WINDOW_DAYS } from "../dist/data.js";
import { confirmationDate } from "../dist/read-date.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const A_DAY_IN_MS = 86400000;

const A_VERIFICATION_ADJECTIVE = /\b(?:verified|human-verified|fact-checked|fact checked)\b/i;
const A_SENTENCE = /[^.!?\n]+[.!?]*/g;
const A_CATALOGUE_SCALE_FIGURE = /\b\d{1,3},?\d{3}\+?\b/;

interface Served {
  path: string;
  prose: string;
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

describe("the figure moves with the store rather than with an edit", () => {
  it("restates it on a day the census says something different", async () => {
    const moves = theFirstDayTheCensusMoves();
    assert.ok(moves > 0, `the census does not move within ${CONFIRMATION_WINDOW_DAYS + 30} days, so this assertion has no second day to read`);

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
      } finally {
        proc.kill();
      }
    }

    assert.notEqual(censusOn(0), censusOn(moves * A_DAY_IN_MS),
      "both days were asserted against the same census, so a hard-coded figure would pass");
  });
});
