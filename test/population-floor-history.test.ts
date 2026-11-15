import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { floorCallWasPresent, floorCallsIn } from "./population-floor-history.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (floor = "73", prefix = "", observed = "readCount()") =>
  `${prefix}\nit("reads badges", () => { assertPopulationFloor(${observed}, ${floor}, "badges reached"); });`;
const unchanged = (current: string, base: string) => floorCallWasPresent(current, base, floorCallsIn(current)[0]!.line);

describe("population floor authoring", () => {
  it("recognizes an unchanged call after lines and formatting move", () => {
    assert.equal(unchanged(source("73", "\n\n"), source()), true);
    assert.equal(unchanged(source().replace('73,', '73 ,'), source()), true);
  });

  it("rechecks a changed floor, subject or measured expression", () => {
    assert.equal(unchanged(source("97"), source()), false);
    assert.equal(unchanged(source().replace("badges reached", "answers reached"), source()), false);
    assert.equal(unchanged(source("73", "", "otherCount()"), source()), false);
  });

  it("rechecks changed named constants and their dependencies", () => {
    const base = source("LIMIT", "const BASE = 76; const LIMIT = BASE - 3;");
    assert.equal(unchanged(base, base), true);
    assert.equal(unchanged(base.replace("BASE = 76", "BASE = 100"), base), false);
    assert.equal(unchanged(base.replace("BASE - 3", "BASE - 2"), base), false);
  });

  it("rechecks changed object-valued floor declarations", () => {
    const base = source("floors.badges", "const floors = { badges: 73 };");
    assert.equal(unchanged(base, base), true);
    assert.equal(unchanged(base.replace("badges: 73", "badges: 97"), base), false);
  });

  it("recognizes destructured declarations without treating type names as values", () => {
    const code = source("limit", "const { limit }: { limit: number } = { limit: 73 };");
    assert.equal(unchanged(code, code), true);
    assert.equal(unchanged(code.replace("limit: 73", "limit: 98"), code), false);
  });

  it("recognizes a computed floor over a typed local filter", () => {
    const code = source("Math.floor(population.length / 2)",
      "interface Row { valid: boolean }\nconst rows: Row[] = [{ valid: true }];\nconst population = rows.filter((row: Row) => row.valid);");
    assert.equal(unchanged(code, code), true);
  });

  it("does not accept imported or unresolved floor values as unchanged", () => {
    const code = source("IMPORTED");
    assert.equal(unchanged(code, code), false);
  });

  it("recognizes local floor parameters and checks changes to their callers", () => {
    const code = `function checks(floors: { badges: number }) { ${source("floors.badges")} }\nchecks({ badges: 73 });`;
    assert.equal(unchanged(code, code), true);
    assert.equal(unchanged(code.replace("badges: 73", "badges: 98"), code), false);
  });

  it("rechecks a new call in a different test and an extra copy in the same test", () => {
    const added = source().replace("reads badges", "reads more badges");
    assert.equal(unchanged(added, source()), false);
    const both = `${source()}\n${source()}`;
    assert.equal(floorCallWasPresent(both, source(), floorCallsIn(both)[1]!.line), false);
  });

  it("preserves string contents while ignoring comments", () => {
    assert.equal(unchanged(source().replace('73,', '73 /* floor */, '), source()), true);
    assert.equal(unchanged(source().replace('badges reached', 'badges  reached'), source()), false);
  });
});

function fixture(run: (root: string, base: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "authored-floors-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(path.join(root, "test"));
    for (const name of ["population-floor.ts", "population-floor-history.ts"]) {
      copyFileSync(path.join(REPO, "test", name), path.join(root, "test", name));
    }
    for (const name of ["hardcoded-vendor-rows.ts", "search-recording-paths.ts"]) {
      symlinkSync(path.join(REPO, "test", name), path.join(root, "test", name));
    }
    for (const name of ["dist", "data", "node_modules"]) symlinkSync(path.join(REPO, name), path.join(root, name));
    writeFileSync(path.join(root, "test", "read.test.ts"), [
      'import { it } from "node:test";',
      'import { readFileSync } from "node:fs";',
      'import { assertPopulationFloor } from "./population-floor.ts";',
      'it("reads badges", () => { assertPopulationFloor(Number(readFileSync("count", "utf8")), 73, "badges reached"); });',
    ].join("\n"));
    writeFileSync(path.join(root, "count"), "98");
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", "test", "count");
    git("commit", "-m", "Add badge population guard");
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    run(root, base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testFixture(root: string, base?: string) {
  return spawnSync(process.execPath, ["--test", "test/read.test.ts"], {
    cwd: root, encoding: "utf8",
    env: {
      ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined,
      POPULATION_FLOOR_LOG: undefined, POPULATION_FLOOR_BASE: base,
    },
  });
}

describe("a floor against its actual Git base", () => {
  it("allows shrinkage through the stated floor and refuses the next member", () => fixture((root, base) => {
    for (const count of [98, 97, 73]) {
      writeFileSync(path.join(root, "count"), String(count));
      const result = testFixture(root, base);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    writeFileSync(path.join(root, "count"), "72");
    const result = testFixture(root, base);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /only 72 badges reached, under a floor of 73/);
  }));

  it("refuses a floor raised to the measured population and names the site", () => fixture((root, base) => {
    const file = path.join(root, "test", "read.test.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(', 73,', ', 98,'));
    const result = testFixture(root, base);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /a floor of 98 leaves under 25% headroom/);
    assert.match(result.stdout, /test\/read.test.ts:4/);
  }));

  it("lets an unchanged parameter floor reach its minimum and rejects a changed caller", () => fixture((root) => {
    const file = path.join(root, "test", "read.test.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(
      'it("reads badges", () => {', 'function check(floors: { badges: number }) { it("reads badges", () => {',
    ).replace(', 73,', ', floors.badges,') + '\n}\ncheck({ badges: 73 });\n');
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("add", "test/read.test.ts");
    git("commit", "-m", "Pass the floor through a parameter");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(root, "count"), "73");
    const result = testFixture(root, base);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    writeFileSync(file, readFileSync(file, "utf8").replace('badges: 73', 'badges: 98'));
    writeFileSync(path.join(root, "count"), "98");
    const changed = testFixture(root, base);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stdout, /a floor of 98 leaves under 25% headroom/);
  }));

  it("uses the explicit pre-push base even when origin/main includes the new floor", () => fixture((root, base) => {
    const file = path.join(root, "test", "read.test.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(', 73,', ', 98,'));
    for (const args of [["add", "test/read.test.ts"], ["commit", "-m", "Raise badge floor"], ["update-ref", "refs/remotes/origin/main", "HEAD"]]) {
      assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    }
    assert.notEqual(testFixture(root, base).status, 0);
  }));

  it("fails closed when the requested base cannot be read", () => fixture((root) => {
    const result = testFixture(root, "missing-base");
    assert.equal(result.status, 0, result.stdout);
    writeFileSync(path.join(root, "count"), "97");
    const failed = testFixture(root, "missing-base");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /headroom/);
  }));
});
