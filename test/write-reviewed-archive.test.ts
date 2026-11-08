import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { writeReviewedArchive, reviewedRecordKey } = await import("../scripts/write-reviewed-archive.js");
const { correctionUsesListingPage, requireListingPage, settleFirstReadings } = await import("../scripts/settle-discovered-records.js");
const { archiveSettlementSummary } = await import("../scripts/run-archive-settlement.js");
type Row = Record<string, any>;
const approved = JSON.parse(readFileSync(new URL("../artifacts/archive-settlement/reviewed-2026-11-08.json", import.meta.url), "utf8"));
const record = (fields: Row = {}): Row => ({ vendor: "Example", date: "2026-09-01", change_type: "limits_reduced", date_source: "discovered", source_url: "https://example.test/pricing", previous_state: "3 projects", current_state: "1 project", summary: "A lower limit", ...fields });
const result = (fields: Row = {}): Row => ({ ...record(), outcome: "ours", text_day: "2026-02-01", capture: { url: "https://archive.test/settling", day: "2026-01-01" }, stated_then: [{ record: "1 project", old: "Free: 1 project" }], readings: [{ older: "capture", verdict: { status: "stated" } }], historical_proof: { readings: [{ url: "https://archive.test/witness", day: "2025-01-01", verdict: { status: "stated", stated_then: [{ record: "1 project", old: "Free: 1 project" }] } }] }, ...fields });
const report = (results = [result()]): Row => ({ version: 1, today: "2026-11-08", review_url: approved.review_url, results });
const offers = [{ vendor: "Example", url: "https://example.test/pricing" }];

describe("corrections use a vendor listing's page", () => {
  it("ignores scheme, www, query, fragment and the trailing slash, and accepts any listing of the same vendor", () => {
    const listings = [{ vendor: "Other", url: "https://example.test/" }, ...offers, { vendor: "Example", url: "https://example.test/startups" }];
    for (const source_url of ["http://www.example.test/pricing/?tab=free#limits", "https://example.test/startups/"]) assert.equal(correctionUsesListingPage(record({ source_url }), listings), true);
    for (const source_url of ["https://example.test/", "https://other.test/pricing", "https://example.test/Pricing", "invalid", "file:///pricing"]) assert.equal(correctionUsesListingPage(record({ source_url }), listings), false);
    assert.equal(correctionUsesListingPage(record(), []), false);
    assert.equal(correctionUsesListingPage(record(), [{ vendor: "Other", url: record().source_url }]), false);
  });

  it("retains the readings and reports why an otherwise proved correction is unsettled", async () => {
    const source = "https://localazy.test/";
    const change = record({ source_url: source });
    const readings: Row[] = [];
    const checked = await settleFirstReadings({
      changes: [change], offers: [{ vendor: change.vendor, url: "https://localazy.test/pricing" }], today: "2026-11-08", logReads: true,
      archive: { captures: async () => ({ captures: ["20250101120000", "20260101120000"].map((timestamp) => ({ timestamp, original: source, statuscode: "200", mimetype: "text/html" })) }), captureHtml: async () => ({ html: `<p>Free: 1 project. ${"Pricing and plan limits. ".repeat(50)}</p>` }) },
      pairReaderForListing: () => async () => ({ status: "same", old_terms: ["Free: 1 project"], new_terms: ["Free: 1 project"] }),
      statedReaderForRecord: () => async () => ({ status: "stated", stated_then: [{ record: "1 project", old: "Free: 1 project" }] }),
      fetchToday: async () => ({ ok: true, text: "Free: 1 project" }), textDayOf: () => "2026-02-01", badgeSetBy: () => "caution", onSettled: (row: Row) => readings.push(row),
    });
    const [row] = checked.results;
    assert.equal(row.outcome, "no_usable_capture");
    assert.match(row.why, /not a listing page/);
    assert.equal(row.split, "no usable capture, set a badge: to review");
    assert.equal(row.readings.length, 3);
    assert.equal(row.historical_proof.readings.length, 1);
    assert.deepEqual(row.stated_then, [{ record: "1 project", old: "Free: 1 project" }]);
    assert.equal(readings[0], row);
    assert.match(archiveSettlementSummary(checked), /not a listing page/);
  });

  it("does not change the saved proof objects of matching corrections or non-correction outcomes", () => {
    const settled = result();
    assert.equal(requireListingPage(settled, record(), offers), settled);
    for (const outcome of ["vendor_changed", "removal_stated_before", "reader_failed", "no_usable_capture"]) {
      const unchanged = { ...settled, outcome };
      assert.equal(requireListingPage(unchanged, record(), []), unchanged);
    }
  });
});

describe("writing the exact reviewed archive report", () => {
  it("keys approval by vendor, date and type, preserving corrected current text and every unapproved record", () => {
    const current = record({ summary: "Corrected summary", current_state: "Corrected terms", archive_check: { outcome: "no_usable_capture" } });
    const unrelated = record({ vendor: "Unapproved" });
    const settled = record({ vendor: "Settled", archive_check: { outcome: "ours" } });
    const written = writeReviewedArchive([current, unrelated, settled], report(), offers);
    assert.deepEqual(written.written.map(reviewedRecordKey), [reviewedRecordKey(current)]);
    assert.equal(written.changes[0].current_state, current.current_state);
    assert.equal(written.changes[0].change_type, "record_corrected");
    assert.deepEqual(written.changes[0].archive_check.historical_proof, result().historical_proof);
    assert.equal(written.changes[1], unrelated);
    assert.equal(written.changes[2], settled);
  });

  it("refuses the entire report on missing, ambiguous, duplicated, settled, retracted or mismatched keys", () => {
    const cases = [[], [record(), record()], [record({ date: "2026-09-02" })], [record({ change_type: "pricing_restructured" })], [record({ vendor: "Changed" })], [record({ resolution: { state: "retracted" } })], [record({ archive_check: { outcome: "vendor_changed" } })], [record({ source_url: "https://example.test/" })]];
    for (const changes of cases) {
      const before = structuredClone(changes);
      assert.throws(() => writeReviewedArchive(changes, report(), offers));
      assert.deepEqual(changes, before);
    }
    assert.throws(() => writeReviewedArchive([record()], report([result(), result()]), offers), /duplicate/);
    for (const fields of [{ outcome: "vendor_changed" }, { stated_then: [] }, { historical_proof: {} }, { readings: [] }]) assert.throws(() => writeReviewedArchive([record()], report([result(fields)]), offers));
    assert.throws(() => writeReviewedArchive([record()], { ...report(), review_url: "" }, offers));
    assert.throws(() => writeReviewedArchive([record()], report([]), offers));
  });

  it("contains exactly the eleven approved identities, including Hex, without Localazy or audit results", () => {
    assert.deepEqual(approved.results.map((row: Row) => row.vendor), ["Penpot", "mailinator.com", "Grafana Loki", "Invantive Cloud", "Mapbox", "webhook.site", "Supermaven", "Glauca", "Internxt", "LastPass", "Hex"]);
    const changes = approved.results.map((row: Row) => record({ vendor: row.vendor, date: row.date, change_type: row.change_type, source_url: row.source_url, current_state: "Current reviewed text", summary: "Updated summary" }));
    const listings = changes.map((row: Row) => ({ vendor: row.vendor, url: row.source_url }));
    const written = writeReviewedArchive(changes, approved, listings);
    assert.equal(written.written.length, 11);
    for (const [at, row] of written.changes.entries()) {
      assert.equal(row.current_state, "Current reviewed text");
      assert.deepEqual(row.archive_check.historical_proof, approved.results[at].historical_proof);
    }
  });

  it("runs the actual CLI from committed bytes, refuses a working copy edit, and leaves failed batches unchanged", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "reviewed-archive-"));
    const script = fileURLToPath(new URL("../scripts/write-reviewed-archive.js", import.meta.url));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", scratch, ...args], { stdio: "pipe" });
    try {
      mkdirSync(path.join(scratch, "data"));
      const log = path.join(scratch, "data/deal_changes.json");
      const reviewFile = path.join(scratch, "reviewed.json");
      const seed = () => writeFileSync(log, JSON.stringify({ changes: [record({ current_state: "Corrected terms" }), record({ vendor: "Unapproved" })] }));
      seed();
      writeFileSync(path.join(scratch, "data/index.json"), JSON.stringify({ offers }));
      writeFileSync(reviewFile, JSON.stringify(report()));
      git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "Reviewed report");
      const run = () => spawnSync(process.execPath, [script, "reviewed.json"], { cwd: scratch, env: { ...process.env, AGENTDEALS_CHANGES_PATH: log, OPENROUTER_API_KEY: "", NODE_OPTIONS: "" }, encoding: "utf8" });
      let completed = run();
      assert.equal(completed.status, 0, completed.stderr);
      assert.match(completed.stdout, /exactly 1 reviewed corrections/);
      const written = JSON.parse(readFileSync(log, "utf8")).changes;
      assert.equal(written[0].current_state, "Corrected terms");
      assert.equal(written[0].change_type, "record_corrected");
      assert.equal(written[1].change_type, "limits_reduced");
      seed();
      const before = readFileSync(log);
      writeFileSync(reviewFile, JSON.stringify(report([result({ vendor: "Unapproved" })])));
      completed = run();
      assert.equal(completed.status, 1);
      assert.match(completed.stderr, /committed bytes/);
      assert.deepEqual(readFileSync(log), before);
      writeFileSync(reviewFile, JSON.stringify(report([result(), result({ vendor: "Missing" })])));
      git("add", "reviewed.json"); git("commit", "-qm", "Unmatched key");
      completed = run();
      assert.equal(completed.status, 1);
      assert.match(completed.stderr, /found 0/);
      assert.deepEqual(readFileSync(log), before);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
