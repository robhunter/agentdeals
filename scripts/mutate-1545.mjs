import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROLLING = "scripts/reverify-rolling.js";
const STATE = "scripts/verification-state.js";

const SUITE = [
  "test/reverify-rolling.test.ts",
  "test/change-log-writer.test.ts",
  "test/change-gate.test.ts",
];

const A_RANDOM_DAY_BACK = (target) =>
  `data.offers[${target}].verifiedDate = new Date(now.getTime() - Math.floor(Math.random() * 3) * 86400000).toISOString().slice(0, 10);`;

const MUTANTS = [
  ["the-url-mode-stamp-goes-back-a-random-day-again", ROLLING,
    `data.offers[v.index].verifiedDate = isoDay(now);`,
    A_RANDOM_DAY_BACK("v.index")],

  ["the-ai-mode-stamp-goes-back-a-random-day-again", ROLLING,
    `data.offers[index].verifiedDate = isoDay(now);`,
    A_RANDOM_DAY_BACK("index")],

  ["the-url-mode-stamp-goes-back-exactly-one-day", ROLLING,
    `data.offers[v.index].verifiedDate = isoDay(now);`,
    `data.offers[v.index].verifiedDate = isoDay(new Date(now.getTime() - 86400000));`],

  ["the-ai-mode-stamp-goes-back-exactly-one-day", ROLLING,
    `data.offers[index].verifiedDate = isoDay(now);`,
    `data.offers[index].verifiedDate = isoDay(new Date(now.getTime() - 86400000));`],

  ["the-url-mode-stamp-reads-the-wall-clock-rather-than-the-run", ROLLING,
    `data.offers[v.index].verifiedDate = isoDay(now);`,
    `data.offers[v.index].verifiedDate = isoDay(new Date());`],

  ["the-ai-mode-stamp-reads-the-wall-clock-rather-than-the-run", ROLLING,
    `data.offers[index].verifiedDate = isoDay(now);`,
    `data.offers[index].verifiedDate = isoDay(new Date());`],

  ["a-read-that-could-not-take-the-terms-stamps-anyway", ROLLING,
    `      if (holdsVerifiedDate(check.outcome)) {`,
    `      if (false) {`],

  ["a-confirmation-over-an-unusable-source-stamps-anyway", ROLLING,
    `      if (!sourceOk) {\n        await sleep(rateLimitMs);\n        continue;\n      }`,
    ``],

  ["the-state-file-dates-the-confirmation-a-day-before-we-publish-it", STATE,
    `  const date = isoDay(now);`,
    `  const date = isoDay(new Date(now.getTime() - 86400000));`],
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
