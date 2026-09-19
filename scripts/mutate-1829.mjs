import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/change-log-only-vendors.test.ts", "test/population-floor.test.ts"];

const MUTANTS = [
  [
    "src/serve.ts",
    "s|const anchor = changeLogAnchorFor\\(c.vendor\\);|const anchor = namedVendorSlug(c.vendor) ? changeLogAnchorFor(c.vendor) : null;|g",
    "the change log addresses only the vendors the catalogue lists",
  ],
  [
    "src/data.ts",
    "s|export function vendorNameAsPublished\\(vendor: string\\): string \\{|export function vendorNameAsPublished(vendor: string): string { if (vendor) return vendor;|",
    "a renamed vendor's records are filed under the retired name",
  ],
  [
    "test/change-log-only-vendors.test.ts",
    "s|if \\(!slug\\) continue;|if (!slug \\|\\| namedVendorSlug(change.vendor) === null) continue;|",
    "the sweep skips every vendor the catalogue has no entry for",
  ],
  [
    "test/change-log-only-vendors.test.ts",
    "s|const ending = standing\\n    .filter|const ending = standing\\n    .filter(c => namedVendorSlug(c.vendor) !== null)\\n    .filter|",
    "the sweep ends a free tier only for a vendor the catalogue lists",
  ],
  [
    "test/population-floor.ts",
    "s|if \\(change.resolution\\) continue;|if (change.resolution) continue;\\n    if (ENDS_A_FREE_TIER.has(change.change_type) \\&\\& change.vendor.length > 40) continue;|",
    "the population reader drops an ending record it should count",
  ],
  [
    "test/change-log-only-vendors.test.ts",
    "s|const named = ended.filter\\(slot => outsideTheCatalogue\\(slot.label\\)\\);|const named = ended.filter(slot => outsideTheCatalogue(slot.label)).filter(() => false);|",
    "no slot naming an uncatalogued ended vendor is read",
  ],
  [
    "src/serve.ts",
    "s|const anchor = changeLogAnchorFor\\(c.vendor\\);|const anchor = null;|g",
    "the change log addresses no vendor at all",
  ],
];

function run() {
  try {
    execFileSync("node", ["--test", "--test-concurrency", "1", ...SUITE], { encoding: "utf8", stdio: "pipe" });
    return "SURVIVED";
  } catch {
    return "killed";
  }
}

function build() {
  try {
    execFileSync("npx", ["tsc"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

let killed = 0;
for (const [file, expression, description] of MUTANTS) {
  const original = readFileSync(file, "utf8");
  execFileSync("perl", ["-0pi", "-e", expression, file]);
  if (readFileSync(file, "utf8") === original) {
    console.log(`  NOT APPLIED  ${description} (${file})`);
    continue;
  }
  const compiled = file.startsWith("src/") ? build() : true;
  const verdict = compiled ? run() : "killed by the compiler";
  if (verdict !== "SURVIVED") killed++;
  console.log(`  ${verdict.padEnd(22)} ${description}`);
  writeFileSync(file, original);
  if (file.startsWith("src/")) build();
}

console.log(`\n${killed} of ${MUTANTS.length} killed`);
