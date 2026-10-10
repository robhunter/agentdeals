import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { countsAsALoss, lossLabel, lossLabelsOf, LOSS_LABELS, LOSSES_SECTION_DESCRIPTION } = await import("../dist/loss-label.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const FREE_LISTING = { vendor: "Example", tier: "Free" };
const PAID_LISTING = { vendor: "Example", tier: "Pay-as-you-go" };
const CREDIT_LISTING = { vendor: "Example", tier: "Startup Credits" };

const change = (change_type: string, fields: Record<string, unknown> = {}) => ({
  vendor: "Example",
  change_type,
  summary: "Example changed its pricing.",
  current_state: "New terms.",
  ...fields,
});

describe("the label a Biggest Losers entry gives each change", () => {
  it("names the free-tier change for each type that changes the free tier", () => {
    assert.strictEqual(lossLabel(change("free_tier_removed"), FREE_LISTING), "free tier removed");
    assert.strictEqual(lossLabel(change("limits_reduced"), FREE_LISTING), "free tier limits reduced");
    assert.strictEqual(lossLabel(change("restriction"), FREE_LISTING), "new free-tier restriction");
    assert.strictEqual(lossLabel(change("open_source_killed"), FREE_LISTING), "open-source licence withdrawn");
  });

  it("says what a product ending does to the free plan, by the record's listing effect", () => {
    assert.strictEqual(lossLabel(change("product_deprecated", { listing_effect: "ends" }), FREE_LISTING), "product ends; its free plan ends with it");
    assert.strictEqual(lossLabel(change("product_deprecated", { listing_effect: "narrows" }), FREE_LISTING), "part of the product ends; the free tier narrows");
    assert.strictEqual(lossLabel(change("product_deprecated", { listing_effect: "none" }), FREE_LISTING), "a product ends; the listed free tier stays");
  });

  for (const type of ["pricing_restructured", "pricing_model_change"]) {
    describe(`a ${type} record`, () => {
      it("reads as a free-tier reduction only when it narrowed the free tier we list", () => {
        assert.strictEqual(lossLabel(change(type, { tier_direction: "narrowed" }), FREE_LISTING), "free tier reduced");
        assert.strictEqual(lossLabel(change(type, { tier_direction: "narrowed" }), PAID_LISTING), "paid pricing changed");
      });

      it("does not read a narrowing of the vendor's hosted edition as a cut to the self-hosted edition we list", () => {
        const OPEN_SOURCE_LISTING = { vendor: "Example", tier: "Free OSS" };
        const hosted = change(type, { tier_direction: "narrowed", current_state: "Example Cloud now starts at $20 a month." });
        const selfHosted = change(type, { tier_direction: "narrowed", current_state: "The self-hosted edition now caps projects at 3." });
        assert.strictEqual(lossLabel(hosted, OPEN_SOURCE_LISTING), "pricing changed");
        assert.strictEqual(lossLabel(selfHosted, OPEN_SOURCE_LISTING), "free tier reduced");
      });

      it("reads as a paid-price change when the free tier did not move", () => {
        assert.strictEqual(lossLabel(change(type, { tier_direction: "unchanged" }), FREE_LISTING), "paid pricing changed");
        assert.strictEqual(lossLabel(change(type, { tier_direction: "unchanged" }), null), "paid pricing changed");
      });

      it("reads as a paid-price change when the tier we list is a paid tier", () => {
        assert.strictEqual(lossLabel(change(type), PAID_LISTING), "paid pricing changed");
        assert.strictEqual(lossLabel(change(type), { vendor: "Example", tier: "Paid" }), "paid pricing changed");
      });

      it("claims no paid price for a credit grant or a trial, unless the free tier did not move", () => {
        assert.strictEqual(lossLabel(change(type), CREDIT_LISTING), "pricing changed");
        assert.strictEqual(lossLabel(change(type), { vendor: "Example", tier: "Free Trial" }), "pricing changed");
        assert.strictEqual(lossLabel(change(type, { tier_direction: "unchanged" }), CREDIT_LISTING), "paid pricing changed");
      });

      it("reads as a paid-price change when the record names a tier other than the one we list", () => {
        assert.strictEqual(lossLabel(change(type, { tier: "Team plan" }), FREE_LISTING), "paid pricing changed");
        assert.strictEqual(lossLabel(change(type, { tier: "Team plan" }), null), "paid pricing changed");
      });

      it("claims no free-tier cut when nothing says which tier moved", () => {
        assert.strictEqual(lossLabel(change(type), FREE_LISTING), "pricing changed");
        assert.strictEqual(lossLabel(change(type, { tier: "Free" }), FREE_LISTING), "pricing changed");
        assert.strictEqual(lossLabel(change(type), null), "pricing changed");
      });
    });
  }

  it("gives each label once, in the order free-tier changes first and price changes last", () => {
    const held = [change("pricing_restructured"), change("free_tier_removed"), change("pricing_model_change"), change("limits_reduced")];
    assert.strictEqual(lossLabelsOf(held, PAID_LISTING), "free tier removed; free tier limits reduced; paid pricing changed");
    assert.strictEqual(lossLabelsOf([change("pricing_restructured"), change("pricing_restructured")], FREE_LISTING), "pricing changed");
  });

  it("offers ten labels, each distinct", () => {
    assert.strictEqual(new Set(LOSS_LABELS).size, 10);
  });
});

describe("which negative changes count as a loss", () => {
  it("leaves out a record whose direction says the tier widened, of any type", () => {
    for (const type of ["limits_reduced", "free_tier_removed", "restriction", "pricing_restructured"]) {
      assert.strictEqual(countsAsALoss(change(type, { tier_direction: "widened" })), false, type);
      assert.strictEqual(countsAsALoss(change(type)), true, type);
    }
  });

  it("leaves out a free-tier record whose direction says the tier did not move, and keeps a price record that says so", () => {
    assert.strictEqual(countsAsALoss(change("limits_reduced", { tier_direction: "unchanged" })), false);
    assert.strictEqual(countsAsALoss(change("free_tier_removed", { tier_direction: "unchanged" })), false);
    assert.strictEqual(countsAsALoss(change("pricing_restructured", { tier_direction: "unchanged" })), true);
    assert.strictEqual(countsAsALoss(change("pricing_model_change", { tier_direction: "unchanged" })), true);
  });

  it("keeps a narrowed record, and counts nothing that is not a negative change", () => {
    assert.strictEqual(countsAsALoss(change("limits_reduced", { tier_direction: "narrowed" })), true);
    assert.strictEqual(countsAsALoss(change("limits_increased")), false);
    assert.strictEqual(countsAsALoss(change("product_deprecated", { listing_effect: "none" })), false);
    assert.strictEqual(countsAsALoss(change("product_deprecated", { listing_effect: "ends" })), true);
  });
});

const MONTH = "2024-07";
const SOURCE = (vendor: string) => `https://${vendor.toLowerCase().replace(/[^a-z]+/g, "")}.example/pricing`;

const record = (vendor: string, change_type: string, day: number, fields: Record<string, unknown> = {}) => ({
  vendor,
  change_type,
  date: `${MONTH}-${String(day).padStart(2, "0")}`,
  recorded_date: `${MONTH}-28`,
  date_source: "hand_written",
  summary: `${vendor} changed its terms on day ${day}.`,
  previous_state: "Earlier terms.",
  current_state: "New terms.",
  impact: "medium",
  source_url: SOURCE(vendor),
  category: "Databases",
  alternatives: [],
  ...fields,
});

const listing = (vendor: string, tier: string) => ({
  vendor,
  category: "Databases",
  description: `${vendor} publishes its plans on its pricing page.`,
  tier,
  url: SOURCE(vendor),
  tags: [],
  verifiedDate: `${MONTH}-28`,
});

const PAID_ONLY = "Ledgerline API";
const REMOVED = "Quillstack DB";
const NARROWED = "Tallyforge";
const BOTH = "Corvid Hosting";
const REVIEWED_UNCHANGED = "Harborlight";
const UNDIRECTED = "Pinecrest Cloud";
const WIDENED = "Ottermark";
const UNMOVED_RESTRICTION = "Sablewing";
const ONE_OF_TWO = "Driftwood";

const LISTINGS = [
  listing(PAID_ONLY, "Pay-as-you-go"),
  listing(REMOVED, "Free"),
  listing(NARROWED, "Free"),
  listing(BOTH, "Pay-as-you-go"),
  listing(REVIEWED_UNCHANGED, "Free"),
  listing(UNDIRECTED, "Free"),
  listing(WIDENED, "Free"),
  listing(UNMOVED_RESTRICTION, "Free"),
  listing(ONE_OF_TWO, "Free"),
];

const REVIEWED_RECORD = record(REVIEWED_UNCHANGED, "pricing_restructured", 9);

const RECORDS = [
  record(PAID_ONLY, "pricing_restructured", 3),
  record(REMOVED, "free_tier_removed", 4),
  record(NARROWED, "pricing_restructured", 5, { tier_direction: "narrowed" }),
  record(BOTH, "pricing_restructured", 6),
  record(BOTH, "free_tier_removed", 7),
  REVIEWED_RECORD,
  record(UNDIRECTED, "pricing_model_change", 10),
  record(WIDENED, "limits_reduced", 11, { tier_direction: "widened" }),
  record(UNMOVED_RESTRICTION, "restriction", 12, { tier_direction: "unchanged" }),
  record(ONE_OF_TWO, "limits_reduced", 13, { tier_direction: "narrowed" }),
  record(ONE_OF_TWO, "limits_reduced", 14, { tier_direction: "widened" }),
];

const REVIEW = {
  reviewed: `${MONTH}-28`,
  review: "Fixture review.",
  directions: [{
    vendor: REVIEWED_RECORD.vendor,
    change_type: REVIEWED_RECORD.change_type,
    date: REVIEWED_RECORD.date,
    source_url: REVIEWED_RECORD.source_url,
    tier_direction: "unchanged",
    finding: "The record moves a paid price.",
  }],
};

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const found = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(found[1]!, 10) }); }
    });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function entryOf(losers: string, vendor: string): string | null {
  const found = losers.match(new RegExp(`<strong>${vendor}</strong> \\(([^)]*)\\)`));
  return found ? found[1]! : null;
}

describe(`/reports/${MONTH} labels each Biggest Losers entry by what the change did`, () => {
  let dir = "";
  let proc: ChildProcess | null = null;
  let report = "";
  let losers = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "report-loss-labels-"));
    const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    catalogue.offers.push(...LISTINGS);
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(catalogue));
    writeFileSync(path.join(dir, "changes.json"), JSON.stringify({ changes: RECORDS }));
    writeFileSync(path.join(dir, "directions.json"), JSON.stringify(REVIEW));
    const server = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(dir, "changes.json"),
      AGENTDEALS_CHANGE_DIRECTIONS_PATH: path.join(dir, "directions.json"),
    });
    proc = server.proc;
    const response = await fetch(`http://localhost:${server.port}/reports/${MONTH}`);
    assert.strictEqual(response.status, 200, `/reports/${MONTH} answered ${response.status}`);
    report = await response.text();
    const start = report.indexOf("<h2>Biggest Losers</h2>");
    assert.ok(start >= 0, "the report has no Biggest Losers");
    losers = report.slice(start, report.indexOf("<h2>", start + 1));
  });

  after(() => {
    proc?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("describes the box as changes that cost users more, not as free-tier cuts", () => {
    assert.ok(losers.includes(`<p class="section-desc">${LOSSES_SECTION_DESCRIPTION}</p>`), losers.slice(0, 300));
    assert.strictEqual(LOSSES_SECTION_DESCRIPTION, "Vendors whose changes cost users more");
    assert.ok(!report.includes("eliminated or reduced free tiers"), "the old description is still on the page");
  });

  it("labels a price change on a listing that is not a free tier as a paid-price change", () => {
    assert.strictEqual(entryOf(losers, PAID_ONLY), "1 negative change: paid pricing changed");
  });

  it("still says so when a record removed or reduced the free tier we list", () => {
    assert.strictEqual(entryOf(losers, REMOVED), "1 negative change: free tier removed");
    assert.strictEqual(entryOf(losers, NARROWED), "1 negative change: free tier reduced");
  });

  it("joins two kinds of change once each, free-tier change first, whatever the order of the records", () => {
    assert.strictEqual(entryOf(losers, BOTH), "2 negative changes: free tier removed; paid pricing changed");
  });

  it("reads a reviewed direction for a record that carries none", () => {
    assert.strictEqual(entryOf(losers, REVIEWED_UNCHANGED), "1 negative change: paid pricing changed");
    assert.strictEqual(entryOf(losers, UNDIRECTED), "1 negative change: pricing changed");
  });

  it("leaves out a widened record and a free-tier record that did not move, and counts only the loss beside a widened record", () => {
    assert.strictEqual(entryOf(losers, WIDENED), null, `${WIDENED} is listed though its only record widened the tier`);
    assert.strictEqual(entryOf(losers, UNMOVED_RESTRICTION), null, `${UNMOVED_RESTRICTION} is listed though its record left the tier as it was`);
    assert.strictEqual(entryOf(losers, ONE_OF_TWO), "1 negative change: free tier limits reduced");
  });

  it("keeps every negative record in the month's Negative count", () => {
    const negative = report.match(/<div class="stat-value stat-neg">(\d+)<\/div><div class="stat-label">Negative/);
    assert.ok(negative, "the report states no Negative count");
    assert.strictEqual(Number(negative![1]), RECORDS.length);
  });
});

describe("every monthly report names what each Biggest Losers entry's changes did", () => {
  let proc: ChildProcess | null = null;
  const entries: { month: string; vendor: string; count: number; labels: string | undefined }[] = [];

  before(async () => {
    const server = await startServer({});
    proc = server.proc;
    const index = await fetch(`http://localhost:${server.port}/reports`).then((r) => r.text());
    const months = [...new Set([...index.matchAll(/href="\/reports\/(\d{4}-\d{2})"/g)].map((m) => m[1]!))];
    for (const month of months) {
      const page = await fetch(`http://localhost:${server.port}/reports/${month}`).then((r) => r.text());
      const start = page.indexOf("<h2>Biggest Losers</h2>");
      if (start < 0) continue;
      const box = page.slice(start, page.indexOf("<h2>", start + 1));
      for (const m of box.matchAll(/<li><strong>([^<]*)<\/strong> \((\d+) negative changes?(?:: ([^)]*))?\)<ul>/g)) {
        entries.push({ month, vendor: m[1]!, count: Number(m[2]), labels: m[3] });
      }
    }
  });

  after(() => {
    proc?.kill();
  });

  function labelsIn(text: string): string[] | null {
    const longestFirst = [...LOSS_LABELS].sort((a: string, b: string) => b.length - a.length);
    const found: string[] = [];
    let rest = text;
    while (rest !== "") {
      const label = longestFirst.find((l: string) => rest === l || rest.startsWith(`${l}; `));
      if (!label) return null;
      found.push(label);
      rest = rest.slice(label.length).replace(/^; /, "");
    }
    return found;
  }

  it("gives every entry its labels, each once and in the table's order", () => {
    assertPopulationFloor(entries.length, 60, "Biggest Losers entries across the monthly reports");
    for (const entry of entries) {
      const where = `${entry.vendor} on /reports/${entry.month}`;
      assert.ok(entry.labels, `${where} names no kind of change`);
      const labels = labelsIn(entry.labels!);
      assert.ok(labels, `${where} carries "${entry.labels}", which is not a list of the labels`);
      const ordered = LOSS_LABELS.filter((label: string) => labels!.includes(label));
      assert.deepStrictEqual(labels, ordered, `${where} lists its labels out of order or twice`);
      assert.ok(labels.length <= entry.count, `${where} gives more labels than changes`);
    }
  });
});
