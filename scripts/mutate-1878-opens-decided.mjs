import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = [
  "test/homepage-ranking-window-sentence.test.ts",
  "test/guide-ranking-key-cap.test.ts",
];

const ARMS = [
  {
    name: "publish a guide that ties with the first one left out",
    file: "src/homepage-routing.ts",
    from: "if (ranked[length - 1].agentOpens > (ranked[length]?.agentOpens ?? 0)) return ranked.slice(0, length);",
    to: "if (ranked[length - 1].agentOpens >= (ranked[length]?.agentOpens ?? 0)) return ranked.slice(0, length);",
  },
  {
    name: "let the end of the population stand in for a guide below it",
    file: "src/homepage-routing.ts",
    from: "(ranked[length]?.agentOpens ?? 0)",
    to: "(ranked[length]?.agentOpens ?? -1)",
  },
  {
    name: "publish the capped list whatever the opens behind it",
    file: "src/homepage-routing.ts",
    from: "  for (let length = Math.min(cap, ranked.length); length > 0; length--) {",
    to: "  return ranked.slice(0, Math.min(cap, ranked.length));\n  for (let length = Math.min(cap, ranked.length); length > 0; length--) {",
  },
  {
    name: "ignore the count the page publishes",
    file: "src/homepage-routing.ts",
    from: "for (let length = Math.min(cap, ranked.length); length > 0; length--) {",
    to: "for (let length = ranked.length; length > 0; length--) {",
  },
  {
    name: "read the run from the shortest end rather than the longest",
    file: "src/homepage-routing.ts",
    from: "for (let length = Math.min(cap, ranked.length); length > 0; length--) {",
    to: "for (let length = 1; length <= Math.min(cap, ranked.length); length++) {",
  },
  {
    name: "say we could rank on none of the days where a day was rankable",
    file: "src/homepage-routing.ts",
    from: "  if (!opensDecided) {",
    to: "  if (false && !opensDecided) {",
  },
  {
    name: "name the unrankable window as one opens decided nothing on",
    file: "src/homepage-routing.ts",
    from: "  if (!rankedWindow) {\n    return `All ${populationCount} guides we publish, in the order /guides lists them, and not a ranking. `\n      + `We hold ${heldDays} days of traffic and can rank on none of them",
    to: "  if (false && !rankedWindow) {\n    return `All ${populationCount} guides we publish, in the order /guides lists them, and not a ranking. `\n      + `We hold ${heldDays} days of traffic and can rank on none of them",
  },
];

let killed = 0;
for (const arm of ARMS) {
  const target = path.join(REPO, arm.file);
  const original = fs.readFileSync(target, "utf-8");
  const occurrences = original.split(arm.from).length - 1;
  if (occurrences !== 1) {
    console.log(`NOT APPLIED (${occurrences} matches) — ${arm.name}`);
    continue;
  }
  fs.writeFileSync(target, original.replace(arm.from, arm.to));
  let survived = true;
  try {
    execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "pipe" });
    execFileSync("node", ["--test", "--test-concurrency", "1", ...SUITE], { cwd: REPO, stdio: "pipe" });
  } catch {
    survived = false;
  }
  fs.writeFileSync(target, original);
  if (survived) console.log(`SURVIVED — ${arm.name}`);
  else {
    killed++;
    console.log(`killed   — ${arm.name}`);
  }
}
execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "pipe" });
console.log(`${killed} of ${ARMS.length} killed`);
