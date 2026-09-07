import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/change-feed-provenance.test.ts"];

const MUTANTS = [
  ["entry-summary-drops-the-provenance-clause", "src/change-feed.ts",
    "  return `${feedEntryDateSentence(change)} ${change.summary}${states}`;",
    "  return `${change.summary}${states}`;"],
  ["a-discovered-entry-reads-like-an-event-date", "src/change-feed.ts",
    "  return isEventDated(change)\n    ? `${EFFECTIVE_DATE_PREFIX} ${change.date} · recorded ${recorded}.`",
    "  return true\n    ? `${EFFECTIVE_DATE_PREFIX} ${change.date} · recorded ${recorded}.`"],
  ["the-discovery-clause-does-not-say-we-read-the-page", "src/change-feed.ts",
    "`${DISCOVERED_DATE_PREFIX} ${recorded} · ${UNKNOWN_EFFECTIVE_DATE_MARKER} — this date is when we read the vendor's pricing page and found terms that differ from what we had stored. The page does not say when they changed, so it is not the date this took effect.`",
    "`${DISCOVERED_DATE_PREFIX} ${recorded} · ${UNKNOWN_EFFECTIVE_DATE_MARKER}.`"],
  ["an-entry-is-stamped-with-the-date-its-terms-take-effect", "src/change-feed.ts",
    "  return feedEntryUpdated(recordedOn(change), now);",
    "  return new Date(change.date + \"T00:00:00Z\").toISOString();"],
  ["the-channel-stamp-is-not-held-to-the-present", "src/change-feed.ts",
    "  if (newest === \"\") return nowIso;\n  return newest > nowIso ? nowIso : newest;",
    "  if (newest === \"\") return nowIso;\n  return newest;"],
  ["the-feed-carries-the-newest-effective-dates-instead", "src/change-feed.ts",
    "  return [...changes].sort(feedEntryOrder).slice(0, limit);",
    "  return [...changes].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);"],
  ["the-feed-does-not-declare-its-discovery-share", "src/serve.ts",
    "  const subtitle = `${CHANGE_FEED_DESCRIPTION} ${changeFeedProvenanceNote(selected, `${BASE_URL}/feed.xml`)}`;",
    "  const subtitle = CHANGE_FEED_DESCRIPTION;"],
  ["the-provenance-note-counts-every-entry-as-dated", "src/change-feed.ts",
    "  const { dated, discovered } = partitionByDateProvenance(entries);",
    "  const { dated, discovered } = { dated: entries, discovered: [] as FeedChange[] };"],
  ["the-weekly-feed-does-not-say-what-it-counts", "src/change-feed.ts",
    "export const WEEKLY_FEED_POPULATION_NOTE =\n  \"Each issue counts only changes with a known effective date. Pricing pages read for the first time in a week are reported inside the issue under their own heading and are not counted as changes that took effect that week — the per-change feed carries them individually and labels each one.\";",
    "export const WEEKLY_FEED_POPULATION_NOTE = \"A new issue is published every Sunday.\";"],
  ["an-entry-carries-no-typed-date-source", "src/serve.ts",
    "    <${ns}:date_source>${escXml(fields.dateSource)}</${ns}:date_source>",
    "    <${ns}:published_by>AgentDeals</${ns}:published_by>"],
  ["a-discovered-record-publishes-an-effective-date", "src/change-feed.ts",
    "  return isEventDated(change) ? change.date : null;",
    "  return change.date;"],
  ["a-feed-link-advertises-a-title-the-document-does-not-carry", "src/change-feed.ts",
    "  return `<link rel=\"alternate\" type=\"application/atom+xml\" title=\"${feed.title}\" href=\"${baseUrl}${feed.path}\">`;",
    "  return `<link rel=\"alternate\" type=\"application/atom+xml\" title=\"AgentDeals — Pricing Changes\" href=\"${baseUrl}${feed.path}\">`;"],
  ["a-change-surface-links-the-feed-it-does-not-name", "src/change-feed.ts",
    "  return `<link rel=\"alternate\" type=\"application/atom+xml\" title=\"${feed.title}\" href=\"${baseUrl}${feed.path}\">`;",
    "  return `<link rel=\"alternate\" type=\"application/atom+xml\" title=\"${feed.title}\" href=\"${baseUrl}${WEEKLY_DIGEST_FEED.path}\">`;"],
  ["a-change-type-the-catalogue-holds-is-published-as-its-key", "src/change-feed.ts",
    "  record_corrected: \"Record Corrected\",",
    "  record_corrected: \"record_corrected\","],
  ["a-week-is-named-by-the-month-it-starts-in", "src/change-dates.ts",
    "  const tail = startMonth === endMonth ? `${end.getUTCDate()}` : `${endMonth} ${end.getUTCDate()}`;",
    "  const tail = `${end.getUTCDate()}`;"],
  ["a-week-crossing-a-year-drops-one-of-them", "src/change-dates.ts",
    "  if (startYear !== endYear) {\n    return `${startMonth} ${start.getUTCDate()}, ${startYear}–${endMonth} ${end.getUTCDate()}, ${endYear}`;\n  }",
    "  if (false) {\n    return `${startMonth} ${start.getUTCDate()}, ${startYear}–${endMonth} ${end.getUTCDate()}, ${endYear}`;\n  }"],
  ["a-feed-alias-lands-on-a-page-instead-of-a-feed", "src/serve.ts",
    "  if ((url.pathname === \"/rss\" || url.pathname === \"/feed\" || url.pathname === \"/atom\") && isGetOrHead) {\n    res.writeHead(301, { Location: \"/feed.xml\" });",
    "  if ((url.pathname === \"/rss\" || url.pathname === \"/feed\" || url.pathname === \"/atom\") && isGetOrHead) {\n    res.writeHead(301, { Location: \"/pricing-changes\" });"],
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
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length - uncompiled.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
