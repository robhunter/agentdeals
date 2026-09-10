import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  DERIVED_FROM_THE_VENDOR_DATA,
  VENDOR_KEYED_DATA,
  holdbackVerdict,
  serializeVendorData,
  vendorsMoved,
  vendorsNamedInFailure,
  withVendorsAsTheyWereBefore,
} from "../dist/data-push-holdback.js";

const HELP = `Hold back the vendors a red suite names, so one bad reading costs one vendor rather than the batch.

Reads the run's data out of the working tree and the same files out of the baseline commit, works
out which vendors this run moved, and intersects that with the vendor names the failing tests
printed. Where the intersection is a proper, non-empty subset, every held vendor's rows are put
back the way the baseline had them and the files derived from those rows are reset, so the caller
can re-derive them and run the suite again. Nothing is pushed by this script and nothing is
decided by it: what reaches main is still only what the suite has passed.

Usage: node scripts/gate-hold-back-vendors.js --baseline <ref> --failures <log> --vendors-to <file> -- <committable path>...

Writes the held vendor names to the --vendors-to file, one per line, and says why on stdout.
Exit status: 0 vendors were held back, 1 the batch stands as it is, 2 the arguments were wrong.
`;

function parseArgs(argv) {
  const out = { baseline: "", failures: "", vendorsTo: "", paths: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--baseline") {
      out.baseline = argv[i + 1] ?? "";
      i += 2;
    } else if (arg === "--failures") {
      out.failures = argv[i + 1] ?? "";
      i += 2;
    } else if (arg === "--vendors-to") {
      out.vendorsTo = argv[i + 1] ?? "";
      i += 2;
    } else if (arg === "--") {
      out.paths.push(...argv.slice(i + 1));
      break;
    } else {
      return null;
    }
  }
  return out.baseline && out.failures && out.vendorsTo && out.paths.length > 0 ? out : null;
}

function atBaseline(ref, path) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

function inTheWorkingTree(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.log(HELP);
  process.exit(process.argv.slice(2).some((a) => a === "--help" || a === "-h") ? 0 : 2);
}

const committable = new Set(args.paths);
const log = existsSync(args.failures) ? readFileSync(args.failures, "utf8") : "";

const files = [];
const moved = new Map();
for (const entry of VENDOR_KEYED_DATA) {
  if (!committable.has(entry.path)) continue;
  const before = atBaseline(args.baseline, entry.path);
  const after = inTheWorkingTree(entry.path);
  if (before === null || after === null) continue;
  files.push({ ...entry, before, after });
  for (const vendor of vendorsMoved(before, after, entry.arrayKey)) {
    moved.set(vendor.toLowerCase(), vendor);
  }
}

if (files.length === 0) {
  console.log("None of the files a vendor's rows live in is among the paths this run may commit, so there is nothing to hold back.");
  process.exit(1);
}

const movedNames = [...moved.values()].sort((a, b) => a.localeCompare(b));
const verdict = holdbackVerdict(vendorsNamedInFailure(log, movedNames), movedNames);
console.log(verdict.reason);
if (verdict.decision !== "hold-back") process.exit(1);

for (const file of files) {
  const reduced = serializeVendorData(withVendorsAsTheyWereBefore(file.before, file.after, file.arrayKey, verdict.vendors));
  if (reduced === readFileSync(file.path, "utf8")) continue;
  writeFileSync(file.path, reduced);
  console.log(`${file.path}: ${verdict.vendors.join(", ")} put back the way ${args.baseline} had them.`);
}

const derived = DERIVED_FROM_THE_VENDOR_DATA.filter((path) => committable.has(path));
for (const path of derived) {
  try {
    execFileSync("git", ["checkout", args.baseline, "--", path], { stdio: "pipe" });
    console.log(`${path}: reset to ${args.baseline}, to be derived again from the data that is left.`);
  } catch {
    console.log(`${path}: could not be reset to ${args.baseline}, so it still reads the data this run held back.`);
    process.exit(1);
  }
}

writeFileSync(args.vendorsTo, verdict.vendors.map((v) => `${v}\n`).join(""));
