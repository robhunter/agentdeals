import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRollup, writeRollup, ROLLUP_DIR, ROLLUP_DATE_PATTERN } from "../dist/analytics-rollup.js";

const HELP = `Write a dated durable copy of one day of analytics.

Reads the day's aggregate from a running agentdeals instance and commits it to a flat
file, because the counters it comes from are pruned by date and the container filesystem
they are served from is rebuilt on every deploy. Files already present are only rewritten
when the stored copy is incomplete.

Usage: node scripts/rollup-analytics.js [options]

  --base <url>    Instance to read from (default https://agentdeals.dev)
  --date <date>   Roll up one YYYY-MM-DD instead of every date on offer
  --dir <path>    Where to write (default ${ROLLUP_DIR})
  --skip-today    Do not write a partial file for the current UTC date
  --dry-run       Report what would be written, write nothing
  --help          This text
`;

function parseArgs(argv) {
  const opts = {
    base: "https://agentdeals.dev",
    date: null,
    dir: ROLLUP_DIR,
    skipToday: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--date") opts.date = argv[++i];
    else if (arg === "--dir") opts.dir = argv[++i];
    else if (arg === "--skip-today") opts.skipToday = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

const USER_AGENT = "agentdeals-internal/1.0 (analytics rollup)";

async function fetchDay(base, date) {
  const url = `${base.replace(/\/$/, "")}/api/analytics/daily?date=${date}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${url} returned unparseable JSON`);
  }
  return parsed;
}

function storedIsFinal(dir, date) {
  const path = join(dir, `${date}.json`);
  if (!existsSync(path)) return false;
  try {
    const stored = parseRollup(JSON.parse(readFileSync(path, "utf-8")));
    return stored !== null && stored.complete === true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(opts.invalid ? 1 : 0);
  }

  const today = new Date().toISOString().slice(0, 10);

  if (opts.date && !ROLLUP_DATE_PATTERN.test(opts.date)) {
    console.error(`--date must be YYYY-MM-DD, got ${opts.date}`);
    process.exit(1);
  }

  const probe = await fetchDay(opts.base, opts.date ?? today);
  const offered = Array.isArray(probe.dates_available) ? probe.dates_available : [];
  const dates = opts.date
    ? [opts.date]
    : offered.filter(d => ROLLUP_DATE_PATTERN.test(d)).filter(d => !(opts.skipToday && d === today));

  if (dates.length === 0) {
    console.log("No dates on offer — the instance is holding no dated counters.");
    process.exit(0);
  }

  let written = 0;
  let skipped = 0;
  for (const date of dates) {
    if (storedIsFinal(opts.dir, date)) {
      skipped++;
      continue;
    }
    const payload = date === (opts.date ?? today) ? probe : await fetchDay(opts.base, date);
    const rollup = parseRollup(payload);
    if (!rollup) {
      console.error(`${date}: response did not parse as a rollup — refusing to write`);
      process.exit(1);
    }
    const label = rollup.complete ? "final" : "partial";
    if (opts.dryRun) {
      console.log(`would write ${join(opts.dir, `${date}.json`)} (${label}, served ${rollup.page_views.served}, signals ${rollup.signals.total})`);
    } else {
      const path = writeRollup(opts.dir, rollup);
      console.log(`wrote ${path} (${label}, served ${rollup.page_views.served}, signals ${rollup.signals.total})`);
    }
    written++;
  }

  console.log(`Rolled up: ${written}`);
  console.log(`Already final: ${skipped}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
