import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

function exercise(command: string, body: string, concurrent = false, shard = "") {
  const work = mkdtempSync(join(tmpdir(), "tracked-writer-"));
  try {
    mkdirSync(join(work, "test/workers"), { recursive: true });
    mkdirSync(join(work, "data"));
    writeFileSync(join(work, "data/seed.json"), "supplied input\n");
    for (const args of [["init", "-q"], ["add", "data/seed.json"]]) {
      const result = spawnSync("git", args, { cwd: work, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    symlinkSync(join(root, "scripts"), join(work, "scripts"), "dir");
    symlinkSync(join(work, "data/seed.json"), join(work, "alias.json"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", scripts: { [command]: scripts[command] } }));
    writeFileSync(join(work, "test/workers/writer.test.ts"), `
import { before, after, it } from "node:test";
import fs from "node:fs";
import { writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const original = fs.readFileSync("data/seed.json");
${body}
`);
    if (concurrent) {
      for (let index = 0; index < 8; index++) writeFileSync(join(work, `test/workers/reader-${index}.test.ts`), `
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
it("reads supplied data ${index}", async () => {
  for (let count = 0; count < 5; count++) {
    assert.equal(readFileSync("data/seed.json", "utf8"), "supplied input\\n");
    await setTimeout(10);
  }
});
`);
    }
    const env = { ...process.env, TEST_SHARD: shard, GATE_FAILING_TESTS: join(work, "failures.jsonl") };
    delete env.NODE_TEST_CONTEXT;
    delete env.AGENTDEALS_DATA_GUARD_TEST;
    const result = spawnSync("npm", ["run", command], { cwd: work, env, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr, data: readFileSync(join(work, "data/seed.json"), "utf8") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const restoring = `
before(() => writeFileSync("data/seed.json", "fixture"));
after(() => writeFileSync("data/seed.json", original));
it("holds fixture", async () => await new Promise(resolve => setTimeout(resolve, 20000)));
`;

describe("complete suites reject writes before tracked data changes", () => {
  for (const command of ["test", "test:gated"]) {
    for (const concurrent of [false, true]) {
      it(`${command} identifies a restoring writer ${concurrent ? "beside concurrent readers" : "alone"}`, () => {
        const result = exercise(command, restoring, concurrent);
        assert.notEqual(result.status, 0, result.output);
        assert.match(result.output, /Tests attempted tracked data write: data\/seed.json/);
        assert.match(result.output, /test\/workers\/writer.test.ts/);
        assert.equal(result.data, "supplied input\n");
      });
    }
    it(`${command} fails even when a test catches the rejected write`, () => {
      const result = exercise(command, `it("catches write", () => { try { fs.writeFileSync("data/seed.json", original); } catch {} });`);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /Tests attempted tracked data write: data\/seed.json/);
      assert.equal(result.data, "supplied input\n");
    });
    it(`${command} allows reads and untracked data writes`, () => {
      const result = exercise(command, `it("uses runtime data", async () => {
  fs.readFileSync("data/seed.json");
  const handle = await promises.open("data/seed.json", "r");
  await handle.readFile(); await handle.close();
  fs.writeFileSync("data/runtime.json", "runtime");
  await promises.appendFile("data/runtime.json", "more");
});`);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.data, "supplied input\n");
    });
  }

  it("retains restoring-writer detection across all regular-suite shards", () => {
    const results = [1, 2, 3].map(shard => exercise("test", restoring, true, `${shard}/3`));
    assert.equal(results.filter(result => result.status !== 0).length, 1, results.map(result => result.output).join("\n"));
    assert.ok(results.some(result => /Tests attempted tracked data write: data\/seed.json/.test(result.output)));
    for (const result of results) assert.equal(result.data, "supplied input\n");
  });

  const operations = {
    callback: `fs.writeFile("data/seed.json", "fixture", () => {});`,
    promise: `await promises.writeFile("data/seed.json", "fixture");`,
    append: `fs.appendFileSync("data/seed.json", "fixture");`,
    descriptor: `fs.openSync("data/seed.json", fs.constants.O_RDWR);`,
    handle: `await promises.open("data/seed.json", "a");`,
    stream: `fs.createWriteStream("data/seed.json");`,
    rename: `fs.writeFileSync("replacement", "fixture"); fs.renameSync("replacement", "data/seed.json");`,
    move: `fs.renameSync("data/seed.json", "moved");`,
    copy: `fs.writeFileSync("replacement", "fixture"); await promises.copyFile("replacement", "data/seed.json");`,
    remove: `fs.unlinkSync("data/seed.json");`,
    directory: `fs.rmSync("data", { recursive: true });`,
    truncate: `fs.truncateSync("data/seed.json");`,
    url: `fs.writeFileSync(pathToFileURL(process.cwd() + "/data/seed.json"), "fixture");`,
    buffer: `fs.writeFileSync(Buffer.from("data/seed.json"), "fixture");`,
    symlink: `fs.writeFileSync("alias.json", "fixture");`,
    hardlink: `fs.linkSync("data/seed.json", "hardlink.json");`,
    child: `const result = spawnSync(process.execPath, ["-e", 'require("node:fs").writeFileSync("data/seed.json", "fixture")'], { encoding: "utf8" }); process.stdout.write(result.stderr);`,
  };
  for (const [name, operation] of Object.entries(operations)) {
    it(`rejects ${name} writes with test-file attribution`, () => {
      const result = exercise("test", `it("attempts write", async () => { ${operation} });`);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /Tests attempted tracked data write: data\/seed.json/);
      assert.match(result.output, /test\/workers\/writer.test.ts/);
      assert.equal(result.data, "supplied input\n");
    });
  }
});
