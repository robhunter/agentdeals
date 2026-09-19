import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import {
  OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE,
  amountUnstatedSentence,
  freePriceConfirmedSentence,
  freePriceOnlySentence,
  limitsReadFromTheVendorsPage,
} from "../dist/source-check.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const DAY_MS = 86_400_000;
const dayOffset = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
const CATALOGUE_DATE = dayOffset(-30);
const READ_ON = dayOffset(-12);
const CHECKED_ON = dayOffset(-3);

const TERMS_STATING_A_QUANTITY = "Free plan: 1 project, 500 MB storage and 10K rows";

function offerFor(vendor: string, outcome: string, restated: boolean) {
  const host = `${vendor.toLowerCase()}.example`;
  return {
    vendor,
    category: "Databases",
    description: TERMS_STATING_A_QUANTITY,
    tier: "Free",
    url: `https://${host}/pricing`,
    tags: ["databases"],
    verifiedDate: CATALOGUE_DATE,
    source_check: { checked: CHECKED_ON, outcome, detail: `recorded as ${outcome}` },
    ...(restated
      ? {
          restated_from: {
            reading_date: READ_ON,
            source_url: `https://${host}/pricing`,
            record_date: READ_ON,
            change_type: "limits_reduced",
            restated_on: CHECKED_ON,
          },
        }
      : {}),
  };
}

const READ_FROM_THE_PAGE = [
  offerFor("Readcorp1", "states_a_free_price", true),
  offerFor("Readcorp2", "states_no_amount", true),
];

const HELD_IN_OUR_OWN_RECORD = [
  offerFor("Ownrecordcorp1", "states_a_free_price", false),
  offerFor("Ownrecordcorp2", "states_no_amount", false),
];

const CORPUS = [...READ_FROM_THE_PAGE, ...HELD_IN_OUR_OWN_RECORD];

const slugOf = (vendor: string) => vendor.toLowerCase();

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;
const pages = new Map<string, string>();
const riskSummaries = new Map<string, string>();

function startServer(indexPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function unescapeServed(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function timesItSays(html: string, clause: string): number {
  return unescapeServed(html).split(clause).length - 1;
}

function captionLine(html: string): string {
  const match = html.match(/<p class="(?:amount-unstated-line|free-price-line)"[^>]*>([\s\S]*?)<\/p>/);
  return match ? unescapeServed(match[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
}

describe("a record whose terms came from a reading says so wherever it says where its terms came from", () => {
  before(async () => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "restated-terms-provenance-"));
    const indexPath = path.join(fixtureDir, "index.json");
    writeFileSync(indexPath, JSON.stringify({ offers: CORPUS, categories: ["Databases"] }));
    proc = await startServer(indexPath);
    for (const offer of CORPUS) {
      const page = await fetch(`http://localhost:${serverPort}/vendor/${slugOf(offer.vendor)}`);
      pages.set(offer.vendor, await page.text());
      const risk = await fetch(`http://localhost:${serverPort}/api/vendor-risk/${encodeURIComponent(offer.vendor)}`);
      const body = await risk.json() as { summary?: string };
      riskSummaries.set(offer.vendor, body.summary ?? "");
    }
  });

  after(() => {
    proc?.kill();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("serves every record in the fixture, so the sweeps below are not passing on an empty page", () => {
    assert.deepStrictEqual(
      CORPUS.filter((offer) => !(pages.get(offer.vendor) ?? "").includes(offer.vendor)).map((o) => o.vendor),
      [],
    );
    assert.deepStrictEqual(CORPUS.filter((offer) => captionLine(pages.get(offer.vendor) ?? "") === "").map((o) => o.vendor), []);
  });

  it("names the day it read the page on a record whose terms came from that reading", () => {
    for (const offer of READ_FROM_THE_PAGE) {
      assert.match(captionLine(pages.get(offer.vendor) ?? ""), new RegExp(limitsReadFromTheVendorsPage(READ_ON)));
    }
  });

  it("says it on every surface that says where the terms came from, not only the caption a reader sees first", () => {
    const readClauses = timesItSays(pages.get("Readcorp2") ?? "", limitsReadFromTheVendorsPage(READ_ON));
    const ownClauses = timesItSays(pages.get("Ownrecordcorp2") ?? "", OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE);
    assertPopulationFloor(ownClauses, 5, "surfaces on a vendor page saying where the terms came from");
    assert.equal(
      readClauses,
      ownClauses,
      "a record that read its terms off the page says so on fewer surfaces than one that did not",
    );
  });

  it("claims no record of its own on a page whose terms it read off the vendor", () => {
    assert.deepStrictEqual(
      READ_FROM_THE_PAGE.filter((offer) => (pages.get(offer.vendor) ?? "").includes(OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE))
        .map((o) => o.vendor),
      [],
    );
  });

  it("goes on claiming its own record where no reading supplied the terms", () => {
    for (const offer of HELD_IN_OUR_OWN_RECORD) {
      assert.ok(
        captionLine(pages.get(offer.vendor) ?? "").includes(OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE),
        `${offer.vendor} stopped saying where its terms came from`,
      );
    }
  });

  it("answers the same way on the door an agent asks, not only on the page a reader opens", () => {
    assert.match(riskSummaries.get("Readcorp2") ?? "", new RegExp(limitsReadFromTheVendorsPage(READ_ON)));
    assert.ok((riskSummaries.get("Ownrecordcorp2") ?? "").includes(OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE));
  });

  it("builds both sentences out of one clause, so neither door can drift from the other", () => {
    assert.ok(amountUnstatedSentence("Widgetson", READ_ON).includes(limitsReadFromTheVendorsPage(READ_ON)));
    assert.ok(freePriceConfirmedSentence("Widgetson", READ_ON).includes(limitsReadFromTheVendorsPage(READ_ON)));
    assert.ok(amountUnstatedSentence("Widgetson").includes(OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE));
    assert.ok(freePriceConfirmedSentence("Widgetson").includes(OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE));
  });

  it("says nothing about where the limits came from where it states no limits", () => {
    assert.ok(!freePriceOnlySentence("Widgetson").includes(OUR_OWN_RECORD_RATHER_THAN_THAT_PAGE));
    assert.ok(!freePriceOnlySentence("Widgetson").includes(limitsReadFromTheVendorsPage(READ_ON)));
  });

  it("counts the records whose terms came from a reading, and not the ones holding our own", async () => {
    const metrics = await fetch(`http://localhost:${serverPort}/api/freshness`).then((r) => r.json()) as {
      superseded_terms: {
        offers_whose_terms_came_from_a_reading: number;
        offers_restated_by_change_type: Record<string, number>;
        oldest_reading_we_publish_as_our_terms: string | null;
        newest_reading_we_publish_as_our_terms: string | null;
      };
    };
    const published = metrics.superseded_terms;

    assert.strictEqual(published.offers_whose_terms_came_from_a_reading, READ_FROM_THE_PAGE.length);
    assert.ok(
      HELD_IN_OUR_OWN_RECORD.length > 0,
      "the fixture holds no unrestated record, so a count of every record would pass this",
    );
    assert.deepStrictEqual(published.offers_restated_by_change_type, {
      limits_reduced: READ_FROM_THE_PAGE.length,
    });
    assert.strictEqual(published.oldest_reading_we_publish_as_our_terms, READ_ON);
    assert.strictEqual(published.newest_reading_we_publish_as_our_terms, READ_ON);
  });
});
