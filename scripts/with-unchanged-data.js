import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const audit = mkdtempSync(join(tmpdir(), "tracked-data-writes-"));
const manifest = join(audit, "manifest.json");
writeFileSync(manifest, JSON.stringify([...before.keys()].map(file => resolve(file))));
const preload = new URL("./reject-tracked-data-writes.js", import.meta.url).href;
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${preload}`,
    AGENTDEALS_DATA_GUARD_MANIFEST: manifest,
    AGENTDEALS_DATA_GUARD_LOG: audit,
  },
});
const violations = readdirSync(audit).filter(file => file.endsWith(".jsonl"))
  .flatMap(file => readFileSync(join(audit, file), "utf8").trim().split("\n"));
for (const violation of violations) {
  const { file, test, method } = JSON.parse(violation);
  console.error(`Tests attempted tracked data write: ${file} (${method}, ${test})`);
}
rmSync(audit, { recursive: true, force: true });
const changed = [...new Set([...before.keys(), ...trackedData()])]
  .filter(file => !before.has(file) || before.get(file) !== digest(file));
if (changed.length) console.error(`Tests changed tracked data:\n${changed.join("\n")}`);
if (result.error) console.error(result.error.message);
process.exitCode = changed.length || violations.length ? 1 : (result.status ?? 1);
