import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unmatchedCuratedNames } from "../dist/curated-alternatives.js";

const HELP = `curated-alternatives-queue.js — collect curated alternative names we do not carry.

Usage:
  node scripts/curated-alternatives-queue.js [--check]

Every deal_changes record may name alternatives by hand. A name that matches no
offer in data/index.json cannot be linked on any page, so it is written to
data/curated_alternatives_unmatched.json as a review queue instead of being
dropped at render time. Reads data/deal_changes.json and data/index.json; makes
no network calls.

  --check  exit 1 if the committed file does not match the current data
  --help   show this message`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE_PATH = join(REPO, "data", "curated_alternatives_unmatched.json");

const changes = JSON.parse(readFileSync(join(REPO, "data", "deal_changes.json"), "utf8")).changes;
const offers = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf8")).offers;

const unmatched = unmatchedCuratedNames(changes, offers);
const serialised = JSON.stringify({ unmatched }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(QUEUE_PATH, "utf8");
  } catch {
    console.error(`${QUEUE_PATH} does not exist. Run: npm run queue:curated-alternatives`);
    process.exit(1);
  }
  if (committed !== serialised) {
    console.error(`${QUEUE_PATH} is stale. Run: npm run queue:curated-alternatives`);
    process.exit(1);
  }
  console.log(`${unmatched.length} unmatched curated names, file up to date`);
  process.exit(0);
}

writeFileSync(QUEUE_PATH, serialised);
console.log(`${unmatched.length} unmatched curated names written to data/curated_alternatives_unmatched.json`);
for (const entry of unmatched) {
  console.log(`  ${entry.name} — named by ${entry.named_by.join(", ")}`);
}
