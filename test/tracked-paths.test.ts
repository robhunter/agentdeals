import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const A_SYMLINK = "120000";

function trackedPaths(): { mode: string; file: string }[] {
  return execFileSync("git", ["ls-files", "-s"], { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, file] = line.split("\t");
      return { mode: meta.split(" ")[0]!, file: file! };
    });
}

function trackedSymlinks(): { file: string; target: string }[] {
  return trackedPaths()
    .filter((entry) => entry.mode === A_SYMLINK)
    .map((entry) => ({
      file: entry.file,
      target: execFileSync("git", ["cat-file", "-p", `HEAD:${entry.file}`], { cwd: REPO, encoding: "utf8" }),
    }));
}

describe("what a clone of this repository gets", () => {
  it("tracks no link into a path only this machine has", () => {
    const absolute = trackedSymlinks().filter((link) => link.target.startsWith("/"));
    assert.deepEqual(absolute.map((link) => `${link.file} -> ${link.target}`), [],
      "a tracked symlink names an absolute path, so a clone resolves it against whatever is at that path on the reader's machine");
  });

  it("tracks nothing a dependency install writes", () => {
    const installed = trackedPaths().filter((entry) => entry.file === "node_modules" || entry.file.startsWith("node_modules/"));
    assert.deepEqual(installed.map((entry) => entry.file), [],
      "node_modules is tracked, so a checkout overwrites whatever the reader installed there");
  });

  it("ignores the install path by a rule that does not require it to be a directory", () => {
    const matched = execFileSync("git", ["check-ignore", "-v", "node_modules"], { cwd: REPO, encoding: "utf8" }).trim();
    const pattern = matched.split("\t")[0]!.split(":")[2];
    assert.ok(pattern, `nothing in .gitignore matches node_modules: ${matched}`);
    assert.ok(!pattern.endsWith("/"),
      `node_modules is ignored by "${pattern}", which matches a directory and not a symlink standing where one would be`);
  });
});
