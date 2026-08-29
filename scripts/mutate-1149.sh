#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

DATES="src/change-dates.ts"
DATA="src/data.ts"
SERVE="src/serve.ts"
CORRECTIONS="src/feed-corrections.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$DATES" "$BACKUP_DIR/change-dates.ts"
cp "$DATA" "$BACKUP_DIR/data.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$CORRECTIONS" "$BACKUP_DIR/feed-corrections.ts"

restore() {
  cp "$BACKUP_DIR/change-dates.ts" "$DATES"
  cp "$BACKUP_DIR/data.ts" "$DATA"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/feed-corrections.ts" "$CORRECTIONS"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/weekly-window-provenance.test.ts test/weekly-digest.test.ts test/weekly-digest-formatted.test.ts test/change-date-provenance.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/change-dates.ts" "$DATES" > /dev/null \
    && diff -q "$BACKUP_DIR/data.ts" "$DATA" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/feed-corrections.ts" "$CORRECTIONS" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1149-build.log 2>&1; then
    echo "    KILLED (does not compile)"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1149-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1149-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1149-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_a_window_has_no_end() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  return date >= window.start && (window.end === undefined || date <= window.end);',
              '  return date >= window.start;')
open(p, "w").write(s)
PY
}

m_a_window_excludes_its_last_day() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  return date >= window.start && (window.end === undefined || date <= window.end);',
              '  return date >= window.start && (window.end === undefined || date < window.end);')
open(p, "w").write(s)
PY
}

m_a_window_excludes_its_first_day() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  return date >= window.start && (window.end === undefined || date <= window.end);',
              '  return date > window.start && (window.end === undefined || date <= window.end);')
open(p, "w").write(s)
PY
}

m_every_record_in_the_window_is_a_dated_change() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  return partitionByDateProvenance(changes.filter((c) => withinWindow(c.date, window)));',
              '  return { dated: changes.filter((c) => withinWindow(c.date, window)), discovered: [] };')
open(p, "w").write(s)
PY
}

m_the_week_starts_on_the_day_it_is_handed() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;',
              '  const mondayOffset = 0;')
open(p, "w").write(s)
PY
}

m_sunday_belongs_to_the_week_that_follows_it() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;',
              '  const mondayOffset = 1 - dayOfWeek;')
open(p, "w").write(s)
PY
}

m_a_discovery_batch_is_described_as_changes() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  const pages = `${count} pricing page${count === 1 ? "" : "s"}`;',
              '  const pages = `${count} pricing change${count === 1 ? "" : "s"}`;')
open(p, "w").write(s)
PY
}

m_the_note_names_the_window_once() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('so ${subject} dated by discovery and ${verb} not counted as ${object} effect ${when}.`;',
              'so ${subject} dated by discovery.`;')
open(p, "w").write(s)
PY
}

m_the_first_read_heading_hides_its_count() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace('  return `Pages read for the first time (${count})`;',
              '  return `Pages read for the first time`;')
open(p, "w").write(s)
PY
}

m_the_weekly_summary_counts_the_discovery_batch() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  const { dated: weekChanges, discovered: weekDiscovered } = changesInWindow(allChanges, week);',
              '  const inWeek = changesInWindow(allChanges, week);\n'
              '  const weekDiscovered = inWeek.discovered;\n'
              '  const weekChanges = [...inWeek.dated, ...inWeek.discovered];')
open(p, "w").write(s)
PY
}

m_the_weekly_top_changes_include_the_discovery_batch() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  const sorted = [...weekChanges].sort((a, b) => scoreChange(b) - scoreChange(a));\n'
              '  const topChanges = sorted.slice(0, limit);',
              '  const sorted = [...weekChanges, ...weekDiscovered].sort((a, b) => scoreChange(b) - scoreChange(a));\n'
              '  const topChanges = sorted.slice(0, limit);')
open(p, "w").write(s)
PY
}

m_one_change_is_reported_as_changes() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('    ? `${headlineParts.join(", ")} across ${weekChanges.length} developer tool pricing change${weekChanges.length !== 1 ? "s" : ""}`',
              '    ? `${headlineParts.join(", ")} across ${weekChanges.length} developer tool pricing changes`')
open(p, "w").write(s)
PY
}

m_a_week_with_no_discovery_batch_still_gets_the_note() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  const discoveryNote = weekDiscovered.length > 0 ? discoveryBatchNote(weekDiscovered.length, `during ${dateLabel}`) : "";',
              '  const discoveryNote = discoveryBatchNote(weekDiscovered.length, `during ${dateLabel}`);')
open(p, "w").write(s)
PY
}

m_the_digest_returns_the_discovery_batch_as_changes() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  const changes = [...changesInWindow(allDealChanges, changeWindow).dated].sort((a, b) =>\n'
              '    b.date.localeCompare(a.date)\n'
              '  );',
              '  const inChangeWindow = changesInWindow(allDealChanges, changeWindow);\n'
              '  const changes = [...inChangeWindow.dated, ...inChangeWindow.discovered].sort((a, b) =>\n'
              '    b.date.localeCompare(a.date)\n'
              '  );')
open(p, "w").write(s)
PY
}

m_the_digest_names_the_week_whatever_range_it_returns() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('    date_range: `${changeWindow.start} to ${changeWindow.end}`,',
              '    date_range: week,')
open(p, "w").write(s)
PY
}

m_the_digest_window_has_no_upper_bound() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  const changeWindow: DateWindow = usedFallback\n'
              '    ? { start: thirtyDaysAgo, end: today }\n'
              '    : weekWindow;',
              '  const changeWindow: DateWindow = usedFallback\n'
              '    ? { start: thirtyDaysAgo }\n'
              '    : { start: weekWindow.start };')
open(p, "w").write(s)
PY
}

m_a_deadline_more_than_thirty_days_out_is_dropped() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('    .filter((c) => isEventDated(c) && c.date >= today)',
              '    .filter((c) => isEventDated(c) && c.date >= today && c.date <= fmt(new Date(now.getTime() + 30 * 86400000)))')
open(p, "w").write(s)
PY
}

m_the_summary_drops_the_effective_date_qualifier() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('pricing change${changes.length !== 1 ? "s" : ""} with a known effective date tracked',
              'pricing change${changes.length !== 1 ? "s" : ""} tracked')
open(p, "w").write(s)
PY
}

m_the_archived_week_counts_every_record_it_holds() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const { dated: changes, discovered } = partitionByDateProvenance(weekRecords);',
              '  const changes = weekRecords;\n'
              '  const { discovered } = partitionByDateProvenance(weekRecords);')
open(p, "w").write(s)
PY
}

m_the_archive_index_counts_every_record_it_holds() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('    return `<li><a href="/digest/${key}"><span class="week-label">${dateRange}</span><span class="week-count">${dated.length} change${dated.length !== 1 ? "s" : ""}${firstRead}</span></a></li>`;',
              '    return `<li><a href="/digest/${key}"><span class="week-label">${dateRange}</span><span class="week-count">${records.length} change${records.length !== 1 ? "s" : ""}</span></a></li>`;')
open(p, "w").write(s)
PY
}

m_this_week_never_shows_what_it_first_read() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const contentHtml = [changesHtml, firstReadHtml].filter(Boolean).join("\\n");',
              '  const contentHtml = changesHtml;')
open(p, "w").write(s)
PY
}

m_the_archived_week_never_shows_what_it_first_read() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const bodyHtml = [changesHtml, firstReadHtml].filter(Boolean).join("\\n");',
              '  const bodyHtml = changesHtml;')
open(p, "w").write(s)
PY
}

m_the_feed_drops_its_corrections() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('${[...corrections, ...weekEntries].join("\\n")}',
              '${weekEntries.join("\\n")}')
open(p, "w").write(s)
PY
}

m_a_correction_reuses_the_weekly_entry_id() {
  py <<'PY'
p = "src/feed-corrections.ts"
s = open(p).read()
s = s.replace('    id: "urn:agentdeals:correction:2026-08-29:weekly-digest-2026-08-24",',
              '    id: "urn:agentdeals:weekly-digest:2026-08-24",')
open(p, "w").write(s)
PY
}

m_a_correction_does_not_quote_what_it_corrects() {
  py <<'PY'
p = "src/feed-corrections.ts"
s = open(p).read()
s = s.replace('29 pricing restructures across 154 developer tool pricing changes</em>. That count was wrong, and this entry replaces it.</p>"',
              '29 pricing restructures</em>. That count was wrong, and this entry replaces it.</p>"')
open(p, "w").write(s)
PY
}

m_the_api_calls_every_record_event_dated() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('      const { dated, discovered } = partitionByDateProvenance(result.changes);',
              '      const dated = result.changes;\n'
              '      const discovered: typeof result.changes = [];')
open(p, "w").write(s)
PY
}

run_mutation "a window has no end" m_a_window_has_no_end
run_mutation "a window excludes its last day" m_a_window_excludes_its_last_day
run_mutation "a window excludes its first day" m_a_window_excludes_its_first_day
run_mutation "every record in the window is a dated change" m_every_record_in_the_window_is_a_dated_change
run_mutation "the week starts on the day it is handed" m_the_week_starts_on_the_day_it_is_handed
run_mutation "Sunday belongs to the week that follows it" m_sunday_belongs_to_the_week_that_follows_it
run_mutation "a discovery batch is described as changes" m_a_discovery_batch_is_described_as_changes
run_mutation "the note names the window once" m_the_note_names_the_window_once
run_mutation "the first-read heading hides its count" m_the_first_read_heading_hides_its_count
run_mutation "the weekly summary counts the discovery batch" m_the_weekly_summary_counts_the_discovery_batch
run_mutation "the weekly top changes include the discovery batch" m_the_weekly_top_changes_include_the_discovery_batch
run_mutation "one change is reported as changes" m_one_change_is_reported_as_changes
run_mutation "a week with no discovery batch still gets the note" m_a_week_with_no_discovery_batch_still_gets_the_note
run_mutation "the digest returns the discovery batch as changes" m_the_digest_returns_the_discovery_batch_as_changes
run_mutation "the digest names the week whatever range it returns" m_the_digest_names_the_week_whatever_range_it_returns
run_mutation "the digest window has no upper bound" m_the_digest_window_has_no_upper_bound
run_mutation "a deadline more than thirty days out is dropped" m_a_deadline_more_than_thirty_days_out_is_dropped
run_mutation "the summary drops the effective-date qualifier" m_the_summary_drops_the_effective_date_qualifier
run_mutation "the archived week counts every record it holds" m_the_archived_week_counts_every_record_it_holds
run_mutation "the archive index counts every record it holds" m_the_archive_index_counts_every_record_it_holds
run_mutation "this week never shows what it first read" m_this_week_never_shows_what_it_first_read
run_mutation "the archived week never shows what it first read" m_the_archived_week_never_shows_what_it_first_read
run_mutation "the feed drops its corrections" m_the_feed_drops_its_corrections
run_mutation "a correction reuses the weekly entry id" m_a_correction_reuses_the_weekly_entry_id
run_mutation "a correction does not quote what it corrects" m_a_correction_does_not_quote_what_it_corrects
run_mutation "the api calls every record event-dated" m_the_api_calls_every_record_event_dated

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
