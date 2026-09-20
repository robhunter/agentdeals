import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bestOfPublishedPath, emptyBestOfPublished, parseBestOfPublished, recordBestOfPublished, serializeBestOfPublished,
} from "../dist/best-of-publication.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Record every /best/ path this build serves, so none of them can later 404.

A best-of page is published when its qualified list reaches BEST_OF_MIN_PICKS. That list moves
with the clock: an offer we have not re-read in 90 days is demoted, so a page that publishes
today can fall under the floor without a vendor changing anything. The ledger this script keeps
is what stops the path going with it. It is only ever added to — a path that stops qualifying
stays in the file, and the site keeps serving it with the counts it actually holds.

Usage: node scripts/record-best-of-published.js [options]

  --check         Report what would be added and exit 1 if anything would, without writing
  --date <date>   Day to stamp the ledger with, YYYY-MM-DD (default: today, UTC)
  --help          This text
`;

const ORIGIN = "http://localhost";

function parseArgs(argv) {
  const opts = { check: false, date: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--check") opts.check = true;
    else if (arg === "--date") opts.date = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

function startServer(inventoryOut) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: ORIGIN, AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("The server did not report a port within 60s"));
    }, 60000);
    proc.stderr.on("data", chunk => {
      if (/running on http:\/\/localhost:(\d+)/.test(chunk.toString())) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", err => { clearTimeout(timeout); reject(err); });
    proc.on("exit", code => { clearTimeout(timeout); reject(new Error(`The server exited with status ${code} before reporting a port`)); });
  });
}

function heldLedger(file) {
  try {
    return parseBestOfPublished(readFileSync(file, "utf-8"), file);
  } catch (err) {
    if (err.code === "ENOENT" || /Cannot read/.test(err.message)) return emptyBestOfPublished("1970-01-01");
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(opts.invalid ? 2 : 0);
  }

  const work = mkdtempSync(join(tmpdir(), "best-of-published-"));
  const inventoryOut = join(work, "inventory.json");
  let proc;
  try {
    proc = await startServer(inventoryOut);
    proc.kill();
    const inventory = JSON.parse(readFileSync(inventoryOut, "utf-8"));
    const serving = inventory
      .filter(pagePath => pagePath.startsWith("/best/"))
      .map(pagePath => pagePath.slice("/best/".length));
    if (serving.length === 0) throw new Error("The build served no /best/ path at all, so there is nothing to record");

    const file = bestOfPublishedPath();
    const previous = heldLedger(file);
    const { ledger, added } = recordBestOfPublished(previous, serving, opts.date);

    console.log(`serving ${serving.length} best-of paths, ledger holds ${ledger.slugs.length}, ${added.length} new`);
    for (const slug of added) console.log(`  + ${slug}`);

    if (opts.check) process.exit(added.length === 0 ? 0 : 1);
    if (added.length > 0) writeFileSync(file, serializeBestOfPublished(ledger));
  } finally {
    proc?.kill();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
