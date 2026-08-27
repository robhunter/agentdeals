#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.." || exit 1

FILES=(scripts/change-log.js scripts/check-change-log-staleness.js scripts/backfill-change-date-sources.js scripts/validate-data.ts src/change-dates.ts src/data.ts src/serve.ts src/server.ts)
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do
  mkdir -p "$BACKUP/$(dirname "$f")"
  cp "$f" "$BACKUP/$f"
done

restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  npm run build > /dev/null 2>&1
}

killed=0
survived=0
SURVIVORS=()

mutate() {
  local label="$1"; local file="$2"; local from="$3"; local to="$4"
  restore
  if ! grep -qF -- "$from" "$file"; then
    echo "  SKIP (pattern absent): $label"
    return
  fi
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
open(path, "w").write(src.replace(frm, to, 1))
PY
  npm run build > /dev/null 2>&1
  if node --test --test-concurrency 1 test/change-date-provenance.test.ts test/change-log-writer.test.ts > /tmp/mutate-ac10-run.log 2>&1; then
    survived=$((survived + 1))
    SURVIVORS+=("$label")
    echo "  SURVIVED: $label"
  else
    killed=$((killed + 1))
    echo "  killed:   $label"
  fi
}

echo "── Mutating the writer's date provenance ──"
mutate "a discovery is labelled as if the vendor's page stated the date" \
  scripts/change-log.js "date_source: statedDate ? DATE_SOURCE_VENDOR_PAGE : DATE_SOURCE_DISCOVERED," \
  "date_source: DATE_SOURCE_VENDOR_PAGE,"
mutate "a page-stated date is labelled a discovery" \
  scripts/change-log.js "date_source: statedDate ? DATE_SOURCE_VENDOR_PAGE : DATE_SOURCE_DISCOVERED," \
  "date_source: DATE_SOURCE_DISCOVERED,"
mutate "the writer emits no provenance at all" \
  scripts/change-log.js "date_source: statedDate ? DATE_SOURCE_VENDOR_PAGE : DATE_SOURCE_DISCOVERED," \
  "date_source: undefined,"
mutate "a malformed page-stated date is kept as the effective date" \
  scripts/change-log.js "typeof result.effective_date === \"string\" && ISO_DATE.test(result.effective_date.trim())" \
  "typeof result.effective_date === \"string\" && result.effective_date.trim().length > 0"
mutate "the discovery falls back to a date that is not the run date" \
  scripts/change-log.js "date: statedDate ?? recordedDate," "date: statedDate ?? \"2026-01-01\","

echo "── Mutating the predicate that decides what may be presented as an event ──"
mutate "the script-side predicate admits a discovery as an event date" \
  scripts/change-log.js "export const EVENT_DATED_SOURCES = [DATE_SOURCE_VENDOR_PAGE, DATE_SOURCE_HAND_WRITTEN];" \
  "export const EVENT_DATED_SOURCES = [DATE_SOURCE_VENDOR_PAGE, DATE_SOURCE_HAND_WRITTEN, DATE_SOURCE_DISCOVERED];"
mutate "the server predicate admits a discovery as an event date" \
  src/data.ts "export const EVENT_DATED_SOURCES: ChangeDateSource[] = [\"vendor_page\", \"hand_written\"];" \
  "export const EVENT_DATED_SOURCES: ChangeDateSource[] = [\"vendor_page\", \"hand_written\", \"discovered\"];"
mutate "an absent provenance defaults to being an event date" \
  src/data.ts "return EVENT_DATED_SOURCES.includes(change.date_source as ChangeDateSource);" \
  "return change.date_source !== \"discovered\";"
mutate "the partition puts every entry on the dated side" \
  src/data.ts "for (const change of changes) (isEventDated(change) ? dated : discovered).push(change);" \
  "for (const change of changes) dated.push(change);"
mutate "the count of undateable entries is always zero" \
  src/data.ts "discovered_date_total: changes.filter((c) => !isEventDated(c)).length," \
  "discovered_date_total: 0,"
mutate "entries missing a provenance are not counted as missing" \
  src/data.ts "entries_without_date_source: changes.filter(" "entries_without_date_source: 0 * changes.filter("

echo "── Mutating the rendering helpers ──"
mutate "the discovery prefix is dropped from the rendered date" \
  src/change-dates.ts "return isEventDated(c) ? c.date : \`\${DISCOVERED_DATE_PREFIX} \${c.date}\`;" \
  "return c.date;"
mutate "a discovery date is published as datePublished in structured data" \
  src/change-dates.ts "return isEventDated(c) ? { datePublished: c.date } : {};" \
  "return { datePublished: c.date };"
mutate "the undated group heading stops naming what is missing" \
  src/change-dates.ts "return \`Effective date unknown (\${count} \${count === 1 ? \"change\" : \"changes\"})\`;" \
  "return \"Other changes\";"
mutate "the undated note stops saying they are excluded from the counts" \
  src/change-dates.ts "excluded from the monthly groups" "included in the monthly groups"

echo "── Mutating the change timeline ──"
mutate "/changes groups a discovery into a calendar month" \
  src/serve.ts "  const sorted = [...eventDated].sort((a, b) => b.date.localeCompare(a.date));
  const undatedSorted = [...undatedChanges].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month" \
  "  const sorted = [...allChanges].sort((a, b) => b.date.localeCompare(a.date));
  const undatedSorted = [...undatedChanges].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month"
mutate "/changes counts a discovery in Last 30 Days" \
  src/serve.ts "const last30DaysCount = eventDated.filter(c => c.date >= thirtyDaysAgo).length;" \
  "const last30DaysCount = allChanges.filter(c => c.date >= thirtyDaysAgo).length;"
mutate "/changes stops rendering the undated group at all" \
  src/serve.ts "\${changeLogFreshnessNote()}
\${undatedHtml}" "\${changeLogFreshnessNote()}"
mutate "/changes marks a discovery as an upcoming change" \
  src/serve.ts "    const isUpcoming = dated && c.date >= today;
    const altHtml = c.alternatives && c.alternatives.length > 0
      ? \`<div class=\"chg-alts\">" \
  "    const isUpcoming = c.date >= today;
    const altHtml = c.alternatives && c.alternatives.length > 0
      ? \`<div class=\"chg-alts\">"
mutate "/pricing-changes groups a discovery into a calendar month" \
  src/serve.ts "  const sorted = [...eventDated].sort((a, b) => b.date.localeCompare(a.date));
  const undatedSorted = [...undatedChanges].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month
  const byMonth = new Map<string, typeof sorted>();
  for (const c of sorted) {
    const monthKey = c.date.slice(0, 7);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey)!.push(c);
  }

  const monthNames = [\"January\", \"February\", \"March\", \"April\", \"May\", \"June\", \"July\", \"August\", \"September\", \"October\", \"November\", \"December\"];
  function formatMonth(key: string): string {
    const [y, m] = key.split(\"-\");
    return \`\${monthNames[parseInt(m, 10) - 1]} \${y}\`;
  }

  // Anchor ID for each change" \
  "  const sorted = [...allChanges].sort((a, b) => b.date.localeCompare(a.date));
  const undatedSorted: typeof sorted = [];

  // Group by month
  const byMonth = new Map<string, typeof sorted>();
  for (const c of sorted) {
    const monthKey = c.date.slice(0, 7);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey)!.push(c);
  }

  const monthNames = [\"January\", \"February\", \"March\", \"April\", \"May\", \"June\", \"July\", \"August\", \"September\", \"October\", \"November\", \"December\"];
  function formatMonth(key: string): string {
    const [y, m] = key.split(\"-\");
    return \`\${monthNames[parseInt(m, 10) - 1]} \${y}\`;
  }

  // Anchor ID for each change"
mutate "/expiring treats a discovery as an upcoming deadline" \
  src/serve.ts "const upcoming = eventDated.filter(c => c.date >= today)" "const upcoming = allChanges.filter(c => c.date >= today)"
mutate "/expiring counts a discovery as a recent change" \
  src/serve.ts "const recent = eventDated.filter(c => c.date < today && c.date >= thirtyDaysAgo)" \
  "const recent = allChanges.filter(c => c.date <= today && c.date >= thirtyDaysAgo)"

echo "── Mutating the monthly reports ──"
mutate "a discovery opens a month on /reports" \
  src/serve.ts "for (const c of allChanges) if (isEventDated(c)) months.add(c.date.slice(0, 7));" \
  "for (const c of allChanges) months.add(c.date.slice(0, 7));"
mutate "a discovery is counted inside a monthly report" \
  src/serve.ts "return changes.filter((c) => isEventDated(c) && c.date.startsWith(yearMonthPrefix));" \
  "return changes.filter((c) => c.date.startsWith(yearMonthPrefix));"

echo "── Mutating what agents are told ──"
mutate "the MCP digest drops the provenance and hands over a bare date" \
  src/server.ts "date_source: change.date_source, " ""
mutate "a discovery is published to agents as an upcoming deadline" \
  src/data.ts ".filter((c) => isEventDated(c) && c.date >= today && c.date <= thirtyDaysFromNow)" \
  ".filter((c) => c.date >= today && c.date <= thirtyDaysFromNow)"

echo "── Mutating the alarm's reading of the schedule ──"
mutate "the schedule always reads as scheduled" \
  scripts/check-change-log-staleness.js "return { known: true, scheduled: withAi.length > 0, reason: null };" \
  "return { known: true, scheduled: true, reason: null };"
mutate "the schedule always reads as not scheduled" \
  scripts/check-change-log-staleness.js "return { known: true, scheduled: withAi.length > 0, reason: null };" \
  "return { known: true, scheduled: false, reason: null };"
mutate "--ai is matched as a substring, so --ai-dry-run counts" \
  scripts/check-change-log-staleness.js "const withAi = invocations.filter((line) => /(^|\\s)--ai(\\s|\$)/.test(line));" \
  "const withAi = invocations.filter((line) => line.includes(\"--ai\"));"
mutate "a missing invocation is read as a decided answer" \
  scripts/check-change-log-staleness.js "return { known: false, scheduled: false, reason: \"no reverify-rolling.js invocation found\" };" \
  "return { known: true, scheduled: false, reason: null };"
mutate "a partially converted workflow is read as decided" \
  scripts/check-change-log-staleness.js "if (withAi.length > 0 && withAi.length < invocations.length) {" "if (false) {"

echo "── Mutating what the alarm gates on ──"
mutate "the gate reads the log's age instead of the detector's" \
  scripts/check-change-log-staleness.js "const days = freshness.days_since_last_detected;" \
  "const days = freshness.days_since_last_recorded;"
mutate "the alarm never fails the job" \
  scripts/check-change-log-staleness.js "return { failJob: stale, openAbsenceIssue: false, undecidable: false, text: lines.join(\"\\n\") };" \
  "return { failJob: false, openAbsenceIssue: false, undecidable: false, text: lines.join(\"\\n\") };"
mutate "a scheduled detector that never detected is treated as healthy" \
  scripts/check-change-log-staleness.js "const stale = days === null || days > thresholdDays;" \
  "const stale = days !== null && days > thresholdDays;"
mutate "the alarm fires one day early" \
  scripts/check-change-log-staleness.js "const stale = days === null || days > thresholdDays;" \
  "const stale = days === null || days >= thresholdDays;"
mutate "the threshold is loosened past the gap we already had" \
  scripts/check-change-log-staleness.js "export const DEFAULT_THRESHOLD_DAYS = 14;" \
  "export const DEFAULT_THRESHOLD_DAYS = 200;"
mutate "the unscheduled state fails the daily run instead of signalling once" \
  scripts/check-change-log-staleness.js "return { failJob: false, openAbsenceIssue: true, undecidable: false, text: lines.join(\"\\n\") };" \
  "return { failJob: true, openAbsenceIssue: false, undecidable: false, text: lines.join(\"\\n\") };"
mutate "the absence is never signalled" \
  scripts/check-change-log-staleness.js "return { failJob: false, openAbsenceIssue: true, undecidable: false, text: lines.join(\"\\n\") };" \
  "return { failJob: false, openAbsenceIssue: false, undecidable: false, text: lines.join(\"\\n\") };"
mutate "the alarm stops saying a hand-written entry cannot clear it" \
  scripts/check-change-log-staleness.js "\"A hand-written entry does not clear this: the gate reads days_since_last_detected, not days_since_last_recorded.\"" \
  "\"\""

echo "── Mutating the backfill and the data gate ──"
mutate "the backfill claims a machine-written entry was hand-written" \
  scripts/backfill-change-date-sources.js "(c) => !c.detected_by && !DATE_SOURCES.includes(c.date_source)" \
  "(c) => !DATE_SOURCES.includes(c.date_source)"
mutate "the backfill relabels an entry that already carries a provenance" \
  scripts/backfill-change-date-sources.js "const alreadyLabelled = changes.filter((c) => DATE_SOURCES.includes(c.date_source));" \
  "const alreadyLabelled = [];"
mutate "a published entry may carry no provenance" \
  scripts/validate-data.ts "  \"alternatives\",
  \"date_source\"," "  \"alternatives\","

restore
rm -rf "$BACKUP"

echo ""
echo "── ${killed} killed, ${survived} survived ──"
for s in "${SURVIVORS[@]:-}"; do [ -n "$s" ] && echo "  SURVIVOR: $s"; done
exit 0
