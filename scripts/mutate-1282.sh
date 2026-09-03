#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/change-resolution.ts src/data.ts src/change-lineup.ts src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/change-resolution.test.ts test/change-lineup.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  local changed=0
  for f in $FILES; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1282-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test $TESTS > /tmp/mutate-1282-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1282-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1282-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_a_resolution_does_not_reach_the_summary() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''export function withResolutionInSummary<T extends ResolvableChange>(change: T): T {
  if (!change.resolution) return change;
  return { ...change, summary: summaryWithResolution(change) };
}''', '''export function withResolutionInSummary<T extends ResolvableChange>(change: T): T {
  return change;
}''')
open(p, "w").write(s)
PY
}

m_the_summary_states_the_resolution_twice() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('  if (!detail || tagged.includes(detail)) return tagged;\n  return `${tagged} ${detail}`;',
              '  return detail ? `${tagged} ${detail}` : tagged;')
open(p, "w").write(s)
PY
}

m_a_resolved_change_still_demotes() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  if (isNoLongerInForce(change)) return null;\n  const flat = RISK_DEMOTION[change.change_type];',
              '  const flat = RISK_DEMOTION[change.change_type];')
open(p, "w").write(s)
PY
}

m_a_resolved_change_still_counts_toward_stability() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  const stillInForce = vendorChanges.filter((c) => !isNoLongerInForce(c));',
              '  const stillInForce = vendorChanges;')
open(p, "w").write(s)
PY
}

m_a_retracted_record_still_states_a_lineup() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace('  if (theEventNeverHappened(change)) return false;\n', '')
open(p, "w").write(s)
PY
}

m_a_reversal_reads_as_a_retraction() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('  return change.resolution?.state === "retracted";',
              '  return Boolean(change.resolution);')
open(p, "w").write(s)
PY
}

m_prose_alone_passes_the_guard() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''const RESOLUTION_ASSERTIONS = [
  /\\breversed\\b/i,''', '''const RESOLUTION_ASSERTIONS = [
  /\\bnothing at all\\b/i,''')
open(p, "w").write(s)
PY
}

m_the_detail_is_not_stripped_before_the_guard_reads_it() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''  const withoutWhatTheFieldItselfWrote = (text: string | undefined) =>
    text ? written.reduce((rest, piece) => rest.split(piece).join(" "), text) : text;''',
'''  const withoutWhatTheFieldItselfWrote = (text: string | undefined) => text;''')
open(p, "w").write(s)
PY
}

m_a_resolving_record_need_not_exist() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''  return (
    log.find((c) => c.vendor === ref.vendor && c.date === ref.date && c.change_type === ref.change_type) ?? null
  );''', '''  return log[0] ?? null;''')
open(p, "w").write(s)
PY
}

m_risk_cause_drops_the_record_state() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('''    current_state: cause.current_state,
    resolution: cause.resolution ?? null,''', '')
open(p, "w").write(s)
PY
}

m_the_vendor_page_does_not_mark_a_resolved_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('return `<div class="change-item${isNoLongerInForce(c) ? " change-resolved" : ""}">',
              'return `<div class="change-item">')
open(p, "w").write(s)
PY
}

m_the_change_log_does_not_mark_a_resolved_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('${isNoLongerInForce(c) ? " pc-resolved" : ""}', '')
open(p, "w").write(s)
PY
}

run_mutation "a resolution does not reach the summary" m_a_resolution_does_not_reach_the_summary
run_mutation "the summary states the resolution twice" m_the_summary_states_the_resolution_twice
run_mutation "a resolved change still demotes" m_a_resolved_change_still_demotes
run_mutation "a resolved change still counts toward stability" m_a_resolved_change_still_counts_toward_stability
run_mutation "a retracted record still states a lineup" m_a_retracted_record_still_states_a_lineup
run_mutation "a reversal reads as a retraction" m_a_reversal_reads_as_a_retraction
run_mutation "prose alone passes the guard" m_prose_alone_passes_the_guard
run_mutation "the detail is not stripped before the guard reads it" m_the_detail_is_not_stripped_before_the_guard_reads_it
run_mutation "a resolving record need not exist" m_a_resolving_record_need_not_exist
run_mutation "risk_cause drops the record state" m_risk_cause_drops_the_record_state
run_mutation "the vendor page does not mark a resolved change" m_the_vendor_page_does_not_mark_a_resolved_change
run_mutation "the change log does not mark a resolved change" m_the_change_log_does_not_mark_a_resolved_change

echo
echo "killed $killed  survived $survived"
[ "$survived" -eq 0 ]
