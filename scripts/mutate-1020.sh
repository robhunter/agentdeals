#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

STATE="scripts/verification-state.js"
ROLLING="scripts/reverify-rolling.js"
SURFACE="src/verification-state.ts"
BACKUP_DIR="$(mktemp -d)"
for f in "$STATE" "$ROLLING" "$SURFACE"; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in "$STATE" "$ROLLING" "$SURFACE"; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
}
trap restore EXIT

killed=0
survived=0
TESTS="test/verification-state.test.ts test/reverify-rolling.test.ts test/verification-quarantine-surface.test.ts test/change-gate.test.ts test/change-log-writer.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$STATE" "$ROLLING" "$SURFACE"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1020-build.log 2>&1; then
    echo "    KILLED BY THE COMPILER: $(head -1 /tmp/mutate-1020-build.log)"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1020-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1020-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1020-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_a_change_counts_as_a_failure() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("""export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_CONFIRMED,
  ATTEMPT_CHANGED,
  ATTEMPT_LINK_OK,
]);""", """export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_CONFIRMED,
  ATTEMPT_LINK_OK,
]);""")
open(p, "w").write(s)
PY
}

m_an_unclear_verdict_counts_as_an_answer() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("  ATTEMPT_LINK_OK,\n]);", "  ATTEMPT_LINK_OK,\n  ATTEMPT_UNCLEAR,\n]);")
open(p, "w").write(s)
PY
}

m_quarantine_needs_one_more_failure() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("export const QUARANTINE_AFTER_FAILURES = 3;", "export const QUARANTINE_AFTER_FAILURES = 4;")
open(p, "w").write(s)
PY
}

m_a_failure_never_resets() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("  const failures = answered ? 0 : (base.consecutive_failures ?? 0) + 1;",
              "  const failures = (base.consecutive_failures ?? 0) + (answered ? 0 : 1);")
open(p, "w").write(s)
PY
}

m_a_success_never_releases_the_record() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    quarantined_since: quarantined ? (base.quarantined_since ?? attempt.date) : null,",
              "    quarantined_since: base.quarantined_since ?? (quarantined ? attempt.date : null),")
open(p, "w").write(s)
PY
}

m_a_change_advances_the_last_confirmation() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    last_success: attempt.outcome === ATTEMPT_CONFIRMED ? attempt.date : (base.last_success ?? null),",
              "    last_success: ANSWERED_OUTCOMES.has(attempt.outcome) ? attempt.date : (base.last_success ?? null),")
open(p, "w").write(s)
PY
}

m_the_attempt_date_is_not_written() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    last_attempt_at: attempt.date,", "    last_attempt_at: base.last_attempt_at,")
open(p, "w").write(s)
PY
}

m_the_backoff_is_a_day() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("export const QUARANTINE_RETRY_DAYS = 7;", "export const QUARANTINE_RETRY_DAYS = 1;")
open(p, "w").write(s)
PY
}

m_a_retry_is_due_the_moment_it_is_quarantined() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("  return shiftIsoDays(record.last_attempt_at, QUARANTINE_RETRY_DAYS);",
              "  return record.last_attempt_at;")
open(p, "w").write(s)
PY
}

m_being_refused_reads_as_a_dead_destination() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    if (code === 401 || code === 403 || code === 429) return FAILURE_BOT_BLOCK;",
              "    if (code === 401 || code === 403 || code === 429) return FAILURE_UNREACHABLE;")
open(p, "w").write(s)
PY
}

m_a_transient_dns_failure_reads_as_a_dead_host() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace('  if (/ENOTFOUND/.test(text)) return FAILURE_UNREACHABLE;\n  return FAILURE_NETWORK;',
              '  return FAILURE_UNREACHABLE;')
open(p, "w").write(s)
PY
}

m_the_liveness_detail_format_is_not_read() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace('  const status = text.match(/\\b(?:HTTP|GET|HEAD|POST)\\s+(\\d{3})\\b/i);',
              '  const status = text.match(/\\bHTTP\\s+(\\d{3})\\b/);')
open(p, "w").write(s)
PY
}

m_every_seeded_record_starts_quarantined() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("  if (!link || link.outcome === \"reachable\") return 1;",
              "  if (!link || link.outcome === \"reachable\") return QUARANTINE_AFTER_FAILURES;")
open(p, "w").write(s)
PY
}

m_the_backfill_invents_history_it_has_no_evidence_for() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("  return Math.max(observed, Math.min(dailyChecksFailed, QUARANTINE_AFTER_FAILURES));",
              "  return Math.max(observed, QUARANTINE_AFTER_FAILURES);")
open(p, "w").write(s)
PY
}

m_the_backfill_overwrites_what_the_job_recorded() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    if (state.has(key)) continue;\n    const check = offer?.source_check;",
              "    const check = offer?.source_check;")
open(p, "w").write(s)
PY
}

m_a_readable_source_is_seeded_as_a_failure() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    if (!check || check.outcome === SOURCE_CHECK_OK) continue;", "    if (!check) continue;")
open(p, "w").write(s)
PY
}

m_state_for_a_removed_offer_is_kept_forever() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    if (live.has(key)) kept.set(key, record);", "    kept.set(key, record);")
open(p, "w").write(s)
PY
}

m_the_written_file_is_not_sorted() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("""  const records = [...state.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, record]) => record);""",
              """  const records = [...state.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, record]) => record);""")
open(p, "w").write(s)
PY
}

m_a_dry_run_writes_the_state_anyway() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("  if (options.dryRun) return { path, records };\n  writeFileSync(path, JSON.stringify({ generated_at: isoDay(now), records }, null, 2)",
              "  writeFileSync(path, JSON.stringify({ generated_at: isoDay(now), records }, null, 2)")
open(p, "w").write(s)
PY
}

m_a_record_still_failing_is_left_off_the_list() {
  py <<'PY'
p = "scripts/verification-state.js"
s = open(p).read()
s = s.replace("    if ((record.consecutive_failures ?? 0) < 1) continue;\n    const category = record.failure_category;",
              "    if ((record.consecutive_failures ?? 0) < 99) continue;\n    const category = record.failure_category;")
open(p, "w").write(s)
PY
}

m_the_queue_ignores_the_attempt_stamp() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  const dates = [offer?.verifiedDate, held, refusedOn, verificationRecord?.last_attempt_at].filter(Boolean);",
              "  const dates = [offer?.verifiedDate, held, refusedOn].filter(Boolean);")
open(p, "w").write(s)
PY
}

m_the_run_never_hands_its_state_to_the_selection() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  const state = options.verificationState ?? new Map();", "  const state = new Map();")
open(p, "w").write(s)
PY
}

m_a_quarantined_record_stays_in_the_daily_pick() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  const active = entries.filter((entry) => !isQuarantined(entry.record)).sort(byAge);",
              "  const active = entries.slice().sort(byAge);")
open(p, "w").write(s)
PY
}

m_due_retries_take_the_whole_budget() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  return Math.max(1, Math.round(limit * QUARANTINE_RETRY_SHARE));", "  return limit;")
open(p, "w").write(s)
PY
}

m_spare_slots_are_left_empty() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  const extraRetries = spare > 0 ? dueRetries.slice(retries.length, retries.length + spare) : [];",
              "  const extraRetries = [];")
open(p, "w").write(s)
PY
}

m_the_backoff_is_ignored_when_picking() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    .filter((entry) => isQuarantined(entry.record) && quarantineRetryDue(entry.record, today))",
              "    .filter((entry) => isQuarantined(entry.record))")
open(p, "w").write(s)
PY
}

m_a_changed_verdict_leaves_no_attempt() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    } else if (result.status === \"changed\") {\n      recorder.note(offer, ATTEMPT_CHANGED);\n",
              "    } else if (result.status === \"changed\") {\n")
open(p, "w").write(s)
PY
}

m_an_unreadable_page_leaves_no_attempt() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("      recorder.note(offer, ATTEMPT_FETCH_FAILED, page.error, classifyFetchError(page.error));\n", "")
open(p, "w").write(s)
PY
}

m_a_verifier_crash_leaves_no_attempt() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("      recorder.note(offer, ATTEMPT_AI_ERROR, err.message, FAILURE_AI_EXTRACTION);\n", "")
open(p, "w").write(s)
PY
}

m_an_unusable_source_is_recorded_as_a_clean_check() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    if (!sourceOk) {\n      recorder.note(offer, ATTEMPT_SOURCE_UNUSABLE, check.detail, FAILURE_SOURCE_UNUSABLE);\n    } else if (result.status === \"confirmed\") {",
              "    if (result.status === \"confirmed\") {")
open(p, "w").write(s)
PY
}

m_url_mode_records_nothing() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("      recorder.note(f, ATTEMPT_FETCH_FAILED, f.error, classifyFetchError(f.error));\n", "")
open(p, "w").write(s)
PY
}

m_the_repick_count_compares_the_wrong_day() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  const checked = new Set(picked.map(({ offer }) => offerKey(offer?.vendor, offer?.url)));\n  return next.filter(({ offer }) => checked.has(offerKey(offer?.vendor, offer?.url))).length;",
              "  return next.length - picked.length;")
open(p, "w").write(s)
PY
}

m_the_summary_hides_the_repick_count() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    lines.push(`Checked again on the next run: ${repicked} of ${checked}`);",
              "    lines.push(`Checked again on the next run: not measured`);")
open(p, "w").write(s)
PY
}

m_the_summary_collapses_entering_and_leaving() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    `Left quarantine (checked successfully): ${quarantine.left}`,",
              "    `Left quarantine (checked successfully): ${quarantine.entered}`,")
open(p, "w").write(s)
PY
}

m_the_ledger_takes_whichever_url_came_first() {
  py <<'PY'
p = "src/verification-state.ts"
s = open(p).read()
s = s.replace("    if (held && held.consecutive_failures >= record.consecutive_failures) continue;",
              "    if (held) continue;")
open(p, "w").write(s)
PY
}

m_the_ledger_includes_records_that_are_fine() {
  py <<'PY'
p = "src/verification-state.ts"
s = open(p).read()
s = s.replace("    if ((record.consecutive_failures ?? 0) < 1) continue;\n    const key = record.vendor.toLowerCase();",
              "    const key = record.vendor.toLowerCase();")
open(p, "w").write(s)
PY
}

m_the_quarantine_list_includes_everything() {
  py <<'PY'
p = "src/verification-state.ts"
s = open(p).read()
s = s.replace("    if (!isQuarantined(record)) continue;\n    const reason", "    const reason")
open(p, "w").write(s)
PY
}

m_the_quarantine_list_is_truncated() {
  py <<'PY'
p = "src/verification-state.ts"
s = open(p).read()
s = s.replace("    entries,\n  };", "    entries: entries.slice(0, 2),\n  };")
open(p, "w").write(s)
PY
}

run_mutation "a check that found a change counts as a failure" m_a_change_counts_as_a_failure
run_mutation "a verdict the model could not reach counts as an answer" m_an_unclear_verdict_counts_as_an_answer
run_mutation "quarantine waits for a fourth failure" m_quarantine_needs_one_more_failure
run_mutation "a successful check does not reset the failure count" m_a_failure_never_resets
run_mutation "a successful check does not release the record" m_a_success_never_releases_the_record
run_mutation "finding a change counts as confirming the record" m_a_change_advances_the_last_confirmation
run_mutation "the attempt date is never advanced" m_the_attempt_date_is_not_written
run_mutation "the backoff is a single day" m_the_backoff_is_a_day
run_mutation "a retry is due the day it is quarantined" m_a_retry_is_due_the_moment_it_is_quarantined
run_mutation "being refused is recorded as the destination being gone" m_being_refused_reads_as_a_dead_destination
run_mutation "a transient DNS failure is recorded as a dead host" m_a_transient_dns_failure_reads_as_a_dead_host
run_mutation "the liveness job's own detail format is not read" m_the_liveness_detail_format_is_not_read
run_mutation "every seeded record starts in quarantine" m_every_seeded_record_starts_quarantined
run_mutation "the backfill asserts failures it has no evidence for" m_the_backfill_invents_history_it_has_no_evidence_for
run_mutation "the backfill overwrites what the job recorded" m_the_backfill_overwrites_what_the_job_recorded
run_mutation "a source we could read is seeded as a failure" m_a_readable_source_is_seeded_as_a_failure
run_mutation "state for a removed offer is kept forever" m_state_for_a_removed_offer_is_kept_forever
run_mutation "the written file is not sorted" m_the_written_file_is_not_sorted
run_mutation "a dry run writes the state anyway" m_a_dry_run_writes_the_state_anyway
run_mutation "a record still failing is left off the reason counts" m_a_record_still_failing_is_left_off_the_list
run_mutation "the queue ignores the attempt stamp" m_the_queue_ignores_the_attempt_stamp
run_mutation "the run never hands its state to the selection" m_the_run_never_hands_its_state_to_the_selection
run_mutation "a quarantined record stays in the daily pick" m_a_quarantined_record_stays_in_the_daily_pick
run_mutation "due retries take the whole budget" m_due_retries_take_the_whole_budget
run_mutation "spare slots are left empty" m_spare_slots_are_left_empty
run_mutation "the backoff is ignored when picking" m_the_backoff_is_ignored_when_picking
run_mutation "a changed verdict leaves no attempt behind" m_a_changed_verdict_leaves_no_attempt
run_mutation "an unreadable page leaves no attempt behind" m_an_unreadable_page_leaves_no_attempt
run_mutation "a verifier crash leaves no attempt behind" m_a_verifier_crash_leaves_no_attempt
run_mutation "an unusable source is recorded as a clean check" m_an_unusable_source_is_recorded_as_a_clean_check
run_mutation "URL mode records no failure" m_url_mode_records_nothing
run_mutation "the repick count compares the wrong thing" m_the_repick_count_compares_the_wrong_day
run_mutation "the summary hides the repick count" m_the_summary_hides_the_repick_count
run_mutation "the summary reports entering as leaving" m_the_summary_collapses_entering_and_leaving
run_mutation "the ledger takes whichever URL came first" m_the_ledger_takes_whichever_url_came_first
run_mutation "the ledger includes records that are fine" m_the_ledger_includes_records_that_are_fine
run_mutation "the quarantine list includes records that are not held" m_the_quarantine_list_includes_everything
run_mutation "the quarantine list is silently truncated" m_the_quarantine_list_is_truncated

restore
npx tsc > /dev/null 2>&1
echo ""
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
