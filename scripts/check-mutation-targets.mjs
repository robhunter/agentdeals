/**
 * Reports mutations in scripts/mutate-*.sh whose target text no longer exists.
 *
 * A mutation whose search string has moved applies nothing, and the mutation
 * script scores it as passing. The scripts themselves catch this only when run,
 * which costs a rebuild and a test pass per mutation; this reads the target
 * strings straight out of the scripts and checks them against the files.
 *
 * Usage:
 *   node scripts/check-mutation-targets.mjs            # every mutate-*.sh
 *   node scripts/check-mutation-targets.mjs 1109 1116  # only those
 *
 * Exits non-zero if any mutation has a target that is absent.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO, "scripts");

const wanted = process.argv.slice(2);
const scripts = readdirSync(SCRIPTS)
  .filter((f) => /^mutate-.*\.sh$/.test(f))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.includes(w)))
  .sort();

if (scripts.length === 0) {
  console.error(`no mutation scripts matched ${wanted.join(", ") || "*"}`);
  process.exit(2);
}

const fileCache = new Map();
const read = (rel) => {
  if (!fileCache.has(rel)) {
    const full = path.join(REPO, rel);
    fileCache.set(rel, existsSync(full) ? readFileSync(full, "utf8") : null);
  }
  return fileCache.get(rel);
};

/** Turn a Python single- or double-quoted literal into the string it denotes. */
function pythonLiteral(quoted) {
  const quote = quoted[0];
  const body = quoted.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { out += body[i]; continue; }
    const next = body[++i];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "\\") out += "\\";
    else if (next === quote) out += quote;
    else out += "\\" + next;
  }
  return out;
}

const MUTATION = /m_(\w+)\(\)\s*\{\s*py <<'(\w+)'\n([\s\S]*?)\n\2\n\}/g;
const PATH_IN_BODY = /p = "([^"]+)"/g;
const REPLACE_TARGET = /s\.replace\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;

let problems = 0;
let mutationsChecked = 0;

for (const script of scripts) {
  const source = readFileSync(path.join(SCRIPTS, script), "utf8");
  const findings = [];
  for (const [, name, , body] of source.matchAll(MUTATION)) {
    const paths = [...body.matchAll(PATH_IN_BODY)].map((m) => m[1]);
    const targets = [...body.matchAll(REPLACE_TARGET)].map((m) => pythonLiteral(m[1]));
    if (paths.length === 0) continue;
    mutationsChecked++;
    for (const rel of paths) {
      if (read(rel) === null) findings.push([name, `file is missing: ${rel}`]);
    }
    for (const target of targets) {
      if (!paths.some((rel) => (read(rel) ?? "").includes(target))) {
        findings.push([name, `target absent from ${paths.join(", ")}: ${JSON.stringify(target.slice(0, 100))}`]);
      }
    }
  }
  if (findings.length > 0) {
    problems += findings.length;
    console.log(`${script}`);
    for (const [name, detail] of findings) console.log(`  m_${name}: ${detail}`);
  }
}

console.log(
  problems === 0
    ? `${mutationsChecked} mutations across ${scripts.length} script(s) still target code that exists`
    : `\n${problems} mutation target(s) no longer exist — those mutations apply nothing and score as passing`
);
process.exit(problems === 0 ? 0 : 1);
