import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/monthly-change-series.test.ts"];

const MUTANTS = [
  ["trend-chart-bins-every-record", "src/serve.ts",
    `  const sortedMonths = tallyMonths(changeMonths.effective);`,
    `  const sortedMonths = tallyMonths(monthlyChangeSeries(dealChanges.map(c => ({ ...c, date_source: "hand_written" as typeof c.date_source }))).effective);`],
  ["risk-card-bins-every-record", "src/serve.ts",
    `  const monthlyChanges = new Map([...changeMonths.effective].map(([month, records]) => [month, records.length]));`,
    `  const monthlyChanges = new Map([...monthlyChangeSeries(dealChanges.map(c => ({ ...c, date_source: "hand_written" as typeof c.date_source }))).effective].map(([month, records]) => [month, records.length]));`],
  ["quarter-report-bins-every-record", "src/serve.ts",
    `  const q1Changes = changesInWindow(dealChanges, { start: "2026-01-01", end: "2026-03-31" }).dated;`,
    `  const q1Changes = dealChanges.filter(c => c.date >= "2026-01-01" && c.date <= "2026-03-31");`],
  ["quarter-report-bins-its-months-without-the-partition", "src/serve.ts",
    `  const monthlyData = new Map([...monthlyChangeSeries(q1Changes).effective].map(([month, records]) => [month, {`,
    `  const monthlyData = new Map([...monthlyChangeSeries(dealChanges.filter(c => c.date >= "2026-01-01" && c.date <= "2026-03-31").map(c => ({ ...c, date_source: "hand_written" as typeof c.date_source }))).effective].map(([month, records]) => [month, {`],
  ["period-comparison-counts-every-record-in-the-window", "src/serve.ts",
    `    [...changeMonths.effective.values()].flat().filter(c => c.date >= start && c.date <= end).length;`,
    `    dealChanges.filter(c => c.date >= start && c.date <= end).length;`],
  ["period-comparison-is-hardcoded", "src/serve.ts",
    `    { label: "Q1 2026", count: countInWindow("2026-01-01", "2026-03-31") }`,
    `    { label: "Q1 2026", count: 50 }`],
  ["trend-chart-hides-the-discovery-series", "src/serve.ts",
    `  \${discoveredTotal > 0 ? \`<h3>\${discoveryMonthSeriesHeading(discoveredTotal)}</h3>`,
    `  \${false ? \`<h3>\${discoveryMonthSeriesHeading(discoveredTotal)}</h3>`],
  ["risk-card-hides-the-discovery-series", "src/serve.ts",
    `    \${discoveredTotal > 0 ? \`<p class="diff-desc"><strong>\${discoveryMonthSeriesHeading(discoveredTotal)}.</strong>`,
    `    \${false ? \`<p class="diff-desc"><strong>\${discoveryMonthSeriesHeading(discoveredTotal)}.</strong>`],
  ["discovery-series-does-not-say-when-we-read-the-page", "src/change-dates.ts",
    `export const DISCOVERY_MONTH_SERIES_NOTE =
  "These vendors’ pages state terms that differ from what we had stored and do not say when they changed. Each is counted in the month we read the page, so this series measures when we looked, not when the market moved. None of them are in the monthly figures above.";`,
    `export const DISCOVERY_MONTH_SERIES_NOTE =
  "These vendors’ pages state terms that differ from what we had stored.";`],
  ["trend-caption-claims-an-acceleration", "src/serve.ts",
    `  <p class="section-desc">\${EFFECTIVE_MONTH_SERIES_NOTE} Red bars = negative changes`,
    `  <p class="section-desc">Pricing changes by month, showing the acceleration in 2026. Red bars = negative changes`],
  ["risk-card-claims-the-pace-is-not-slowing", "src/serve.ts",
    `\${quarterAgainstHalf}</p>`,
    `\${quarterAgainstHalf} The pace isn't slowing.</p>`],
  ["partition-calls-a-discovered-record-event-dated", "src/change-dates.ts",
    `  for (const change of changes) (isEventDated(change) ? dated : discovered).push(change);`,
    `  for (const change of changes) dated.push(change);`],
  ["month-key-reads-the-day-as-well", "src/change-dates.ts",
    `    const month = change.date.slice(0, 7);`,
    `    const month = change.date.slice(0, 10);`],
  ["months-come-back-in-the-order-the-records-are-stored", "src/change-dates.ts",
    `  return new Map([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])));`,
    `  return byMonth;`],
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
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
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
console.log(`\n${MUTANTS.length - survivors.length - uncompiled.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
