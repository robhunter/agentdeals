import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/change-feed-provenance.test.ts",
  "test/change-date-provenance.test.ts",
  "test/homepage-cites-what-it-serves.test.ts",
];

const MUTANTS = [
  ["an-entry-is-stamped-with-the-instant-it-was-asked-for", "src/change-dates.ts",
    "  return new Date(noon <= now.getTime() ? noon : Date.parse(`${stamped}T00:00:00Z`)).toISOString();",
    "  return new Date(Math.min(noon, now.getTime())).toISOString();"],

  ["a-day-not-yet-reached-is-stamped-in-the-future", "src/change-dates.ts",
    "  const stamped = /^\\d{4}-\\d{2}-\\d{2}$/.test(day) && day < served ? day : served;",
    "  const stamped = /^\\d{4}-\\d{2}-\\d{2}$/.test(day) ? day : served;"],

  ["a-day-that-is-not-a-date-falls-back-to-the-instant", "src/change-dates.ts",
    "  const served = now.toISOString().slice(0, 10);",
    "  const served = new Date().toISOString().slice(0, 10);"],

  ["every-entry-in-one-document-reads-its-own-clock", "src/serve.ts",
    "    const fields = feedEntryFields(c, servedAt);",
    "    const fields = feedEntryFields(c);"],

  ["the-channel-stamp-reads-a-clock-of-its-own", "src/serve.ts",
    "  <updated>${feedUpdatedTimestamp(selected, servedAt)}</updated>",
    "  <updated>${feedUpdatedTimestamp(selected)}</updated>"],

  ["the-weekly-digest-dates-each-week-from-its-own-clock", "src/serve.ts",
    "      const pubDate = feedEntryUpdated(newestChange, servedAt);",
    "      const pubDate = feedEntryUpdated(newestChange);"],

  ["a-quoted-record-is-read-as-our-own-sentence", "test/homepage-cites-what-it-serves.test.ts",
    "    const { prose } = withoutQuotedRecords(withoutMarkup(home), publishedSummaries());",
    "    const prose = withoutMarkup(home);"],

  ["any-fragment-counts-as-a-quotation", "test/homepage-cites-what-it-serves.test.ts",
    "const QUOTED_RECORD_MIN_LENGTH = 30;",
    "const QUOTED_RECORD_MIN_LENGTH = 0;"],

  ["a-quotation-is-matched-before-the-page-escapes-it", "test/homepage-cites-what-it-serves.test.ts",
    "    const served = asServed(summary);",
    "    const served = summary;"],
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
  const green = built && run("npx", ["tsx", "--test", "--test-concurrency", "1", ...SUITE]);
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
