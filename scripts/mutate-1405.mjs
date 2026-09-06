import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/change-reporting.test.ts",
  "test/validate.test.ts",
  "test/uncited-change-records.test.ts",
  "test/stale-page-facts.test.ts",
];

const MUTANTS = [
  ["change-reporting", "src/change-reporting.ts",
    `return change.reports === "our_index" ? "our_index" : DEFAULT_CHANGE_REPORT_SUBJECT;`,
    `return DEFAULT_CHANGE_REPORT_SUBJECT;`],
  ["budget-drops-the-subject", "src/change-reporting.ts",
    `return reportsAVendorOffer(change) && changeIsUncited(change);`,
    `return changeIsUncited(change);`],
  ["budget-drops-the-citation", "src/change-reporting.ts",
    `return reportsAVendorOffer(change) && changeIsUncited(change);`,
    `return reportsAVendorOffer(change);`],
  ["index-record-may-cite", "src/change-reporting.ts",
    `return reportsOurIndex(change) && !changeIsUncited(change);`,
    `return false;`],
  ["claim-ignores-the-host", "src/change-citation.ts",
    `    if (hosts.length > 0 && !hosts.includes(host)) continue;`,
    `    if (false) continue;`],
  ["claim-ignores-an-older-page", "src/change-citation.ts",
    `      if (A_DIFFERENT_DOCUMENT.test(sentence.slice(Math.max(0, claim.index - 12), claim.index))) continue;`,
    `      if (false) continue;`],
  ["claim-loses-its-proximity", "src/change-citation.ts",
    `const UNREADABLE_DOCUMENT = new RegExp(DOCUMENT_NOUN + STILL_THE_SAME_SUBJECT + CANNOT_BE_READ, "gi");`,
    `const UNREADABLE_DOCUMENT = new RegExp(DOCUMENT_NOUN + "[\\\\s\\\\S]{0,25}" + CANNOT_BE_READ, "gi");`],
  ["claim-never-fires", "src/change-citation.ts",
    `      return claim[0].trim();`,
    `      if (claim) return null;`],
  ["ratchet-drops-the-reason", "src/page-reviews.ts",
    `  if (Object.keys(explained).length > 0) file.raised_because = explained;`,
    `  if (false) file.raised_because = explained;`],
  ["reason-for-an-unknown-budget", "src/page-reviews.ts",
    `      throw new Error(\`\${source} explains raising \${name}, which no budget in the code reads\`);`,
    `      continue;`],
  ["reason-that-says-nothing", "src/page-reviews.ts",
    `      throw new Error(\`\${source} gives no reason for raising \${name}\`);`,
    `      continue;`],
  ["validator-skips-the-unreadable-page", "scripts/validate-data.ts",
    `    const unreadable = summaryCallsItsSourceUnreadable(change);`,
    `    const unreadable = null;`],
  ["validator-skips-the-index-record", "scripts/validate-data.ts",
    `    if (ourIndexChangeMayNotCiteASource(change)) {`,
    `    if (false) {`],
  ["validator-counts-every-uncited-record", "scripts/validate-data.ts",
    `    .filter(({ change }) => countsAgainstUncitedBudget(change));`,
    `    .filter(({ change }) => !change.source_url);`],
  ["schema-drops-the-field", "src/openapi.ts",
    `          reports: { type: "string", enum: ["vendor_offer", "our_index"],`,
    `          reports_absent: { type: "string", enum: ["vendor_offer", "our_index"],`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = file.startsWith("src/") ? run("npm", ["run", "build"]) : true;
  const green = built && run("node", ["--test", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
