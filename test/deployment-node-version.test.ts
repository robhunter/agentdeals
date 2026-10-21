import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const release = "24.22.1";
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("deployment and workflows use the same patched Node release", () => {
  it("pins both Docker stages to the patched slim image", () => {
    const stages = read("Dockerfile").split("\n").filter(line => /^\s*FROM\s/i.test(line));
    assert.equal(stages.length, 2);
    for (const stage of stages) {
      assert.match(stage, new RegExp(`^FROM node:${release.replaceAll(".", "\\.")}-slim(?: AS \\w+)?$`, "i"));
    }
  });

  it("pins every workflow Node setup to the same exact release", () => {
    const workflows = readdirSync(new URL(".github/workflows/", root)).filter(name => /\.ya?ml$/.test(name));
    let setups = 0;
    for (const file of workflows) {
      const source = read(`.github/workflows/${file}`);
      const setupCount = [...source.matchAll(/\buses:\s*actions\/setup-node@/g)].length;
      const versions = [...source.matchAll(/^\s*node-version:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/gm)].map(match => match[1]);
      assert.equal(versions.length, setupCount, `${file} must declare a literal version for each Node setup`);
      for (const version of versions) assert.equal(version, release, `${file} differs from the Docker release`);
      setups += setupCount;
    }
    assert.ok(setups >= 9, `expected the complete workflow inventory, found ${setups} Node setups`);
  });

  it("requires a supported Node major in the package and lockfile", () => {
    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(pkg.engines.node, ">=22");
    assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  });
});
