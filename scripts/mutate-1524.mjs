import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LOG = "scripts/change-log.js";
const ROLLING = "scripts/reverify-rolling.js";
const RESOLUTION = "src/change-resolution.ts";
const DATA = "src/data.ts";

const SUITE = [
  "test/change-log-writer.test.ts",
  "test/weekly-window-provenance.test.ts",
  "test/change-refusals.test.ts",
];

const MUTANTS = [
  ["a-withdrawn-record-holds-its-baseline-against-every-reading", LOG,
    `    withdrawn: theEventNeverHappened(change),`,
    `    withdrawn: false,`],

  ["every-record-reads-as-withdrawn", LOG,
    `    withdrawn: theEventNeverHappened(change),`,
    `    withdrawn: true,`],

  ["a-withdrawn-baseline-takes-the-reading-we-withdrew-again", LOG,
    `  return (holders ?? []).find((holder) => holder.changeType === candidate.change_type) ?? null;`,
    `  return null;`],

  ["a-standing-record-stops-holding-its-baseline", LOG,
    `  const stoodBehind = (holders ?? []).find((holder) => !holder.withdrawn);`,
    `  const stoodBehind = (holders ?? []).find((holder) => holder.withdrawn);`],

  ["any-holder-refuses-whatever-we-did-with-it", LOG,
    `  const stoodBehind = (holders ?? []).find((holder) => !holder.withdrawn);\n  if (stoodBehind) return stoodBehind;`,
    `  const stoodBehind = (holders ?? [])[0];\n  if (stoodBehind) return stoodBehind;`],

  ["a-baseline-remembers-only-the-first-record-on-it", LOG,
    `    const holders = held.get(baseline);\n    if (holders) holders.push(baselineHolder(change));\n    else held.set(baseline, [baselineHolder(change)]);`,
    `    if (!held.has(baseline)) held.set(baseline, [baselineHolder(change)]);`],

  ["a-correction-registers-no-baseline-for-the-rest-of-the-batch", LOG,
    `      const holders = baselines.get(baseline);\n      if (holders) holders.push(baselineHolder(candidate));\n      else baselines.set(baseline, [baselineHolder(candidate)]);`,
    ``],

  ["a-reversal-reads-as-a-withdrawal", RESOLUTION,
    `  return change.resolution?.state === "retracted";`,
    `  return Boolean(change.resolution);`],

  ["the-weekly-digest-counts-what-we-withdrew", DATA,
    `  const allChanges = recordsStillInForce(loadDealChanges());\n  const now = new Date();`,
    `  const allChanges = loadDealChanges();\n  const now = new Date();`],

  ["the-refusal-log-stops-saying-the-holder-was-withdrawn", ROLLING,
    `      detail: collidedWithWithdrawn\n        ? \`graded as \${collidedWith}, a record we withdrew\`\n        : \`same vendor, source_url and previous_state as \${collidedWith}\`,`,
    `      detail: \`same vendor, source_url and previous_state as \${collidedWith}\`,`],

  ["the-run-summary-stops-splitting-the-refusals", ROLLING,
    `      collidedWithWithdrawn\n        ? \`  \${candidate?.vendor ?? "(unnamed)"} (\${candidate?.change_type ?? "unclassified"}) grades those terms as \${collidedWith}, a record we withdrew\`\n        : \`  \${candidate?.vendor ?? "(unnamed)"} (\${candidate?.change_type ?? "unclassified"}) reads the same terms we already recorded as \${collidedWith}\``,
    `      \`  \${candidate?.vendor ?? "(unnamed)"} (\${candidate?.change_type ?? "unclassified"}) reads the same terms we already recorded as \${collidedWith}\``],
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
  const compiled = file.startsWith("src/") ? run("npm", ["run", "build"]) : true;
  const green = compiled && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (file.startsWith("src/")) run("npm", ["run", "build"]);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}${compiled ? "" : " (by tsc)"}`);
  if (green) survivors.push(name);
}
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
