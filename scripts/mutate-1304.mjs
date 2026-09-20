import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TESTS = [
  "test/discontinued-product-gate.test.ts",
  "test/product-deprecation.test.ts",
  "test/ranking.test.ts",
].join(" ");

const ONLY = process.argv[2] ?? null;

const MUTANTS = [
  {
    name: "the gate never reads the vendor's records",
    file: "src/ranking.ts",
    from: `  const discontinuedOn = discontinuedOnOrBefore(vendorChanges, date);`,
    to: `  const discontinuedOn = discontinuedOnOrBefore([], date);`,
  },
  {
    name: "a day still ahead of us ends the product today",
    file: "src/product-deprecation.ts",
    from: `    if (!date || date > today) continue;`,
    to: `    if (!date) continue;`,
  },
  {
    name: "a deprecation of another product ends the one we list",
    file: "src/product-deprecation.ts",
    from: `export function discontinuationDate(change: DeprecationRecord): string | null {\n  if (!deprecationEndsTheListedProduct(change)) return null;\n`,
    to: `export function discontinuationDate(change: DeprecationRecord): string | null {\n`,
  },
  {
    name: "the ranker never asks whether the product has stopped",
    file: "src/ranking.ts",
    from: `  const discontinued = discontinuedGateFor(offer, vendorChanges, date);\n  if (discontinued) return discontinued;\n`,
    to: ``,
  },
  {
    name: "the day the record states is ignored in favour of its prose",
    file: "src/product-deprecation.ts",
    from: `  const stated = change.discontinued_date;\n  if (stated === DISCONTINUATION_DATE_UNRESOLVED) return null;\n  if (typeof stated === "string" && ISO_DATE.test(stated)) return stated;\n`,
    to: ``,
  },
  {
    name: "a record that states no day falls back to its prose anyway",
    file: "src/product-deprecation.ts",
    from: `  if (stated === DISCONTINUATION_DATE_UNRESOLVED) return null;\n`,
    to: ``,
  },
  {
    name: "the stated day is taken whatever shape it is written in",
    file: "src/product-deprecation.ts",
    from: `  if (typeof stated === "string" && ISO_DATE.test(stated)) return stated;`,
    to: `  if (typeof stated === "string") return stated;`,
  },
  {
    name: "a record outranks the tier the offer itself states",
    file: "src/ranking.ts",
    from: `  const retired = retiredGateFor(offer);\n  if (retired) return retired;\n  const discontinued = discontinuedGateFor(offer, vendorChanges, date);\n  if (discontinued) return discontinued;\n`,
    to: `  const discontinued = discontinuedGateFor(offer, vendorChanges, date);\n  if (discontinued) return discontinued;\n  const retired = retiredGateFor(offer);\n  if (retired) return retired;\n`,
  },
  {
    name: "ranking a category reads no change records",
    file: "src/ranking.ts",
    from: `    const gate = gateFor(offer, date, byVendor.get(offer.vendor.toLowerCase()) ?? []);`,
    to: `    const gate = gateFor(offer, date, []);`,
  },
  {
    name: "the gate an API result publishes reads no change records",
    file: "src/data.ts",
    from: `  return gateFor(offer, date, changesForVendor(offer.vendor));`,
    to: `  return gateFor(offer, date, []);`,
  },
  {
    name: "the vendor page reads no change records",
    file: "src/vendor-verdict-input.ts",
    from: `  const gate = gateFor(primary, servedOn, vendorChanges);`,
    to: `  const gate = gateFor(primary, servedOn, []);`,
  },
  {
    name: "a discontinued product still counts as having a free tier",
    file: "src/serve.ts",
    from: `const GATES_LEAVING_NO_FREE_TIER: readonly string[] = ["not_a_free_offer", "offer_expired", "product_discontinued"];`,
    to: `const GATES_LEAVING_NO_FREE_TIER: readonly string[] = ["not_a_free_offer", "offer_expired"];`,
  },
  {
    name: "the reason the gate publishes names no day",
    file: "src/ranking.ts",
    from: `    reason: \`\${discontinuedClause(offer.vendor, discontinuedOn)}.\`,`,
    to: `    reason: "This offer is not a current option.",`,
  },
];

const originals = new Map();
for (const mutant of MUTANTS) {
  if (!originals.has(mutant.file)) originals.set(mutant.file, readFileSync(mutant.file, "utf8"));
}

const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };

process.on("exit", restore);

let killed = 0;
const survived = [];

for (const mutant of MUTANTS) {
  if (ONLY !== null && !mutant.name.includes(ONLY)) continue;
  restore();
  const before = readFileSync(mutant.file, "utf8");
  if (!before.includes(mutant.from)) {
    survived.push(`${mutant.name} — NOT APPLIED, the text it aims at is not in ${mutant.file}`);
    console.log(`NOT APPLIED  ${mutant.name}`);
    continue;
  }
  if (before.split(mutant.from).length !== 2) {
    survived.push(`${mutant.name} — NOT APPLIED, the text it aims at appears more than once in ${mutant.file}`);
    console.log(`NOT APPLIED  ${mutant.name}`);
    continue;
  }
  writeFileSync(mutant.file, before.replace(mutant.from, mutant.to));
  if (readFileSync(mutant.file, "utf8") === before) {
    survived.push(`${mutant.name} — NOT APPLIED, the replacement left the file unchanged`);
    console.log(`NOT APPLIED  ${mutant.name}`);
    continue;
  }
  try {
    execSync("npm run build", { stdio: "pipe" });
  } catch {
    survived.push(`${mutant.name} — NOT APPLIED, the compiler refused it, which is not a kill`);
    console.log(`NOT APPLIED  ${mutant.name}`);
    continue;
  }
  try {
    execSync(`node --test --test-concurrency 1 ${TESTS}`, { stdio: "pipe", timeout: 300000 });
    survived.push(mutant.name);
    console.log(`SURVIVED     ${mutant.name}`);
  } catch {
    killed++;
    console.log(`killed       ${mutant.name}`);
  }
}

restore();
execSync("npm run build", { stdio: "pipe" });
console.log(`\n${killed} of ${MUTANTS.length} killed`);
if (survived.length) { console.log("\nnot killed:"); for (const s of survived) console.log("  " + s); }
