import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { statementsWeHold, figureProvenanceAgainst, NO_RECORD_BEHIND_THIS_FIGURE, FIGURE_NOT_IN_OUR_RECORD } =
  await import("../dist/figure-provenance.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const OUR_RECORD = null;

const PRICE_RISE = {
  summary: "The smallest machine went from $1.94 to $2.19 a month.",
  previous_state: "$1.94",
  current_state: "$2.19",
};

const RETRACTED = { state: "retracted", date: "2026-10-02" };

describe("a figure counts as our record only where a record we stand behind states it as current", () => {
  it("calls a row still showing the price a recorded rise replaced hand-typed", () => {
    assert.strictEqual(figureProvenanceAgainst("$1.94/mo", statementsWeHold([], [PRICE_RISE])), FIGURE_NOT_IN_OUR_RECORD);
  });

  it("calls a row showing the price the rise set our record", () => {
    assert.strictEqual(figureProvenanceAgainst("$2.19/mo", statementsWeHold([], [PRICE_RISE])), OUR_RECORD);
  });

  it("calls the same row hand-typed once the record is retracted", () => {
    const held = statementsWeHold([], [{ ...PRICE_RISE, resolution: RETRACTED }]);
    assert.strictEqual(figureProvenanceAgainst("$2.19/mo", held), NO_RECORD_BEHIND_THIS_FIGURE);
  });

  it("keeps reading the listing when the vendor's record is retracted", () => {
    const held = statementsWeHold(["Machines from $2.19/mo"], [{ ...PRICE_RISE, current_state: "$2.49", resolution: RETRACTED }]);
    assert.strictEqual(figureProvenanceAgainst("$2.19/mo", held), OUR_RECORD);
    assert.strictEqual(figureProvenanceAgainst("$2.49/mo", held), FIGURE_NOT_IN_OUR_RECORD);
  });

  it("vouches for no row that states no quantity to check", () => {
    const held = statementsWeHold(["Free Plan with 500 hours a month"], []);
    assert.strictEqual(figureProvenanceAgainst("Free Plan", held), FIGURE_NOT_IN_OUR_RECORD);
  });

  it("says we hold no record for a vendor with neither a listing nor a record", () => {
    assert.strictEqual(figureProvenanceAgainst("$5/mo", statementsWeHold([], [])), NO_RECORD_BEHIND_THIS_FIGURE);
  });
});

const VENDOR_IN_FORCE = "Provenance Fixture Hosting";
const VENDOR_RETRACTED = "Provenance Fixture Retracted Hosting";

function priceRiseRecordFor(vendor: string, resolution?: typeof RETRACTED) {
  return {
    vendor,
    change_type: "pricing_restructured",
    date: "2026-09-15",
    ...PRICE_RISE,
    impact: "medium",
    source_url: "https://example.com/pricing",
    category: "Cloud Hosting",
    alternatives: [],
    recorded_date: "2026-09-15",
    date_source: "vendor_page",
    ...(resolution ? { resolution } : {}),
  };
}

function servedProvenance(changesPath: string, claims: Array<[string, string]>): Array<string | null> {
  const serveModule = pathToFileURL(path.join(REPO, "dist", "serve.js")).href;
  const run = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(serveModule)});`
        + `process.stdout.write(JSON.stringify(${JSON.stringify(claims)}.map(([claim, vendor]) => m.figureProvenance(claim, vendor))));`
        + "process.exit(0);",
    ],
    {
      cwd: REPO,
      env: { ...process.env, AGENTDEALS_CHANGES_PATH: changesPath, PORT: "0", BASE_URL: "http://localhost:3000", TZ: "UTC" },
      encoding: "utf-8",
      timeout: 120000,
    },
  );
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

describe("the alternatives table's provenance reads only the current state of records we stand behind", () => {
  let tmp = "";
  let labels: Array<string | null> = [];

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "figure-provenance-"));
    const store = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    store.changes.push(priceRiseRecordFor(VENDOR_IN_FORCE), priceRiseRecordFor(VENDOR_RETRACTED, RETRACTED));
    const changesPath = path.join(tmp, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify(store));
    labels = servedProvenance(changesPath, [
      ["$1.94/mo", VENDOR_IN_FORCE],
      ["$2.19/mo", VENDOR_IN_FORCE],
      ["$2.19/mo", VENDOR_RETRACTED],
    ]);
  });

  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("calls a row at the price a record replaced hand-typed, though the record's summary and previous state name it", () => {
    assert.strictEqual(labels[0], FIGURE_NOT_IN_OUR_RECORD);
  });

  it("calls a row at the price the record set our record", () => {
    assert.strictEqual(labels[1], OUR_RECORD);
  });

  it("calls a row hand-typed when the only record behind its price is retracted", () => {
    assert.strictEqual(labels[2], NO_RECORD_BEHIND_THIS_FIGURE);
  });
});
