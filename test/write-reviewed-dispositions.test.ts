import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { writeReviewedArchive, directionReviewsAfterWrite } = await import("../scripts/write-reviewed-archive.js");
type Row = Record<string, any>;
const approved = JSON.parse(readFileSync(new URL("../artifacts/archive-settlement/reviewed-dispositions-2026-11-08.json", import.meta.url), "utf8"));
const records = () => approved.results.map((row: Row) => structuredClone(row.expected_record));
const extra = { ...records()[0], vendor: "Unreviewed" };

describe("reviewed dispositions of published archive checks", () => {
  it("drops only the two specified brackets and unsettles only the three specified records without moving terms or dates", () => {
    const changes = [...records(), extra];
    const before = structuredClone(changes);
    const written = writeReviewedArchive(changes, approved, []);
    assert.deepEqual(written.written.map((row: Row) => row.vendor), ["Prisma Accelerate", "Cypress Cloud", "Bench", "userforge.com", "tabler-icons.io"]);
    assert.equal(written.not_written.length, 0);
    assert.equal(written.review.length, 0);
    for (const [at, row] of written.changes.slice(0, 5).entries()) {
      const { archive_check, ...terms } = row;
      const { archive_check: previous, ...expectedTerms } = before[at];
      assert.deepEqual(terms, expectedTerms);
      if (at < 2) {
        assert.deepEqual(archive_check, { ...previous, checked: approved.today, brackets: [previous.brackets[1]] });
      } else assert.deepEqual(archive_check, { checked: approved.today, outcome: "no_usable_capture" });
    }
    assert.deepEqual(written.changes.slice(0, 2).map((row: Row) => row.archive_check.brackets.map((b: Row) => [b.last_old, b.first_new])), [[["2026-07-31", "2026-08-27"]], [["2026-08-28", "2026-09-07"]]]);
    assert.equal(written.changes[5], extra);
    assert.deepEqual(changes, before);
    const directions = { reviewed: "2026-11-01", directions: changes.map((row: Row) => ({ ...row, tier_direction: "unchanged" })) };
    assert.deepEqual(directionReviewsAfterWrite(directions, changes, written.changes), directions);
  });

  it("refuses stale snapshots, resolutions, other outcomes and retries without changing any input", () => {
    const variants = [
      { summary: "Revised text" }, { date: "2026-09-06" }, { source_url: "https://other.test/pricing" },
      { archive_check: { checked: "2026-11-09", outcome: "vendor_changed" } },
      { resolution: { state: "retracted" } }, { resolution: { state: "reversed" } },
    ];
    for (const fields of variants) {
      const changes = records();
      Object.assign(changes[4], fields);
      const before = structuredClone(changes);
      assert.throws(() => writeReviewedArchive(changes, approved, []));
      assert.deepEqual(changes, before);
    }
    for (const outcome of ["ours", "removal_stated_before", "no_usable_capture", "reader_failed"]) {
      const changes = records();
      changes[4].archive_check.outcome = outcome;
      const report = structuredClone(approved);
      report.results[4].expected_record = structuredClone(changes[4]);
      assert.throws(() => writeReviewedArchive(changes, report, []), /published vendor change/);
    }
    const written = writeReviewedArchive(records(), approved, []);
    const before = structuredClone(written.changes);
    assert.throws(() => writeReviewedArchive(written.changes, approved, []), /record changed/);
    assert.deepEqual(written.changes, before);
  });

  it("requires an exact ordered nonempty subset and cannot add, rewrite or duplicate a bracket", () => {
    const changes = records();
    const held = changes[0].archive_check.brackets;
    for (const brackets of [undefined, [], held, [...held, held[0]], [held[1], held[1]], [{ ...held[1], first_new: "2026-08-28" }], [{ ...held[1], first_new_capture: "https://other.test/" }]]) {
      const report = structuredClone(approved);
      report.results[0].brackets = brackets;
      assert.throws(() => writeReviewedArchive(changes, report, []), /subset|exactly and in order/);
    }
    const report = structuredClone(approved);
    const third = { ...held[1], last_old: "2026-08-01" };
    changes[0].archive_check.brackets.push(third);
    report.results[0].expected_record = structuredClone(changes[0]);
    report.results[0].brackets = [third, held[0]];
    assert.throws(() => writeReviewedArchive(changes, report, []), /exactly and in order/);
  });

  it("refuses correction, removal or unknown verdicts and retained brackets on an unsettled result", () => {
    for (const outcome of ["ours", "removal_stated_before", "reader_failed", "unknown", undefined]) {
      const report = structuredClone(approved);
      report.results[4].outcome = outcome;
      assert.throws(() => writeReviewedArchive(records(), report, []), /only drop brackets or unsettle/);
    }
    const report = structuredClone(approved);
    report.results[4].brackets = [];
    assert.throws(() => writeReviewedArchive(records(), report, []), /cannot retain brackets/);
    report.results = [report.results[0], report.results[0]];
    assert.throws(() => writeReviewedArchive(records(), report, []), /duplicate/);
    const changes = records();
    assert.throws(() => writeReviewedArchive([...changes, changes[0]], approved, []), /found 2/);
    assert.throws(() => writeReviewedArchive(changes.slice(0, 4), approved, []), /found 0/);
  });

  it("runs the committed report through the CLI and leaves all stores untouched on stale batches, retries and edited reports", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "reviewed-dispositions-"));
    const script = fileURLToPath(new URL("../scripts/write-reviewed-archive.js", import.meta.url));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", scratch, ...args], { stdio: "pipe" });
    try {
      mkdirSync(path.join(scratch, "data"));
      const log = path.join(scratch, "data/deal_changes.json");
      const directions = path.join(scratch, "data/change_directions.json");
      const index = path.join(scratch, "data/index.json");
      const report = path.join(scratch, "reviewed.json");
      const seed = { generated: "2026-11-08", changes: [...records(), extra] };
      const seedLog = () => writeFileSync(log, JSON.stringify(seed));
      seedLog();
      writeFileSync(directions, JSON.stringify({ reviewed: "2026-11-01", directions: seed.changes }));
      writeFileSync(index, JSON.stringify({ offers: [] }));
      writeFileSync(report, JSON.stringify(approved));
      git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "Reviewed dispositions");
      const unchangedStores = [readFileSync(directions), readFileSync(index)];
      const run = () => spawnSync(process.execPath, [script, "reviewed.json"], { cwd: scratch, env: { ...process.env, AGENTDEALS_CHANGES_PATH: log, AGENTDEALS_CHANGE_DIRECTIONS_PATH: directions, OPENROUTER_API_KEY: "", NODE_OPTIONS: "" }, encoding: "utf8" });
      const completed = run();
      assert.equal(completed.status, 0, completed.stderr);
      assert.match(completed.stdout, /exactly 5 reviewed dispositions/);
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), { ...seed, changes: writeReviewedArchive(seed.changes, approved, []).changes });
      assert.deepEqual([readFileSync(directions), readFileSync(index)], unchangedStores);
      const after = readFileSync(log);
      const retry = run();
      assert.equal(retry.status, 1);
      assert.match(retry.stderr, /record changed/);
      assert.deepEqual(readFileSync(log), after);
      seedLog();
      const stale = structuredClone(seed);
      stale.changes[4].summary = "Updated record";
      writeFileSync(log, JSON.stringify(stale));
      const before = readFileSync(log);
      const refused = run();
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /record changed/);
      assert.deepEqual(readFileSync(log), before);
      seedLog();
      const original = readFileSync(log);
      writeFileSync(report, JSON.stringify({ ...approved, today: "2026-11-09" }));
      const edited = run();
      assert.equal(edited.status, 1);
      assert.match(edited.stderr, /committed bytes/);
      assert.deepEqual(readFileSync(log), original);
      assert.deepEqual([readFileSync(directions), readFileSync(index)], unchangedStores);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
