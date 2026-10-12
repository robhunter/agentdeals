import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const workflow = readFileSync(path.join(REPO, ".github", "workflows", "tests.yml"), "utf-8");
const testScript: string = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf-8")).scripts.test;

function shardCountEachJobIsTold(): number {
  const found = workflow.match(/^ {10}TEST_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)$/m);
  assert.ok(found, "tests.yml tells each job its shard as TEST_SHARD");
  return Number(found![1]);
}

function shardsInTheMatrix(): number[] {
  const found = workflow.match(/^ {8}shard: \[([\d, ]+)\]$/m);
  assert.ok(found, "tests.yml lists its shards in a matrix");
  return found![1].split(",").map((shard) => Number(shard.trim()));
}

describe("the Tests workflow runs the whole suite in shards", () => {
  it("runs every shard from 1 to the count each job is told", () => {
    const count = shardCountEachJobIsTold();
    assert.deepStrictEqual(
      shardsInTheMatrix(),
      Array.from({ length: count }, (_, i) => i + 1),
      `the matrix must hold shards 1 to ${count}, or some test files run in no job`,
    );
  });

  it("names the shard before the test files, since Node ignores a shard option placed after them and runs every file", () => {
    assert.match(testScript, / \$\{TEST_SHARD:\+--test-shard=\$TEST_SHARD\} test\/\*\*\/\*\.test\.ts$/);
  });

  it("runs every file when no shard is named", () => {
    assert.match(testScript, /\$\{TEST_SHARD:\+/);
    assert.doesNotMatch(testScript.replace(/\$\{TEST_SHARD:\+--test-shard=\$TEST_SHARD\}/, ""), /--test-shard/);
  });

  it("lets the other shards finish when one fails, so a run reports every failing test", () => {
    assert.match(workflow, /^ {6}fail-fast: false$/m);
  });

  it("reports one check named test, which passes only when every shard passed", () => {
    assert.match(workflow, /^ {2}test:\n {4}needs: suite\n/m);
    assert.match(workflow, /^ {10}SHARDS: \$\{\{ needs\.suite\.result \}\}$/m);
    assert.match(workflow, /if \[ "\$SHARDS" != "success" \]; then\n\s+echo "::error[^\n]*\n\s+exit 1\n/);
  });
});
