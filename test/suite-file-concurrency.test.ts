import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

function exercise(command: string, shard = "", red = false, dataChange = "") {
  const work = mkdtempSync(join(tmpdir(), "suite-concurrency-"));
  try {
    mkdirSync(join(work, "test/workers"), { recursive: true });
    mkdirSync(join(work, "started"));
    mkdirSync(join(work, "data"));
    writeFileSync(join(work, "data/seed.json"), "committed\n");
    for (const args of [["init", "-q"], ["add", "data/seed.json"]]) {
      const git = spawnSync("git", args, { cwd: work, encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
    }
    writeFileSync(join(work, "data/seed.json"), "input\n");
    mkdirSync(join(work, "finished"));
    symlinkSync(join(root, "scripts"), join(work, "scripts"), "dir");
    writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", scripts: { [command]: scripts[command] } }));
    for (let index = 0; index < 8; index++) {
      writeFileSync(join(work, `test/workers/worker-${index}.test.ts`), `
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
it("worker ${index}", async () => {
  writeFileSync("started/${index}", "");
  const deadline = Date.now() + 5000;
  const required = process.env.SUITE_SHARD ? 2 : 4;
  while (readdirSync("started").length < required && Date.now() < deadline) await setTimeout(10);
  assert.ok(readdirSync("started").length >= required, "test files must overlap");
  if (${index} === 0) {
    if (process.env.SUITE_DATA_CHANGE === "modify") assert.equal(spawnSync("sh", ["-c", "printf changed > data/seed.json"]).status, 0);
    if (process.env.SUITE_DATA_CHANGE === "delete") assert.equal(spawnSync("sh", ["-c", "rm data/seed.json"]).status, 0);
    if (process.env.SUITE_DATA_CHANGE === "untracked") writeFileSync("data/telemetry.json", "runtime");
  }
  writeFileSync("finished/${index}", "");
  assert.ok(!(process.env.SUITE_RED && [0, 7].includes(${index})), "requested failure");
});
`);
    }
    const env = { ...process.env, SUITE_DATA_CHANGE: dataChange, TEST_SHARD: shard, SUITE_SHARD: shard, SUITE_RED: red ? "yes" : "", GATE_FAILING_TESTS: join(work, "failures.jsonl") };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync("npm", ["run", command], { cwd: work, env, encoding: "utf8", timeout: 60000 });
    assert.ifError(result.error);
    const reached = readdirSync(join(work, "finished")).map(Number).sort((a, b) => a - b);
    const failures = command === "test:gated" && red
      ? readFileSync(env.GATE_FAILING_TESTS, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const data = (() => { try { return readFileSync(join(work, "data/seed.json"), "utf8"); } catch { return null; } })();
    return { data, status: result.status, output: result.stdout + result.stderr, reached, failures };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("the complete suites run four files at once", () => {
  for (const command of ["test", "test:gated"]) {
    it(`${command} overlaps files and finishes every case`, () => {
      const result = exercise(command);
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(result.reached, [0, 1, 2, 3, 4, 5, 6, 7]);
    });
  }

  it("partitions the regular suite without omitting or repeating a file", () => {
    const reached: number[] = [];
    for (let shard = 1; shard <= 3; shard++) {
      const result = exercise("test", `${shard}/3`);
      assert.equal(result.status, 0, result.output);
      assert.ok(result.reached.length < 8);
      reached.push(...result.reached);
    }
    assert.deepEqual(reached.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("the data gate ignores inherited sharding and records every failing file", () => {
    const result = exercise("test:gated", "1/3", true);
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.reached, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(result.failures.map(failure => failure.file).sort(), ["test/workers/worker-0.test.ts", "test/workers/worker-7.test.ts"]);
    assert.deepEqual(result.failures.map(failure => failure.name).sort(), ["worker 0", "worker 7"]);
  });
});

describe("complete suites preserve tracked data", () => {
  for (const command of ["test", "test:gated"]) {
    for (const change of ["modify", "delete"]) {
      it(`${command} refuses a passing suite that leaves a tracked file ${change === "modify" ? "modified" : "deleted"}`, () => {
        const result = exercise(command, "", false, change);
        assert.notEqual(result.status, 0, result.output);
        assert.match(result.output, /Tests changed tracked data:\ndata\/seed.json/);
        assert.deepEqual(result.reached, [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.equal(result.data, change === "delete" ? null : "changed");
      });
    }
    it(`${command} retains supplied input bytes and allows untracked runtime files`, () => {
      const result = exercise(command, "", false, "untracked");
      assert.equal(result.status, 0, result.output);
      assert.equal(result.data, "input\n");
    });
  }
});
