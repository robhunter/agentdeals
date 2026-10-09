import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { recordsAddedFreeOnAPageThatDoesNotNameThem } from "../dist/added-records.js";

const HELP = `Refuses a change that adds to data/index.json a record classed as an ongoing free tier
whose cited page, by its source check, does not name its vendor.

Usage:
  node scripts/refuse-added-unnamed-free-records.js --base <git ref>

  --base <ref>  the commit whose data/index.json the change is compared with, such as origin/main

A record counts as added when no record at the base has its vendor, category and url.
Exits 1 when it refuses a record, 2 on a usage error.`;

const args = process.argv.slice(2);
const at = args.indexOf("--base");
const base = at === -1 ? null : args[at + 1];
if (args.includes("--help") || !base || base.startsWith("-")) {
  console.log(HELP);
  process.exit(args.includes("--help") ? 0 : 2);
}

const offersIn = (text) => JSON.parse(text).offers;
const before = offersIn(execFileSync("git", ["show", `${base}:data/index.json`], { encoding: "utf8", maxBuffer: 1 << 28 }));
const after = offersIn(readFileSync("data/index.json", "utf8"));
const refused = recordsAddedFreeOnAPageThatDoesNotNameThem(before, after);

if (refused.length === 0) {
  console.log(`No record added since ${base} is classed as an ongoing free tier on a page that does not name its vendor.`);
  process.exit(0);
}
for (const record of refused) {
  console.log(`${record.vendor} | ${record.category} | ${record.tier} | ${record.url}: ${record.source_check.detail}`);
}
console.error(`${refused.length} record(s) added since ${base} are classed as an ongoing free tier, and the page each cites does not name its vendor. Cite a page that names the vendor, or give the record a tier that is not classed free.`);
process.exit(1);
