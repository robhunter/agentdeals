import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = ["test/bare-root-one-hop.test.ts"];
const AUDIT = "scripts/bare-root-one-hop-audit.mjs";

const MUTANTS = [
  ["a-hop-that-resolves-back-to-the-root-still-answers", AUDIT,
    `  if (samePage(reading.final_url, rootUrl)) return false;\n  return reading.outcome === SOURCE_CHECK_OK;`,
    `  return reading.outcome === SOURCE_CHECK_OK;`],

  ["any-page-that-resolves-answers", AUDIT,
    `  return reading.outcome === SOURCE_CHECK_OK;\n}`,
    `  return true;\n}`],

  ["a-hop-that-states-no-terms-answers", AUDIT,
    `  return reading.outcome === SOURCE_CHECK_OK;\n}`,
    `  return reading.outcome === SOURCE_CHECK_OK || reading.outcome === SOURCE_CHECK_NO_TERMS;\n}`],

  ["the-trailing-slash-makes-it-a-different-page", AUDIT,
    `    return \`\${parsed.origin}\${parsed.pathname.replace(/\\/+$/, "")}\`;`,
    `    return \`\${parsed.origin}\${parsed.pathname}\`;`],

  ["we-never-ask-for-the-pricing-path-with-a-trailing-slash", AUDIT,
    `export const ONE_HOP_PATHS = ["/pricing", "/pricing/", "/plans", "/pricing.html"];`,
    `export const ONE_HOP_PATHS = ["/pricing", "/plans", "/pricing.html"];`],

  ["the-paths-that-also-answered-go-unreported", AUDIT,
    `    lost_to_the_winner: lost.map((hop) => hop.url),`,
    `    lost_to_the_winner: [],`],

  ["a-root-that-answers-today-is-counted-as-repointable", AUDIT,
    `  return probes.filter(\n    (probe) =>\n      probe.repoint_to &&\n      probe.winner_check &&\n      !(probe.root.ok && probe.root.outcome === SOURCE_CHECK_OK)\n  );`,
    `  return probes.filter((probe) => probe.repoint_to);`],

  ["the-repoint-restamps-the-verified-date", AUDIT,
    `    offer.url = probe.repoint_to;\n    offer.source_check = probe.winner_check;`,
    `    offer.url = probe.repoint_to;\n    offer.source_check = probe.winner_check;\n    offer.verifiedDate = probe.winner_check.checked;`],

  ["the-repoint-keeps-the-check-taken-on-the-root", AUDIT,
    `    offer.source_check = probe.winner_check;`,
    `    offer.source_check = probe.root.check;`],

  ["an-offer-whose-url-moved-since-the-probe-is-repointed-anyway", AUDIT,
    `    const offer = offers.find((one) => one.vendor === probe.vendor && one.url === probe.url);`,
    `    const offer = offers.find((one) => one.vendor === probe.vendor);`],

  ["a-root-we-could-not-fetch-is-counted-as-read", AUDIT,
    `  const rootUnreadable = probes.filter((p) => !p.root.ok);`,
    `  const rootUnreadable = probes.filter((p) => p.root.ok === false && p.root.error === "");`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function suitesPass() {
  for (const file of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", file])) return false;
  }
  return true;
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!suitesPass()) {
  console.error("the scoped suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const green = suitesPass();
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}

const scored = MUTANTS.length - notApplied.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
