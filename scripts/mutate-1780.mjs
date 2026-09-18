import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const EVERY_DAY_PAIR_THIS_ISSUE_MEASURED = [0, 5, 11, 12, 18, 19];

const UPCOMING_ON_HOME = `    \${datedSectionNoticeHtml(
      \`\${namedWhileAheadOf("A change", today)} \${listOrderSentence("soonest-first")} \${atMostShownHere(UPCOMING_DEADLINES_ON_THE_HOME_PAGE)}\`,
      [
        { when: "On the day its date arrives it moves to", text: "Recent pricing changes, below", href: "#recent-changes" },
        { when: "Every deadline we hold, including any this list is too short to reach, is on", text: "the deadline tracker", href: "/deadlines" },
      ],
      escHtmlServer,
    )}\n`;

const RECENT_ON_HOME = `    \${datedSectionNoticeHtml(
      \`\${namedOnceItsDateArrived("A change", today)} \${onlyTheMostRecentShown(RECENT_CHANGES_ON_THE_HOME_PAGE)}\`,
      [
        { when: "A change leaves this list on the day a more recent one takes effect, and stays in", text: "the full change log", href: "/changes" },
      ],
      escHtmlServer,
    )}\n`;

const ANNOUNCED_ON_TRENDS = `    \${datedSectionNoticeHtml(
      announcedIntro(announced.length, asOf),
      [
        { when: "On its own date a record here joins", text: "the Pricing Change Timeline, below", href: "#timeline" },
      ],
      escHtmlServer,
      ' class="section-desc dated-rule"',
    )}`;

const DEADLINES_PAGE = `  \${datedSectionNoticeHtml(
    \`\${namedWhileAheadOf("A deadline", today)} It is not removed because the shutdown was cancelled or because we stopped holding the record.\`,
    [
      { when: "On the day its date arrives it leaves this page for", text: "the full change log", href: "/changes" },
    ],
    escHtmlServer,
    ' class="page-intro dated-rule"',
  )}`;

const EXPIRING_PAGE = `  \${datedSectionNoticeHtml(
    \`A change is grouped under the month its effective date falls in while that date is \${today} or later. A change whose effective date we do not hold is grouped instead by the day we discovered it, under Recently Discovered, and leaves that section 30 days after that day.\`,
    [
      { when: "On the day its date passes it moves out of its month and into", text: "Recently Changed, below", href: "#recently-changed" },
      { when: "It leaves that section 30 days later, and every record we hold stays in", text: "the full change log", href: "/changes" },
    ],
    escHtmlServer,
    ' class="page-intro dated-rule"',
  )}`;

const UPCOMING_ON_PRICING_CHANGES = `    \${datedSectionNoticeHtml(
      namedWhileNotBefore("A change", today),
      [
        { when: "The day after that date it stops being upcoming and is listed only under the month it falls in, in the timeline below and in", text: "the full change log", href: "/changes" },
      ],
      escHtmlServer,
      ' class="upcoming-intro dated-rule"',
    )}`;

const CARD_HEADING_NOTICE = `  const groupHeading = html.indexOf('<h2 id="categories">');
  if (groupHeading === -1) return html;`;

const HOME_DESTINATIONS = `      [
        { when: "A change leaves this list on the day a more recent one takes effect, and stays in", text: "the full change log", href: "/changes" },
      ],
      escHtmlServer,
    )}`;

const MUTANTS = [
  ["the-home-page-stops-saying-where-an-upcoming-change-goes-when-its-date-arrives", "src/serve.ts",
    UPCOMING_ON_HOME, "", [11, 18]],

  ["the-home-page-stops-saying-what-pushes-a-change-off-its-five", "src/serve.ts",
    RECENT_ON_HOME, "", [11, 18]],

  ["the-trends-announced-section-stops-saying-where-a-record-goes", "src/serve.ts",
    ANNOUNCED_ON_TRENDS,
    `    <p class="section-desc">\${announcedIntro(announced.length, asOf)}</p>`, [11]],

  ["the-deadline-tracker-stops-saying-a-deadline-leaves-on-its-own-date", "src/serve.ts",
    DEADLINES_PAGE, "", [18]],

  ["the-expiring-page-stops-saying-a-month-empties-on-the-calendar", "src/serve.ts",
    EXPIRING_PAGE, "", [12]],

  ["the-pricing-change-log-stops-saying-upcoming-empties-on-the-calendar", "src/serve.ts",
    UPCOMING_ON_PRICING_CHANGES, "", [19]],

  ["a-dated-card-heading-stops-saying-its-date-is-a-citation", "src/serve.ts",
    CARD_HEADING_NOTICE,
    `  const groupHeading = html.indexOf('<h2 id="categories">');
  if (groupHeading !== -1) return html;`, [11]],

  ["the-home-page-says-the-calendar-moved-it-and-names-nowhere-to-look", "src/serve.ts",
    HOME_DESTINATIONS,
    `      [],
      escHtmlServer,
    )}`, [11, 18]],

  ["the-home-page-sends-a-dropped-change-to-a-page-that-does-not-hold-it", "src/serve.ts",
    `{ when: "A change leaves this list on the day a more recent one takes effect, and stays in", text: "the full change log", href: "/changes" },`,
    `{ when: "A change leaves this list on the day a more recent one takes effect, and stays in", text: "the full change log", href: "/criteria" },`, [11, 18]],

  ["the-deadline-tracker-sends-a-passed-deadline-to-a-page-that-does-not-hold-it", "src/serve.ts",
    `{ when: "On the day its date arrives it leaves this page for", text: "the full change log", href: "/changes" },`,
    `{ when: "On the day its date arrives it leaves this page for", text: "the full change log", href: "/criteria" },`, [18]],

  ["the-trends-announced-section-sends-a-record-to-a-heading-that-does-not-receive-it", "src/serve.ts",
    `{ when: "On its own date a record here joins", text: "the Pricing Change Timeline, below", href: "#timeline" },`,
    `{ when: "On its own date a record here joins", text: "the Pricing Change Timeline, below", href: "#at-risk" },`, [11]],

  ["the-shutdown-tracker-drops-a-completed-shutdown-from-its-structured-data-again", "src/serve.ts",
    `    numberOfItems: shutdowns.length,
    itemListElement: shutdowns.map((s, i) => ({`,
    `    numberOfItems: activeCount,
    itemListElement: shutdowns.filter(s => new Date(s.deadline) >= today).map((s, i) => ({`, [5, 11, 18]],

  ["the-home-page-states-five-and-prints-four", "src/serve.ts",
    `  .slice(0, RECENT_CHANGES_ON_THE_HOME_PAGE);`,
    `  .slice(0, RECENT_CHANGES_ON_THE_HOME_PAGE - 1);`, [0]],

  ["the-home-page-counts-its-upcoming-list-on-a-literal-of-its-own", "src/serve.ts",
    `\${atMostShownHere(UPCOMING_DEADLINES_ON_THE_HOME_PAGE)}`,
    `At most 8 are shown here.`, [0]],

  ["a-dated-heading-rule-strips-enough-to-merge-two-different-headings", "test/named-subsets.test.ts",
    `  return heading.replace(A_DATE_IN_A_HEADING, "").replace(/\\s+/g, " ").trim();`,
    `  return heading.replace(A_DATE_IN_A_HEADING, "").replace(/[a-z]+/g, "").replace(/\\s+/g, " ").trim();`, [11]],
];

function run(cmd, args, env = {}) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  }
}

function suitesPass(days) {
  for (const day of days) {
    if (!run("node", ["--test", "--test-concurrency", "1", "test/named-subsets.test.ts"], {
      AGENTDEALS_CLOCK_BASE_DAYS: String(day),
    })) return false;
  }
  return true;
}

if (!run("npm", ["run", "build"])) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
const BASELINE = process.env.MUTATE_ONLY ? [0] : EVERY_DAY_PAIR_THIS_ISSUE_MEASURED;
if (!suitesPass(BASELINE)) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
const skipped = [];
const only = process.env.MUTATE_ONLY ?? "";
for (const [name, file, from, to, days] of MUTANTS) {
  if (only !== "" && !name.includes(only)) continue;
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass(days);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name} (day-pairs ${days.join(", ")})`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
