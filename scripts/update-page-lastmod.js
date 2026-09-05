import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyPageLastmod, hashPageBody, pageLastmodPath, parsePageLastmod, serializePageLastmod, updatePageLastmod,
} from "../dist/page-lastmod.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Keep data/page-lastmod.json in step with what each page renders.

Every sitemap lastmod for a comparison, guide, alternatives or standing page is read from
this ledger. A page whose rendered output is unchanged keeps the day it last changed; a page
whose output has moved is stamped with today. That is what makes the date an observation
rather than a constant: freezing it requires the pages to stop changing.

Usage: node scripts/update-page-lastmod.js [options]

  --check         Report what would move and exit 1 if anything would, without writing
  --date <date>   Day to stamp changed pages with, YYYY-MM-DD (default: today, UTC)
  --json          Emit the outcome as JSON
  --help          This text
`;

const ORIGIN = "http://localhost";

function parseArgs(argv) {
  const opts = { check: false, date: new Date().toISOString().slice(0, 10), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--check") opts.check = true;
    else if (arg === "--json") opts.json = true;
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
      env: { ...process.env, PORT: "0", BASE_URL: ORIGIN, AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("The server did not report a port within 60s"));
    }, 60000);
    proc.stderr.on("data", chunk => {
      const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `${ORIGIN}:${match[1]}` });
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`The server exited with status ${code} before reporting a port`));
    });
  });
}

async function hashEveryPage(base, paths) {
  const hashes = new Map();
  for (const pagePath of paths) {
    const response = await fetch(base + pagePath);
    const body = await response.text();
    if (response.status !== 200) {
      throw new Error(`${pagePath} answered ${response.status}, so its output cannot be compared with what the ledger holds`);
    }
    hashes.set(pagePath, hashPageBody(body, base));
  }
  return hashes;
}

function readLedger(file, date) {
  try {
    return parsePageLastmod(readFileSync(file, "utf-8"), file);
  } catch (err) {
    if (err.code === "ENOENT" || /ENOENT/.test(err.message)) return emptyPageLastmod(date);
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return opts.invalid ? 2 : 0;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    console.error(`--date needs a YYYY-MM-DD day, got ${opts.date}`);
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), "page-lastmod-"));
  const inventoryOut = join(scratch, "inventory.json");
  let server;
  try {
    server = await startServer(inventoryOut);
    const paths = JSON.parse(readFileSync(inventoryOut, "utf-8"));
    const hashes = await hashEveryPage(server.base, paths);
    const file = pageLastmodPath();
    const previous = readLedger(file, opts.date);
    const { ledger, moved, added, dropped } = updatePageLastmod(previous, hashes, opts.date);

    if (opts.json) {
      console.log(JSON.stringify({ pages: paths.length, moved, added, dropped, generated: ledger.generated }, null, 2));
    } else {
      console.log(`Read ${paths.length} pages: ${moved.length} whose output moved, ${added.length} new, ${dropped.length} gone.`);
      for (const pagePath of moved.slice(0, 20)) console.log(`  moved  ${pagePath}`);
      if (moved.length > 20) console.log(`  ... and ${moved.length - 20} more`);
      for (const pagePath of added.slice(0, 20)) console.log(`  new    ${pagePath}`);
      for (const pagePath of dropped.slice(0, 20)) console.log(`  gone   ${pagePath}`);
    }

    if (opts.check) return moved.length + added.length + dropped.length > 0 ? 1 : 0;
    writeFileSync(file, serializePageLastmod(ledger));
    console.log(`Wrote ${file}`);
    return 0;
  } finally {
    if (server) server.proc.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err.message);
    process.exit(1);
  },
);
