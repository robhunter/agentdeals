import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function trackedData() {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "data/"], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(listed.stderr || "Cannot list tracked data");
  return listed.stdout.split("\0").filter(Boolean);
}

function digest(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: with-unchanged-data.js <command> [arguments...]");
const before = new Map(trackedData().map(file => [file, digest(file)]));
const result = spawnSync(command, args, { stdio: "inherit" });
const changed = [...new Set([...before.keys(), ...trackedData()])]
  .filter(file => !before.has(file) || before.get(file) !== digest(file));
if (changed.length) console.error(`Tests changed tracked data:\n${changed.join("\n")}`);
if (result.error) console.error(result.error.message);
process.exitCode = changed.length ? 1 : (result.status ?? 1);
