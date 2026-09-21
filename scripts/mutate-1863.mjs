import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/guide-ranking-key-cap.test.ts",
  "test/analytics-rollup.test.ts",
  "test/rollup-day-source.test.ts",
  "test/traffic-attribution.test.ts",
];

const MUTANTS = [
  ["a-reserved-key-is-folded-like-any-other", "src/stats.ts",
    `  if (isReservedClassRouteKey(key)) {\n    bump(target, key, delta);\n    return;\n  }`,
    ""],

  ["reserved-keys-eat-the-budget-they-are-exempt-from", "src/stats.ts",
    `  let n = 0;\n  for (const key of keys) if (!isReservedClassRouteKey(key)) n++;\n  return n;`,
    `  return [...keys].length;`],

  ["every-key-reads-as-reserved", "src/stats.ts",
    `  return reservedRouteClasses.has(key.slice(0, sep)) && reservedRoutePaths.has(key.slice(sep + 1));`,
    `  return true;`],

  ["a-reserved-path-is-reserved-for-every-class", "src/stats.ts",
    `  return reservedRouteClasses.has(key.slice(0, sep)) && reservedRoutePaths.has(key.slice(sep + 1));`,
    `  return reservedRoutePaths.has(key.slice(sep + 1));`],

  ["a-reserved-path-is-collapsed-onto-its-prefix-template", "src/stats.ts",
    `  if (reservedRoutePaths.has(clean)) return clean;`,
    ""],

  ["any-string-is-accepted-as-a-reserved-path", "src/stats.ts",
    `  reservedRoutePaths = new Set(paths.filter((p) => RESERVED_ROUTE_PATH.test(p)));`,
    `  reservedRoutePaths = new Set(paths);`],

  ["the-cap-discards-nothing-worth-recording", "src/stats.ts",
    `  if (used === key) return;\n  bumpBounded(\n    discards,`,
    `  if (used === key || true) return;\n  bumpBounded(\n    discards,`],

  ["a-partial-day-claims-the-reservation-it-did-not-have", "src/stats.ts",
    `  if (!reservedFrom || date <= reservedFrom) return [];`,
    ""],

  ["the-day-the-reservation-began-counts-as-covered", "src/stats.ts",
    `  if (!reservedFrom || date <= reservedFrom) return [];`,
    `  if (!reservedFrom || date < reservedFrom) return [];`],

  ["the-overflow-bucket-counts-as-a-kept-key", "src/stats.ts",
    `    if (key.slice(key.indexOf(CLASS_ROUTE_SEP) + 1) !== OVERFLOW_PAGE_KEY) keysKept++;`,
    `    keysKept++;`],

  ["a-saturated-discard-tracker-still-reports-an-exact-count", "src/stats.ts",
    `    if (key === DISCARDED_KEY_OVERFLOW) exact = false;\n    else keysDiscarded++;`,
    `    keysDiscarded++;`],

  ["a-rollup-written-before-the-block-reads-as-a-measured-zero", "src/analytics-rollup.ts",
    `  if (!raw || typeof raw !== "object") return null;\n  const obj = raw as Record<string, unknown>;\n  const reserved = Array.isArray(obj.reserved_paths)`,
    `  const obj = (raw ?? {}) as Record<string, unknown>;\n  const reserved = Array.isArray(obj.reserved_paths)`],

  ["every-day-in-the-window-is-ranked", "src/homepage-routing.ts",
    `): DailyRollup[] {\n  return mostRecentDays(rollups, days).filter((day) => {`,
    `): DailyRollup[] {\n  if (days > 0) return mostRecentDays(rollups, days);\n  return mostRecentDays(rollups, days).filter((day) => {`],

  ["one-measured-guide-makes-a-day-rankable", "src/homepage-routing.ts",
    `    return guides.every((guide) => {`,
    `    return guides.some((guide) => {`],

  ["a-quiet-day-is-not-a-measurement", "src/homepage-routing.ts",
    `    if (agentOverflowOn(day) === 0) return true;\n    const reserved = new Set(day.traffic.class_route_truncation?.reserved_paths ?? []);`,
    `    const reserved = new Set(day.traffic.class_route_truncation?.reserved_paths ?? []);`],

  ["a-reserved-day-is-not-a-measurement", "src/homepage-routing.ts",
    `      return reserved.has(path) || agentRouteKey(path) in day.traffic.by_class_route;`,
    `      return agentRouteKey(path) in day.traffic.by_class_route;`],

  ["a-guide-with-its-own-key-is-not-a-measurement", "src/homepage-routing.ts",
    `      return reserved.has(path) || agentRouteKey(path) in day.traffic.by_class_route;`,
    `      return reserved.has(path);`],

  ["requests-that-reached-no-path-count-as-attributed", "src/homepage-routing.ts",
    `      if (key.slice(sep + 1) === OVERFLOW_PAGE_KEY) unattributed += count;\n      else attributed += count;`,
    `      attributed += count;`],

  ["the-page-claims-the-ranking-and-nothing-else-regardless", "src/homepage-routing.ts",
    `  if (attribution.unattributed === 0) {`,
    `  if (true) {`],

  ["the-page-never-claims-the-ranking-and-nothing-else", "src/homepage-routing.ts",
    `  if (attribution.unattributed === 0) {`,
    `  if (false) {`],

  ["a-share-too-small-to-round-is-published-as-zero", "src/homepage-routing.ts",
    `  return pct > 0 && pct < 0.1 ? "under 0.1%" : \`\${pct.toFixed(1)}%\`;`,
    `  return \`\${pct.toFixed(1)}%\`;`],

  ["an-unrankable-window-still-makes-a-ranking-claim", "src/homepage-routing.ts",
    `    return \`All \${populationCount} guides we publish, in the order /guides lists them, and not a ranking. \`\n      + \`We hold \${heldDays} days of traffic and can rank on none of them: on every one, at least one guide's requests could have been folded into a shared bucket, so a zero there would not mean no agent opened it.\`;`,
    `    return \`The \${selectedCount} of \${populationCount} guides AI agents opened most across the \${heldDays} days of traffic we hold. Membership is that ranking and nothing else.\`;`],

  ["the-reservation-covers-every-class-not-the-ranked-one", "src/serve.ts",
    `setReservedRouteKeys(guidesIndexEntries().map(e => \`/\${e.slug}\`), [RANKED_TRAFFIC_CLASS]);`,
    `setReservedRouteKeys(guidesIndexEntries().map(e => \`/\${e.slug}\`), ["ai_agent", "browser", "unknown"]);`],

  ["nothing-is-reserved-at-all", "src/serve.ts",
    `setReservedRouteKeys(guidesIndexEntries().map(e => \`/\${e.slug}\`), [RANKED_TRAFFIC_CLASS]);`,
    `setReservedRouteKeys([], [RANKED_TRAFFIC_CLASS]);`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function suitesPass() {
  for (const file of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", file])) return false;
  }
  return true;
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!run("npm", ["run", "build"])) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suitesPass()) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "NOT APPLIED — did not compile"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const scored = MUTANTS.length - notApplied.length - uncompiled.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
