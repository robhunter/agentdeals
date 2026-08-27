#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.." || exit 1

FILES=(scripts/change-log.js scripts/reverify-rolling.js scripts/check-change-log-staleness.js scripts/backfill-change-recorded-dates.js src/data.ts src/serve.ts)
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
  if node --test --test-concurrency 1 test/change-log-writer.test.ts > /tmp/mutate-1074-run.log 2>&1; then
    survived=$((survived + 1))
    SURVIVORS+=("$label")
    echo "  SURVIVED: $label"
  else
    killed=$((killed + 1))
    echo "  killed:   $label"
  fi
}

echo "── Mutating the change-log writer ──"

mutate "entry takes previous_state from the page reading instead of our record" \
  scripts/change-log.js "previous_state: offer.description," "previous_state: currentState,"
mutate "entry takes current_state from our own record instead of the page" \
  scripts/change-log.js "current_state: currentState," "current_state: offer.description,"
mutate "entry is not marked as machine-written" \
  scripts/change-log.js "detected_by: options.detectedBy ?? DETECTED_BY_AI," "detected_by: undefined,"
mutate "entry does not say when it was recorded" \
  scripts/change-log.js "recorded_date: recordedDate," "recorded_date: undefined,"
mutate "recorded date is used as the change date even when the page gives one" \
  scripts/change-log.js "? result.effective_date.trim()" "? recordedDate"
mutate "an unknown change type is written anyway" \
  scripts/change-log.js "if (!CHANGE_TYPES.includes(changeType)) missing.push(\"change_type\");" "if (false) missing.push(\"change_type\");"
mutate "a detection with no current state is written anyway" \
  scripts/change-log.js "if (!currentState) missing.push(\"current_state\");" "if (false) missing.push(\"current_state\");"
mutate "a detection with no summary is written anyway" \
  scripts/change-log.js "if (!summary) missing.push(\"summary\");" "if (false) missing.push(\"summary\");"
mutate "only the first missing field is reported" \
  scripts/change-log.js "if (missing.length > 0) return { entry: null, missing };" "if (missing.length > 0) return { entry: null, missing: missing.slice(0, 1) };"
mutate "dedup by exact key is dropped" \
  scripts/change-log.js "if (keys.has(key)) {" "if (false) {"
mutate "dedup inside the re-pick window is dropped" \
  scripts/change-log.js "if (lastStamp && daysBetween(lastStamp, candidate.recorded_date) < windowDays) {" "if (false) {"
mutate "the re-pick window swallows every later change of the same kind" \
  scripts/change-log.js "const windowDays = options.windowDays ?? DEFAULT_REPICK_WINDOW_DAYS;" "const windowDays = 100000;"
mutate "a candidate does not block its own duplicate inside one batch" \
  scripts/change-log.js "keys.add(key);" "void key;"
mutate "the exact-key guard is dropped while the window guard stays" \
  scripts/change-log.js "if (keys.has(key)) {
      suppressed.push({ candidate, reason: \"already_recorded\" });
      continue;
    }" "if (false) {
      suppressed.push({ candidate, reason: \"already_recorded\" });
      continue;
    }"
mutate "a dry run writes to disk anyway" \
  scripts/change-log.js "if (fresh.length > 0 && !options.dryRun) {" "if (fresh.length > 0) {"
mutate "freshness reads the change date instead of the date we recorded it" \
  scripts/change-log.js "const recorded = changes.map((c) => c.recorded_date).filter(Boolean).sort();" "const recorded = changes.map((c) => c.date).filter(Boolean).sort();"
mutate "freshness reports the oldest recording instead of the newest" \
  scripts/change-log.js "const last = recorded.length > 0 ? recorded[recorded.length - 1] : null;" "const last = recorded.length > 0 ? recorded[0] : null;"
mutate "a log with no recorded dates reports an age of zero" \
  scripts/change-log.js "days_since_last_recorded: last === null ? null : Math.max(0, daysBetween(last, today))," "days_since_last_recorded: last === null ? 0 : Math.max(0, daysBetween(last, today)),"
mutate "machine-written entries are counted as hand-written" \
  scripts/change-log.js "machine_detected_total: changes.filter((c) => c.detected_by).length," "machine_detected_total: 0,"

echo "── Mutating the mode that cannot detect ──"
mutate "URL mode reports a change" \
  scripts/reverify-rolling.js "return { verified, flagged, changed: 0, changes: [], recorded: [], suppressed: [], unclassified: [] };" \
  "return { verified, flagged, changed: 1, changes: [{}], recorded: [{}], suppressed: [], unclassified: [] };"
mutate "URL mode drops the statement that it cannot detect" \
  scripts/reverify-rolling.js "lines.push(\"Change detection: not run. URL mode compares nothing and cannot report a change.\");" "lines.push(\"\");"
mutate "URL mode prints a change count as if it were a measurement" \
  scripts/reverify-rolling.js "lines.push(\"Change detection: not run. URL mode compares nothing and cannot report a change.\");" "lines.push(\`Changed (PM review needed): \${result.changed}\`);"
mutate "AI mode stamps a record whose terms it found had moved" \
  scripts/reverify-rolling.js "} else if (result.status === \"changed\") {" "} else if (result.status === \"changed\" && (data.offers[index].verifiedDate = staggeredDate(now))) {"
mutate "AI mode does not write what it detected" \
  scripts/reverify-rolling.js "const { appended, suppressed } = appendFn(changes, {" "const { appended, suppressed } = appendFn([], {"
mutate "AI mode counts an unclassifiable detection as nothing" \
  scripts/reverify-rolling.js "unclassified.push({ vendor: offer.vendor, url: offer.url, missing, summary: result.summary });" "void missing;"
mutate "the re-pick window is switched off" \
  scripts/reverify-rolling.js "return Math.max(1, Math.ceil(total / batchSize));" "return 0;"
mutate "the re-pick window ignores how big the catalogue is" \
  scripts/reverify-rolling.js "return Math.max(1, Math.ceil(total / batchSize));" "return 1;"

echo "── Mutating the alarm ──"
mutate "the alarm fires one day early" \
  scripts/check-change-log-staleness.js "const stale = days === null || days > thresholdDays;" "const stale = days === null || days >= thresholdDays;"
mutate "the alarm never fires" \
  scripts/check-change-log-staleness.js "const stale = days === null || days > thresholdDays;" "const stale = false;"
mutate "an unmeasurable age is treated as healthy" \
  scripts/check-change-log-staleness.js "const stale = days === null || days > thresholdDays;" "const stale = days !== null && days > thresholdDays;"
mutate "the threshold is loosened past the gap we already had" \
  scripts/check-change-log-staleness.js "export const DEFAULT_THRESHOLD_DAYS = 14;" "export const DEFAULT_THRESHOLD_DAYS = 200;"
mutate "the alarm stops saying the daily job cannot clear it" \
  scripts/check-change-log-staleness.js "\"The daily job runs URL mode, which cannot detect a change. Nothing else writes to this log.\"" "\"\""

echo "── Mutating the backfill ──"
mutate "the backfill dates an entry from the last commit that held it" \
  scripts/backfill-change-recorded-dates.js "if (!firstSeen.has(key)) firstSeen.set(key, date);" "firstSeen.set(key, date);"

echo "── Mutating the published surfaces ──"
mutate "the age is dropped from /api/changes" \
  src/serve.ts "res.end(JSON.stringify({ ...result, all_time_total: allTimeTotal, change_log_freshness: changeLogFreshness }));" \
  "res.end(JSON.stringify({ ...result, all_time_total: allTimeTotal }));"
mutate "the age is dropped from the personalized /api/changes" \
  src/serve.ts "res.end(JSON.stringify({ ...result, change_log_freshness: changeLogFreshness }));" "res.end(JSON.stringify(result));"
mutate "the age is dropped from /api/metrics" \
  src/serve.ts "change_log_freshness: getChangeLogFreshness()," "//"
mutate "the freshness line is dropped from the change timeline" \
  src/serve.ts "\${changeLogFreshnessNote()}
\${monthsHtml}" "\${monthsHtml}"
mutate "the freshness line is dropped from the expiring page" \
  src/serve.ts "\${changeLogFreshnessNote()}
\${totalUpcoming > 0" "\${totalUpcoming > 0"
mutate "the server disagrees with the writer about the log's age" \
  src/data.ts "const recorded = changes.map((c) => c.recorded_date).filter((d): d is string => !!d).sort();" \
  "const recorded = changes.map((c) => c.date).filter((d): d is string => !!d).sort();"

restore
rm -rf "$BACKUP"

echo ""
echo "── ${killed} killed, ${survived} survived ──"
for s in "${SURVIVORS[@]:-}"; do [ -n "$s" ] && echo "  SURVIVOR: $s"; done
exit 0
