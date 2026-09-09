import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/page-lastmod.test.ts"];

const MUTANTS = [
  ["the-ledger-moves-only-when-a-scheduled-run-pushes-data", ".github/workflows/page-lastmod.yml",
    "on:\n  push:\n    branches:\n      - main\n  workflow_dispatch:",
    "on:\n  workflow_dispatch:"],

  ["the-re-dating-waits-on-the-re-verification-succeeding", ".github/workflows/page-lastmod.yml",
    "      - name: Read every page this commit renders, to date the ones whose output moved",
    "      - name: Re-verify the catalogue first\n        run: node scripts/reverify-rolling.js --limit 1\n\n      - name: Read every page this commit renders, to date the ones whose output moved"],

  ["the-days-it-read-reach-main-outside-the-gate", ".github/workflows/page-lastmod.yml",
    "          bash scripts/gate-data-push.sh \\",
    "          git commit -am dates && git push origin HEAD:trunk \\"],

  ["the-ledger-is-not-among-the-paths-the-run-may-commit", ".github/workflows/page-lastmod.yml",
    "            data/page-lastmod.json",
    "            data/link_health.json"],

  ["the-pages-are-read-in-whatever-zone-the-machine-is-set-to", "scripts/update-page-lastmod.js",
    "      env: { ...process.env, TZ: LEDGER_TIMEZONE, PORT: \"0\"",
    "      env: { ...process.env, PORT: \"0\""],

  ["the-zone-the-ledger-is-read-in-is-not-utc", "scripts/update-page-lastmod.js",
    "const LEDGER_TIMEZONE = \"UTC\";",
    "const LEDGER_TIMEZONE = \"America/Los_Angeles\";"],

  ["a-page-whose-output-moved-keeps-the-day-it-had", "src/page-lastmod.ts",
    "    } else if (before.hash === hash) {",
    "    } else if (true) {"],

  ["every-page-takes-today-whether-its-output-moved-or-not", "src/page-lastmod.ts",
    "    } else if (before.hash === hash) {",
    "    } else if (false) {"],

  ["a-page-that-moved-is-dated-from-the-ledger-it-replaces", "src/page-lastmod.ts",
    "      pages[pagePath] = { hash, changed: today };\n      moved.push(pagePath);",
    "      pages[pagePath] = { hash, changed: previous.generated };\n      moved.push(pagePath);"],

  ["every-body-hashes-to-the-same-thing", "src/page-lastmod.ts",
    "  const stripped = origin ? body.split(origin).join(\"\") : body;",
    "  const stripped = origin ? \"\" : body;"],

  ["the-origin-is-not-stripped-before-hashing", "src/page-lastmod.ts",
    "  const stripped = origin ? body.split(origin).join(\"\") : body;",
    "  const stripped = body;"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
