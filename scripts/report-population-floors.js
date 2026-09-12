import { appendFileSync, existsSync, readFileSync } from "node:fs";

const HELP = `Print how close every population floor in the suite is to going red.

A floor is refused when it sits inside the quarter below the population it measures, so the
margin is the number of records that can leave before the floor stops clearing its headroom.
A floor with a margin of zero goes red on the day the data it guards shrinks by one, which is
the day a scheduled run does its job.

Run the suite with POPULATION_FLOOR_LOG set to a path, then point this at the same path:

  POPULATION_FLOOR_LOG=/tmp/floors.jsonl npm test
  npm run floors -- /tmp/floors.jsonl

Usage: node scripts/report-population-floors.js [log] [--within N] [--summary <path>]

  --within   name the floors whose margin is at or under N records (default 10)
  --summary  append the table to a file as markdown, for a job summary

Exit status is always 0: a narrow margin is a statement about a test, not about the data.
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const TAKES_A_VALUE = new Set(["--within", "--summary"]);
const flags = new Map();
const positional = [];
for (let at = 0; at < argv.length; at++) {
  if (TAKES_A_VALUE.has(argv[at])) flags.set(argv[at], argv[++at]);
  else if (!argv[at].startsWith("--")) positional.push(argv[at]);
}

const WITHIN = Number(flags.get("--within") ?? 10);
const SUMMARY = flags.get("--summary") ?? null;
const LOG = positional[0] ?? process.env.POPULATION_FLOOR_LOG;

if (!LOG) {
  console.error("No log to read. Run the suite with POPULATION_FLOOR_LOG set, then pass the same path.");
  process.exit(2);
}
if (!existsSync(LOG)) {
  console.error(`${LOG} does not exist. Run the suite with POPULATION_FLOOR_LOG=${LOG} first.`);
  process.exit(2);
}

const records = readFileSync(LOG, "utf-8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const THE_HELPER_S_OWN_TESTS = "test/population-floor.test.ts";

const asShare = (fraction) => `${(fraction * 100).toFixed(1)}%`;

const guards = [];
const coverage = [];
let itsOwnTests = 0;
for (const r of records) {
  if (typeof r.site === "string" && r.site.startsWith(`${THE_HELPER_S_OWN_TESTS}:`)) {
    itsOwnTests++;
    continue;
  }
  if (typeof r.floor === "number") {
    guards.push({
      site: r.site,
      subject: r.subject,
      states: `a floor of ${r.floor}`,
      measured: `${r.observed}`,
      margin: r.floor <= 1 ? Infinity : r.observed - Math.ceil((r.floor * 4) / 3),
      clearsAt: `${Math.floor((r.observed * 3) / 4)}`,
    });
  } else if (typeof r.share === "number") {
    guards.push({
      site: r.site,
      subject: r.subject,
      states: `a share of ${asShare(r.share)}`,
      measured: `${r.observed} of ${r.population}`,
      margin: r.observed - Math.ceil((r.population * r.share * 4) / 3),
      clearsAt: asShare(((r.observed / r.population) * 3) / 4),
    });
  } else if (typeof r.population === "number") {
    coverage.push({ site: r.site, subject: r.subject, observed: r.observed, population: r.population });
  }
}

const byMargin = [...guards].sort((a, b) => a.margin - b.margin || a.site.localeCompare(b.site));
const narrow = byMargin.filter((g) => g.margin <= WITHIN);

const table = [
  "| margin | assertion | states | measured | clears at | subject |",
  "|---:|---|---|---|---|---|",
  ...narrow.map(
    (g) => `| ${g.margin} | \`${g.site}\` | ${g.states} | ${g.measured} | ${g.clearsAt} | ${g.subject} |`,
  ),
].join("\n");

const headline =
  `${guards.length} population floors read, ${coverage.length} coverage assertions read` +
  `${itsOwnTests > 0 ? `, ${itsOwnTests} left out because they are ${THE_HELPER_S_OWN_TESTS} exercising the helper on figures of its own` : ""}. ` +
  `${narrow.length} floors are within ${WITHIN} records of going red, ${byMargin.filter((g) => g.margin <= 0).length} of them on the next record that leaves.`;

console.log(headline);
if (narrow.length > 0) console.log(`\n${table}`);

if (SUMMARY) {
  appendFileSync(SUMMARY, `## Population floors\n\n${headline}\n\n${narrow.length > 0 ? `${table}\n` : ""}`);
}
