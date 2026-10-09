import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordsAddedFreeOnAPageThatDoesNotNameThem } from "../dist/added-records.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "refuse-added-unnamed-free-records.js");
const UNNAMED = { checked: "2026-10-01", outcome: "does_not_name_vendor", detail: "the page read never names Example and is not served from its domain" };
const NAMED = { checked: "2026-10-01", outcome: "ok", detail: "the page names Example as \"example\" and states \"$0\"" };

const record = (over: object) => ({ vendor: "Example", category: "Dev Utilities", url: "https://example.com/pricing", tier: "Free", source_check: UNNAMED, ...over });
const refused = (before: object[], after: object[]) =>
  recordsAddedFreeOnAPageThatDoesNotNameThem(before as never, after as never).map((r: { vendor: string }) => r.vendor);

describe("#1118 a change may not add a free record whose cited page does not name its vendor", () => {
  it("refuses an added record classed free whose page does not name its vendor", () => {
    assert.deepStrictEqual(refused([], [record({})]), ["Example"]);
  });

  it("leaves alone a record the base already held, whatever its page now says", () => {
    assert.deepStrictEqual(refused([record({ source_check: NAMED })], [record({})]), []);
  });

  it("counts a record cited on another page as added", () => {
    assert.deepStrictEqual(refused([record({})], [record({ url: "https://aggregator.example/offers" })]), ["Example"]);
  });

  it("counts a record whose vendor name changed as added", () => {
    assert.deepStrictEqual(refused([record({ vendor: "Example Startup Program" })], [record({})]), ["Example"]);
  });

  it("passes an added record whose tier is not classed as an ongoing free tier", () => {
    assert.deepStrictEqual(refused([], [record({ tier: "Startup Credits" }), record({ vendor: "B", tier: "Startup Discount" }), record({ vendor: "C", tier: "Retired" })]), []);
  });

  it("passes an added free record whose page names its vendor, or that has no source check yet", () => {
    assert.deepStrictEqual(refused([], [record({ source_check: NAMED }), record({ vendor: "B", source_check: undefined })]), []);
  });

  it("finds nothing to refuse in the catalogue compared with the commit it was checked out from", () => {
    const run = spawnSync("node", [SCRIPT, "--base", "HEAD"], { cwd: REPO, encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  });

  it("refuses to run without a commit to compare with", () => {
    assert.strictEqual(spawnSync("node", [SCRIPT], { cwd: REPO, encoding: "utf8" }).status, 2);
  });

  it("exits 1 and names each record it refuses when a change adds one", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "added-records-"));
    try {
      const git = (...args: string[]) =>
        spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
      const writeCatalogue = (offers: object[]) => writeFileSync(path.join(repo, "data", "index.json"), JSON.stringify({ offers }));
      const check = () => spawnSync("node", [SCRIPT, "--base", "HEAD"], { cwd: repo, encoding: "utf8" });
      mkdirSync(path.join(repo, "data"));
      writeCatalogue([record({ source_check: NAMED })]);
      git("init", "-q");
      git("add", "data/index.json");
      assert.strictEqual(git("commit", "-q", "-m", "base").status, 0);
      assert.strictEqual(check().status, 0);

      writeCatalogue([record({ source_check: NAMED }), record({ vendor: "Added Example" })]);
      const run = check();
      assert.strictEqual(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout, /^Added Example \| Dev Utilities \| Free \| https:\/\/example\.com\/pricing: /m);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs on every pull request that changes the catalogue, against the pull request's base with its history", () => {
    const workflow = readFileSync(path.join(REPO, ".github", "workflows", "added-records.yml"), "utf8");
    assert.match(workflow, /^on:\n  pull_request:\n    paths:\n(?: {6}- .+\n)* {6}- "data\/index\.json"\n/m);
    assert.match(workflow, /^ {10}fetch-depth: 0$/m);
    assert.match(workflow, /^ {8}run: node scripts\/refuse-added-unnamed-free-records\.js --base "origin\/\$\{\{ github\.base_ref \}\}"$/m);
  });
});
