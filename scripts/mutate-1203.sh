#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

LOG="scripts/change-log.js"
REFUSALS="scripts/change-refusals.js"
ROLLING="scripts/reverify-rolling.js"
FILES=("$LOG" "$REFUSALS" "$ROLLING")
BACKUP_DIR="$(mktemp -d)"
for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "${FILES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
}
trap 'restore' EXIT

killed=0
survived=0
TESTS="test/change-log-writer.test.ts test/change-refusals.test.ts test/reverify-rolling.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "${FILES[@]}"; do
    if ! diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null; then
      return 0
    fi
  done
  return 1
}

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1203-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1203-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1203-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_no_baseline_check() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace("""    const baseline = baselineKey(candidate);
    if (baseline && baselines.has(baseline)) {
      suppressed.push({
        candidate,
        reason: SUPPRESSED_SAME_TRANSITION_REGRADED,
        collidedWith: baselines.get(baseline),
      });
      continue;
    }
""", "    const baseline = baselineKey(candidate);\n")
open(p, "w").write(s)
PY
}

m_baseline_ignores_previous_state() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace('  return [change.vendor, change.date, change.source_url, previous].join("|");',
              '  return [change.vendor, change.date, change.source_url].join("|");')
open(p, "w").write(s)
PY
}

m_baseline_reads_a_missing_previous_state() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace("  if (!previous) return null;\n", "")
open(p, "w").write(s)
PY
}

m_fresh_candidate_leaves_no_baseline() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace("    if (baseline) baselines.set(baseline, key);\n", "")
open(p, "w").write(s)
PY
}

m_baseline_index_skips_the_stored_log() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace("    if (baseline && !baselines.has(baseline)) baselines.set(baseline, changeKey(change));\n", "")
open(p, "w").write(s)
PY
}

m_baseline_check_runs_before_the_exact_key() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace("""    if (keys.has(key)) {
      suppressed.push({ candidate, reason: SUPPRESSED_ALREADY_RECORDED });
      continue;
    }
    const baseline = baselineKey(candidate);""",
"""    const baseline = baselineKey(candidate);
    if (keys.has(key) && !baselines.has(baseline)) {
      suppressed.push({ candidate, reason: SUPPRESSED_ALREADY_RECORDED });
      continue;
    }""")
open(p, "w").write(s)
PY
}

m_collided_key_not_carried() {
  py <<'PY'
p = "scripts/change-log.js"
s = open(p).read()
s = s.replace("        collidedWith: baselines.get(baseline),\n", "")
open(p, "w").write(s)
PY
}

m_refusal_drops_the_collided_key() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace("  if (collidedWith) entry.collided_with = collidedWith;\n", "")
open(p, "w").write(s)
PY
}

m_refusal_always_carries_a_collided_key() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace("  if (collidedWith) entry.collided_with = collidedWith;",
              "  entry.collided_with = collidedWith ?? null;")
open(p, "w").write(s)
PY
}

m_every_suppression_becomes_a_refusal() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    .filter((entry) => entry.reason === SUPPRESSED_SAME_TRANSITION_REGRADED)\n", "")
open(p, "w").write(s)
PY
}

m_summary_does_not_split_the_two_counts() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    lines.push(`Already recorded, not written again: ${result.suppressed.length - regraded}`);",
              "    lines.push(`Already recorded, not written again: ${result.suppressed.length}`);")
open(p, "w").write(s)
PY
}

m_summary_reports_no_disagreement() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("Same transition re-read and graded differently, not written again: ${regraded}",
              "Same transition re-read and graded differently, not written again: 0")
open(p, "w").write(s)
PY
}

run_mutation "the baseline collision is never checked" m_no_baseline_check
run_mutation "the baseline ignores previous_state" m_baseline_ignores_previous_state
run_mutation "a record with no previous_state still gets a baseline" m_baseline_reads_a_missing_previous_state
run_mutation "an accepted candidate leaves no baseline behind it" m_fresh_candidate_leaves_no_baseline
run_mutation "the stored log contributes no baselines" m_baseline_index_skips_the_stored_log
run_mutation "the baseline check runs before the exact key" m_baseline_check_runs_before_the_exact_key
run_mutation "the collided key is not carried out of the suppression" m_collided_key_not_carried
run_mutation "the refusal drops the collided key" m_refusal_drops_the_collided_key
run_mutation "every refusal carries a collision field" m_refusal_always_carries_a_collided_key
run_mutation "every suppression is written as a refusal" m_every_suppression_becomes_a_refusal
run_mutation "the summary does not split the two counts" m_summary_does_not_split_the_two_counts
run_mutation "the summary reports no disagreement" m_summary_reports_no_disagreement

restore
echo
echo "killed: $killed   survived: $survived"
[ "$survived" -eq 0 ]
