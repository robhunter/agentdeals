import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { writeReviewedArchive } = await import("../scripts/write-reviewed-archive.js");
type Row = Record<string, any>;
const vendorReport = JSON.parse(readFileSync(new URL("../artifacts/archive-settlement/reviewed-vendor-changes-2026-11-08.json", import.meta.url), "utf8"));
const dispositionReport = JSON.parse(readFileSync(new URL("../artifacts/archive-settlement/reviewed-dispositions-2026-11-08.json", import.meta.url), "utf8"));
function mixedReport(): Row {
  const vendor = structuredClone(vendorReport.results[0]);
  vendor.operation = "vendor_change";
  for (const bracket of vendor.brackets) bracket.claim_proof.older.verdict.current_values_checked = true;
  const disposition = { ...structuredClone(dispositionReport.results[0]), operation: "disposition" };
  return { version: 4, today: "2026-11-09", review_url: dispositionReport.review_url, results: [vendor, disposition] };
}
const records = (report: Row): Row[] => report.results.map((row: Row) => structuredClone(row.expected_record));

describe("mixed reviewed archive operations", () => {
  it("replaces only approved rows in catalogue order, preserving terms, retained brackets and both new endpoint proofs", () => {
    const report = mixedReport();
    const [vendor, disposition] = records(report);
    const extra = { ...vendor, vendor: "Unreviewed" };
    const changes = [disposition, extra, vendor];
    const before = structuredClone(changes);
    const written = writeReviewedArchive(changes, report, []);
    assert.equal(written.changes.length, changes.length);
    assert.deepEqual(written.written.map((row: Row) => row.vendor), report.results.map((row: Row) => row.vendor));
    assert.deepEqual(written.not_written, []);
    assert.deepEqual(written.changes[0], { ...disposition, archive_check: { ...disposition.archive_check, checked: report.today, brackets: [disposition.archive_check.brackets[1]] } });
    assert.equal(written.changes[1], extra);
    const bracket = report.results[0].brackets[0];
    assert.deepEqual(written.changes[2], { ...vendor, date: "2026-07-05", archive_check: { checked: report.today, outcome: "vendor_changed", brackets: [{ last_old: bracket.last_old, first_new: bracket.first_new, last_old_capture: bracket.last_old_capture, first_new_capture: bracket.first_new_capture, claim_proof: bracket.claim_proof }] } });
    assert.deepEqual(changes, before);
    assert.equal(Object.hasOwn(written.changes[2], "operation"), false);
    report.results.reverse();
    assert.deepEqual(writeReviewedArchive(changes, report, []).changes, written.changes);
  });

  it("requires explicit valid operations and refuses crossed modes and duplicate approvals", () => {
    for (const operation of [undefined, "", "ours", "correction", 2, {}]) {
      const report = mixedReport();
      report.results[0].operation = operation;
      assert.throws(() => writeReviewedArchive(records(report), report, []), /explicit/);
    }
    for (const index of [0, 1]) {
      const report = mixedReport();
      report.results[index].operation = index === 0 ? "disposition" : "vendor_change";
      assert.throws(() => writeReviewedArchive(records(report), report, []), /published vendor change|already settled/);
    }
    const report = mixedReport();
    report.results.push({ ...report.results[0], operation: "disposition" });
    assert.throws(() => writeReviewedArchive(records(report).slice(0, 2), report, []), /duplicate/);
    for (const version of [0, 5, "4"]) assert.throws(() => writeReviewedArchive(records(report), { ...report, version }, []), /identify its approval/);
  });

  it("preflights stale records and rejected claims in either operation order without mutating inputs", () => {
    const corruptions = [
      (report: Row) => { report.results[0].expected_record.summary = "Changed terms"; },
      (report: Row) => { report.results[1].expected_record.summary = "Changed terms"; },
      (report: Row) => { report.results[0].brackets[0].claim_proof.older.verdict.status = "unknown"; },
      (report: Row) => { report.results[0].brackets[0].claim_proof.older.verdict.current_values_checked = false; },
      (report: Row) => { report.results[0].brackets[0].claim_proof.newer.verdict.status = "unstated"; },
      (report: Row) => { report.results[0].brackets[0].claim_proof.newer.day = "2026-07-06"; },
      (report: Row) => { report.results[0].date_from_captures = "2026-07-06"; },
      (report: Row) => { report.results[1].brackets[0].first_new = "2026-08-28"; },
      (report: Row) => { report.results[1].brackets = []; },
    ];
    for (const corrupt of corruptions) for (const reverse of [false, true]) {
      const report = mixedReport();
      const changes = records(report);
      const before = structuredClone(changes);
      corrupt(report);
      if (reverse) report.results.reverse();
      assert.throws(() => writeReviewedArchive(changes, report, []));
      assert.deepEqual(changes, before);
    }
  });

  it("commits both operations through the real CLI and leaves every store unchanged on a late stale record, retry or edited report", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "mixed-reviewed-"));
    const script = fileURLToPath(new URL("../scripts/write-reviewed-archive.js", import.meta.url));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", scratch, ...args], { stdio: "pipe" });
    try {
      mkdirSync(path.join(scratch, "data"));
      const report = mixedReport();
      const changes = records(report);
      const seed = { generated: report.today, changes };
      const log = path.join(scratch, "data/deal_changes.json");
      const directions = path.join(scratch, "data/change_directions.json");
      const index = path.join(scratch, "data/index.json");
      const reportPath = path.join(scratch, "reviewed.json");
      writeFileSync(log, JSON.stringify(seed));
      writeFileSync(directions, JSON.stringify({ directions: changes.map(row => ({ vendor: row.vendor, date: row.date, change_type: row.change_type, source_url: row.source_url, tier_direction: "unchanged" })) }));
      writeFileSync(index, JSON.stringify({ offers: [] }));
      writeFileSync(reportPath, JSON.stringify(report));
      git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "Reviewed mixed operations");
      const run = () => spawnSync(process.execPath, [script, "reviewed.json"], { cwd: scratch, env: { ...process.env, AGENTDEALS_CHANGES_PATH: log, AGENTDEALS_CHANGE_DIRECTIONS_PATH: directions, OPENROUTER_API_KEY: "", NODE_OPTIONS: "" }, encoding: "utf8" });
      const initialDirections = readFileSync(directions);
      const initialIndex = readFileSync(index);
      const stale = structuredClone(seed);
      stale.changes[1].summary = "Changed terms";
      writeFileSync(log, JSON.stringify(stale));
      const before = readFileSync(log);
      let completed = run();
      assert.equal(completed.status, 1);
      assert.match(completed.stderr, /record changed/);
      assert.deepEqual(readFileSync(log), before);
      assert.deepEqual(readFileSync(directions), initialDirections);
      writeFileSync(log, JSON.stringify(seed));
      completed = run();
      assert.equal(completed.status, 0, completed.stderr);
      assert.match(completed.stdout, /exactly 2 reviewed operations/);
      const actual = JSON.parse(readFileSync(log, "utf8"));
      assert.equal(actual.changes[0].date, "2026-07-05");
      assert.deepEqual(actual.changes[1].archive_check.brackets, [changes[1].archive_check.brackets[1]]);
      assert.deepEqual(JSON.parse(readFileSync(directions, "utf8")).directions, JSON.parse(initialDirections.toString()).directions.slice(1));
      assert.deepEqual(readFileSync(index), initialIndex);
      const after = readFileSync(log);
      const afterDirections = readFileSync(directions);
      completed = run();
      assert.equal(completed.status, 1);
      assert.deepEqual(readFileSync(log), after);
      assert.deepEqual(readFileSync(directions), afterDirections);
      writeFileSync(reportPath, JSON.stringify({ ...report, today: "2026-11-10" }));
      completed = run();
      assert.equal(completed.status, 1);
      assert.match(completed.stderr, /committed bytes/);
      assert.deepEqual(readFileSync(log), after);
      assert.deepEqual(readFileSync(directions), afterDirections);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

const reviewedPair = JSON.parse(readFileSync(new URL("../artifacts/archive-settlement/reviewed-resend-infisical-2026-11-09.json", import.meta.url), "utf8"));
describe("the reviewed Resend and Infisical batch", () => {
  it("dates only Resend to August 20 and removes only Infisical's July 25 to 29 bracket", () => {
    assert.equal(reviewedPair.version, 4);
    assert.deepEqual(reviewedPair.results.map((row: Row) => [row.vendor, row.operation]), [["Resend", "vendor_change"], ["Infisical", "disposition"]]);
    const changes = records(reviewedPair);
    const before = structuredClone(changes);
    const written = writeReviewedArchive(changes, reviewedPair, []);
    const resend = written.changes[0];
    assert.equal(resend.date, "2026-08-20");
    assert.deepEqual(resend.archive_check.brackets.map((b: Row) => [b.last_old, b.first_new]), [["2026-08-19", "2026-08-20"]]);
    assert.deepEqual(resend.archive_check.brackets[0].rejected_older_endpoints.map((row: Row) => [row.day, row.verdict.status]), [["2026-08-21", "new_stated"]]);
    for (const field of ["summary", "previous_state", "current_state", "recorded_date", "change_type", "source_url"]) assert.equal(resend[field], before[0][field]);
    const infisical = written.changes[1];
    assert.deepEqual(infisical, { ...before[1], archive_check: { ...before[1].archive_check, checked: reviewedPair.today, brackets: [before[1].archive_check.brackets[0]] } });
    assert.deepEqual(infisical.archive_check.brackets.map((b: Row) => [b.last_old, b.first_new]), [["2026-07-16", "2026-07-25"]]);
    assert.deepEqual(changes, before);
  });
});
