#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { changeKey } from "./change-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGES_PATH = resolve(ROOT, "data", "deal_changes.json");
const TRACKED_PATH = "data/deal_changes.json";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

export function firstSeenDates(commits, readAtCommit) {
  const firstSeen = new Map();
  for (const { sha, date } of commits) {
    let changes;
    try {
      changes = readAtCommit(sha);
    } catch {
      continue;
    }
    for (const change of changes) {
      const key = changeKey(change);
      if (!firstSeen.has(key)) firstSeen.set(key, date);
    }
  }
  return firstSeen;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const log = git(["log", "--reverse", "--format=%H %cs", "--", TRACKED_PATH]).trim();
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date] = line.split(" ");
      return { sha, date };
    });

  const readAtCommit = (sha) => {
    const raw = git(["show", `${sha}:${TRACKED_PATH}`]);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.changes) ? parsed.changes : [];
  };

  const firstSeen = firstSeenDates(commits, readAtCommit);

  const data = JSON.parse(readFileSync(CHANGES_PATH, "utf-8"));
  let stamped = 0;
  let alreadyStamped = 0;
  let unresolved = 0;
  const unresolvedVendors = [];

  for (const change of data.changes) {
    if (change.recorded_date) {
      alreadyStamped++;
      continue;
    }
    const date = firstSeen.get(changeKey(change));
    if (!date) {
      unresolved++;
      unresolvedVendors.push(`${change.vendor} (${change.change_type}, ${change.date})`);
      continue;
    }
    change.recorded_date = date;
    stamped++;
  }

  console.log(`Commits touching ${TRACKED_PATH}: ${commits.length}`);
  console.log(`Distinct change keys seen across history: ${firstSeen.size}`);
  console.log(`Entries stamped: ${stamped}`);
  console.log(`Entries already carrying recorded_date: ${alreadyStamped}`);
  console.log(`Entries with no commit of origin: ${unresolved}`);
  for (const vendor of unresolvedVendors) console.log(`  ? ${vendor}`);

  const byMonth = {};
  for (const change of data.changes) {
    if (!change.recorded_date) continue;
    const month = change.recorded_date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }
  console.log("");
  console.log("Entries by month recorded:");
  for (const month of Object.keys(byMonth).sort()) {
    console.log(`  ${month}  ${byMonth[month]}`);
  }

  const recordedDays = [...new Set(data.changes.map((c) => c.recorded_date).filter(Boolean))].sort();
  let widestGap = 0;
  let widestGapRange = "";
  for (let i = 1; i < recordedDays.length; i++) {
    const gap = Math.round(
      (Date.parse(recordedDays[i]) - Date.parse(recordedDays[i - 1])) / 86400000
    );
    if (gap > widestGap) {
      widestGap = gap;
      widestGapRange = `${recordedDays[i - 1]} → ${recordedDays[i]}`;
    }
  }
  console.log("");
  console.log(`Distinct recording days: ${recordedDays.length}`);
  console.log(`Widest gap between recording days: ${widestGap} days (${widestGapRange})`);

  if (dryRun) {
    console.log("");
    console.log("Dry run — nothing written.");
    return;
  }

  writeFileSync(CHANGES_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log("");
  console.log(`Wrote ${CHANGES_PATH}`);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();
