import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const REPORTER = path.join(REPO, "scripts", "report-population-floors.js");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  summary: string;
}

function report(records: unknown[], ...args: string[]): Run {
  const scratch = mkdtempSync(path.join(tmpdir(), "floor-report-"));
  try {
    const log = path.join(scratch, "floors.jsonl");
    const summary = path.join(scratch, "summary.md");
    writeFileSync(log, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const run = spawnSync(process.execPath, [REPORTER, log, "--summary", summary, ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined } as NodeJS.ProcessEnv,
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const floor = (site: string, floorValue: number, observed: number) => ({
  site,
  subject: "vendors withhold on a refused read",
  floor: floorValue,
  observed,
});

describe("#1580 how close a floor is to going red is readable where its author is", () => {
  it("counts the records that can leave before a floor stops clearing its headroom", () => {
    const run = report([floor("test/a.test.ts:10", 80, 111)]);
    assert.strictEqual(run.status, 0);
    assert.match(run.stdout, /\| 4 \| `test\/a\.test\.ts:10` \| a floor of 80 \| 111 \| 83 \|/);
  });

  it("puts a floor that goes red on the next record that leaves at a margin of zero", () => {
    const run = report([floor("test/a.test.ts:10", 45, 60)]);
    assert.match(run.stdout, /1 floors are within 10 records of going red, 1 of them on the next record that leaves/);
    assert.match(run.stdout, /\| 0 \| `test\/a\.test\.ts:10` \|/);
  });

  it("reads a floor already inside its headroom as a negative margin rather than as clear", () => {
    const run = report([floor("test/a.test.ts:10", 80, 102)]);
    assert.match(run.stdout, /\| -5 \| `test\/a\.test\.ts:10` \| a floor of 80 \| 102 \| 76 \|/);
  });

  it("leaves a floor of one out of the ranking, because it says the population is not empty", () => {
    const run = report([floor("test/a.test.ts:10", 1, 1), floor("test/b.test.ts:20", 45, 60)]);
    assert.match(run.stdout, /2 population floors read/);
    assert.doesNotMatch(run.stdout, /test\/a\.test\.ts:10/);
  });

  it("measures a share against the population it was filtered from", () => {
    const run = report([
      { site: "test/a.test.ts:10", subject: "vendors withhold", share: 0.4, population: 144, observed: 111 },
    ], "--within", "50");
    assert.match(run.stdout, /\| 34 \| `test\/a\.test\.ts:10` \| a share of 40\.0% \| 111 of 144 \| 57\.8% \|/);
  });

  it("counts a coverage assertion without ranking it, because coverage cannot drift", () => {
    const run = report([
      { site: "test/a.test.ts:10", subject: "pages swept", covers: "pages the register holds", population: 71, observed: 71 },
    ]);
    assert.match(run.stdout, /0 population floors read, 1 coverage assertions read/);
    assert.match(run.stdout, /0 floors are within 10 records of going red/);
  });

  it("names only the floors inside the window it was given", () => {
    const run = report([floor("test/near.test.ts:1", 45, 60), floor("test/far.test.ts:2", 10, 1572)], "--within", "3");
    assert.match(run.stdout, /test\/near\.test\.ts:1/);
    assert.doesNotMatch(run.stdout, /test\/far\.test\.ts:2/);
  });

  it("writes the same table where a run summary will show it", () => {
    const run = report([floor("test/a.test.ts:10", 45, 60)]);
    assert.match(run.summary, /## Population floors/);
    assert.match(run.summary, /\| 0 \| `test\/a\.test\.ts:10` \|/);
  });

  it("leaves out the helper's own tests, which exercise it on figures no run measured", () => {
    const run = report([
      floor("test/population-floor.test.ts:41", 45, 60),
      floor("test/a.test.ts:10", 45, 60),
    ]);
    assert.match(run.stdout, /1 population floors read/);
    assert.match(run.stdout, /1 left out because they are test\/population-floor\.test\.ts/);
    assert.doesNotMatch(run.stdout, /population-floor\.test\.ts:41/);
  });

  it("says where the log should have come from rather than reporting an empty census", () => {
    const run = spawnSync(process.execPath, [REPORTER, path.join(tmpdir(), "a-log-no-run-wrote.jsonl")], {
      encoding: "utf8",
    });
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, /POPULATION_FLOOR_LOG/);
  });
});
