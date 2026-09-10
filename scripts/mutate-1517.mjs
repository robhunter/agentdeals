import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/change-log-writer.test.ts",
  "test/change-refusals.test.ts",
  "test/reverify-rolling.test.ts",
];

const LOG = "scripts/change-log.js";
const ROLLING = "scripts/reverify-rolling.js";

const MUTANTS = [
  ["the-key-carries-the-detection-date-again", LOG,
    `  return [change.vendor, page, previous].join("|");`,
    `  return [change.vendor, change.date, page, previous].join("|");`],
  ["a-record-naming-no-page-still-registers-a-baseline", LOG,
    `  if (!previous || !page) return null;`,
    `  if (!previous) return null;`],
  ["a-record-naming-no-terms-still-registers-a-baseline", LOG,
    `  if (!previous || !page) return null;`,
    `  if (!page) return null;`],
  ["the-key-forgets-which-terms-the-record-moves-away-from", LOG,
    `  return [change.vendor, page, previous].join("|");`,
    `  return [change.vendor, page].join("|");`],
  ["the-key-forgets-which-page-was-read", LOG,
    `  return [change.vendor, page, previous].join("|");`,
    `  return [change.vendor, previous].join("|");`],
  ["the-key-forgets-whose-record-it-is", LOG,
    `  return [change.vendor, page, previous].join("|");`,
    `  return [page, previous].join("|");`],
  ["a-re-grading-registers-no-baseline-for-the-rest-of-the-batch", LOG,
    `    if (baseline) baselines.set(baseline, key);`,
    `    if (false) baselines.set(baseline, key);`],
  ["the-run-summary-names-nobody", ROLLING,
    `    for (const line of regradedVendorLines(result.suppressed)) lines.push(line);`,
    ``],
  ["the-run-summary-names-every-suppression", ROLLING,
    `  return regradeRefusals(suppressed).map(`,
    `  return (suppressed ?? []).map(`],
  ["the-refusal-no-longer-says-what-it-collided-on", ROLLING,
    `      detail: \`same vendor, source_url and previous_state as \${collidedWith}\`,`,
    `      detail: \`a record we already hold\`,`],
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
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const green = run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
