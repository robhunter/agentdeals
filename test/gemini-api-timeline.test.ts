import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOffers } from "../dist/data.js";
import { changeSourceLinkHtml } from "../dist/change-citation.js";
import {
  flashPriceStepEntry,
  flashPriceStepIn,
  GEMINI_BILLING_DOCS,
  GEMINI_CHANGELOG,
  GEMINI_PRICING_PAGE,
} from "../dist/gemini-timeline.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/gemini-api-pricing-2026";

const STEP_AS_LISTED =
  "Paid, per million tokens (input/output): Gemini 3.8 Flash $0.75/$3.75 until 2026-12-31, then $1.50 input and $7.50 output from 2027-01-01 (3.7 Flash and 3.6 Flash: the same prices and dates); Gemini 3.5 Flash $1.50/$9.";

const SCHEDULED_TEXT =
  "Gemini 3.8 Flash, 3.7 Flash and 3.6 Flash cost $0.75/$3.75 per million input/output tokens through 2026-12-31 and $1.50/$7.50 from 2027-01-01, by Google's pricing page.";

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["--import", path.join(root, "scripts", "shifted-clock.mjs"), path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function clockAt(instant: string): Record<string, string> {
  return { AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(instant) - Date.now()) };
}

function timelineOf(html: string): string {
  const match = html.match(/<h2 id="timeline">[\s\S]*?<h2 id="who-affected">/);
  return match ? match[0] : "";
}

function entriesOf(timeline: string): { date: string; heading: string; body: string }[] {
  return [...timeline.matchAll(/<div class="timeline-date">([^<]*)<\/div>\s*<div class="timeline-content">\s*<h3[^>]*>([^<]*)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map(
    ([, date, heading, body]) => ({ date, heading, body }),
  );
}

const asServed = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sourceLink = (url: string) => changeSourceLinkHtml({ source_url: url }, asServed);

describe("the Flash price step in the Google Gemini API listing", () => {
  it("is read from the listing's sentence: the models priced alike, both prices and both days", () => {
    assert.deepStrictEqual(flashPriceStepIn(STEP_AS_LISTED), {
      models: "Gemini 3.8 Flash, 3.7 Flash and 3.6 Flash",
      until: { input: "0.75", output: "3.75", through: "2026-12-31" },
      then: { input: "1.50", output: "7.50", from: "2027-01-01" },
    });
  });

  it("joins a single model priced alike with 'and'", () => {
    const step = flashPriceStepIn(STEP_AS_LISTED.replace("3.7 Flash and 3.6 Flash:", "3.7 Flash:"));
    assert.strictEqual(step?.models, "Gemini 3.8 Flash and 3.7 Flash");
  });

  it("is not read from a listing that gives no 2027 figures", () => {
    assert.strictEqual(flashPriceStepIn("Paid, per million tokens (input/output): Gemini 3.8 Flash $0.75/$3.75 until 2026-12-31, then double; Gemini 3.5 Flash $1.50/$9."), null);
  });
});

describe("the timeline entry for the Flash price step", () => {
  const step = flashPriceStepIn(STEP_AS_LISTED)!;

  it("reads as scheduled, in the present tense, on 2026-12-31", () => {
    assert.deepStrictEqual(flashPriceStepEntry(step, "2026-12-31"), {
      dateLabel: "Jan 2027 (scheduled)",
      heading: "Flash Prices Double",
      text: SCHEDULED_TEXT,
      source: GEMINI_PRICING_PAGE,
    });
  });

  it("reads in the past tense and no longer says scheduled from 2027-01-01", () => {
    const entry = flashPriceStepEntry(step, "2027-01-01");
    assert.strictEqual(entry.dateLabel, "Jan 2027");
    assert.strictEqual(entry.heading, "Flash Prices Doubled");
    assert.strictEqual(entry.text, SCHEDULED_TEXT);
  });

  it("does not call a 2027 price a doubling when it is not twice the 2026 one", () => {
    const notDouble = flashPriceStepIn(STEP_AS_LISTED.replace("then $1.50 input", "then $1.60 input"))!;
    assert.strictEqual(flashPriceStepEntry(notDouble, "2026-12-31").heading, "Flash Prices Change");
    assert.strictEqual(flashPriceStepEntry(notDouble, "2027-01-01").heading, "Flash Prices Changed");
    assert.match(flashPriceStepEntry(notDouble, "2026-12-31").text, /and \$1\.60\/\$7\.50 from 2027-01-01/);
  });
});

describe(`${PAGE}'s timeline`, () => {
  const servers: ChildProcess[] = [];
  const pages: Record<string, string> = {};
  let scratchDir = "";

  before(async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), "gemini-timeline-"));
    const index = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8"));
    const listing = index.offers.find((o: { vendor: string }) => o.vendor === "Google Gemini API");
    const edited = listing.description.replace(/then \$\d+(?:\.\d+)? input/, "then $1.60 input");
    assert.notStrictEqual(edited, listing.description, "the scratch edit finds the listing's 2027 input price");
    listing.description = edited;
    const scratchIndex = path.join(scratchDir, "index.json");
    writeFileSync(scratchIndex, JSON.stringify(index, null, 2));

    const live = loadOffers().find((o) => o.vendor === "Google Gemini API")!;
    const log = JSON.parse(readFileSync(path.join(root, "data", "deal_changes.json"), "utf-8"));
    log.changes.push({
      vendor: "Google Gemini API",
      change_type: "limits_reduced",
      date: "2026-10-01",
      date_source: "discovered",
      summary: "The free tier now covers Gemini 3.8 Flash only.",
      previous_state: live.description,
      current_state: "Free tier: Gemini 3.8 Flash only.",
      impact: "medium",
      source_url: "https://ai.google.dev/gemini-api/docs/pricing",
      category: live.category,
      tier: live.tier,
      alternatives: [],
      recorded_date: "2026-10-01",
    });
    const scratchChanges = path.join(scratchDir, "deal_changes.json");
    writeFileSync(scratchChanges, JSON.stringify(log, null, 2));

    const runs: [string, Record<string, string>][] = [
      ["today", {}],
      ["2026-12-31", clockAt("2026-12-31T12:00:00Z")],
      ["2027-01-01", clockAt("2027-01-01T12:00:00Z")],
      ["scratch", { AGENTDEALS_INDEX_PATH: scratchIndex }],
      ["superseded", { AGENTDEALS_CHANGES_PATH: scratchChanges }],
    ];
    await Promise.all(
      runs.map(async ([name, env]) => {
        const { proc, base } = await startServer(env);
        servers.push(proc);
        const res = await fetch(base + PAGE);
        assert.strictEqual(res.status, 200, name);
        pages[name] = timelineOf(await res.text());
        assert.notStrictEqual(pages[name], "", `${name}: the page has its timeline section`);
      }),
    );
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it("holds the Google Gemini API listing's dated Flash price step", () => {
    const listing = loadOffers().find((o) => o.vendor === "Google Gemini API");
    assert.ok(listing && flashPriceStepIn(listing.description), "the Google Gemini API listing states the Flash models' prices until and from a day");
  });

  it("lists March's welcome credit, September's 2.5 models and January 2027's Flash prices among its entries, in date order", () => {
    const entries = entriesOf(pages.today);
    assert.deepStrictEqual(
      entries.map((e) => e.date.replace(" (scheduled)", "")),
      ["Dec 2025", "Mar 2026", "Apr 2026", "Sep 2026", "Jan 2027"],
    );
  });

  it("gives each new entry the source page that states it", () => {
    const [, march, , september, january] = entriesOf(pages.today);
    assert.strictEqual(march.heading, "$300 Welcome Credit Excluded");
    assert.strictEqual(march.body, `${asServed("Accounts opened after 2026-03-02 cannot spend the $300 Google Cloud welcome credit on the Gemini API or AI Studio.")} ${sourceLink(GEMINI_BILLING_DOCS)}`);
    assert.strictEqual(september.heading, "2.5 Models Limited to Existing Users");
    assert.strictEqual(september.body, `${asServed("Since 2026-09-18 Google serves the Gemini 2.5 models only to users who have used them before, and points new projects to 3.5 Flash-Lite or 3.8 Flash.")} ${sourceLink(GEMINI_CHANGELOG)}`);
    assert.ok(january.body.endsWith(sourceLink(GEMINI_PRICING_PAGE)), january.body);
  });

  it("calls the Flash price step scheduled on 2026-12-31 and past from 2027-01-01", () => {
    const before = entriesOf(pages["2026-12-31"]).at(-1)!;
    const after = entriesOf(pages["2027-01-01"]).at(-1)!;
    assert.deepStrictEqual([before.date, before.heading], ["Jan 2027 (scheduled)", "Flash Prices Double"]);
    assert.deepStrictEqual([after.date, after.heading], ["Jan 2027", "Flash Prices Doubled"]);
    assert.ok(!pages["2027-01-01"].includes("scheduled"));
  });

  it("follows an edit to the listing's 2027 input price", () => {
    const january = entriesOf(pages.scratch).at(-1)!;
    assert.match(january.body, /and \$1\.60\/\$7\.50 from 2027-01-01/);
    assert.strictEqual(january.heading.startsWith("Flash Prices Change"), true);
  });

  it("leaves the Flash price step out while a recorded change supersedes the listing's terms", () => {
    assert.deepStrictEqual(
      entriesOf(pages.superseded).map((e) => e.date),
      ["Dec 2025", "Mar 2026", "Apr 2026", "Sep 2026"],
    );
  });
});
