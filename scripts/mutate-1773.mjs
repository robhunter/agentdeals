import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  ["test/named-subsets.test.ts", [], { AGENTDEALS_CLOCK_BASE_DAYS: "0" }],
  ["test/named-subsets.test.ts", [], { AGENTDEALS_CLOCK_BASE_DAYS: "10" }],
];

const TIMELINE_SECTION = `    <h2>Pricing Change Timeline</h2>
    <p class="section-desc">\${escHtmlServer(A_COMPLETE_LOG_NOTICE)}</p>`;

const AT_RISK_DESC = `    <p class="section-desc">All \${atRisk.length} of the \${catOffers.length} vendors we list in this category that carry one. \${escHtmlServer(A_DEMOTION_IN_FORCE_RULE)}</p>\n`;

const STABLE_DESC = `    <p class="section-desc">All \${stablePicks.length} of the \${catOffers.length} vendors we list in this category that qualify, not a selection of them. \${escHtmlServer(NO_DEMOTION_IN_FORCE_RULE)}</p>`;

const COMPARE_HEADING = `      <h2><a href="/vendor/\${toSlug(a.vendor)}">\${escHtmlServer(a.vendor)}</a></h2>
      <div class="detail-row"><span class="detail-label">Risk</span><span class="detail-value">\${riskBadge(riskA)}</span></div>`;

const MUTANTS = [
  ["stable-picks-caps-at-twelve-again", "src/serve.ts",
    `  const stablePicks = enriched.filter(o => o.risk_level === "stable" && !o.recent_change);`,
    `  const stablePicks = enriched.filter(o => o.risk_level === "stable" && !o.recent_change).slice(0, 12);`],

  ["stable-picks-stops-stating-the-window-its-membership-rolls-on", "src/serve.ts",
    STABLE_DESC,
    `    <p class="section-desc">Vendors with no recent pricing changes and low risk scores.</p>`],

  ["the-at-risk-list-stops-stating-the-window-its-membership-rolls-on", "src/serve.ts",
    AT_RISK_DESC,
    ""],

  ["the-at-risk-list-claims-to-be-a-log-nothing-ever-leaves", "src/serve.ts",
    AT_RISK_DESC,
    `    <p class="section-desc">\${escHtmlServer(A_COMPLETE_LOG_NOTICE)}</p>\n`],

  ["the-timeline-stops-declaring-itself-a-complete-log", "src/serve.ts",
    TIMELINE_SECTION,
    `    <h2>Pricing Change Timeline</h2>`],

  ["the-filter-narrows-to-ten-days-while-the-copy-still-publishes-ninety", "src/data.ts",
    `  const cutoffDate = new Date(now.getTime() - RECENT_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000)`,
    `  const cutoffDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)`],

  ["the-filter-widens-to-a-year-while-the-copy-still-publishes-ninety", "src/data.ts",
    `  const cutoffDate = new Date(now.getTime() - RECENT_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000)`,
    `  const cutoffDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)`],

  ["a-comparison-heading-carries-a-verdict-that-lapses", "src/serve.ts",
    COMPARE_HEADING,
    `      <h2><a href="/vendor/\${toSlug(a.vendor)}">\${escHtmlServer(a.vendor)}</a> \${riskBadge(riskA)}</h2>`],

  ["the-volatile-class-stops-stating-when-a-demotion-stops-counting", "src/serve.ts",
    `\n  <p class="section-intro">\${escHtmlServer(VOLATILE_WHILE_A_DEMOTION_COUNTS_RULE)}</p>`,
    ""],
];

function run(cmd, args, env = {}) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  }
}

function suitesPass() {
  for (const [file, extra, env] of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", ...extra, file], env)) return false;
  }
  return true;
}

if (!run("npm", ["run", "build"])) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suitesPass()) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
