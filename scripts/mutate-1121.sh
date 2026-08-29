#!/usr/bin/env bash
#
# Mutation testing for the rule that the "when you'll outgrow it" threshold
# states the period its own description states, invents none where the
# description states none, and withholds where the stability verdict does.
#
# Each mutation breaks one property the change is supposed to hold, rebuilds,
# and runs the tests that claim to pin it. A surviving mutation means no test
# is asserting that property. A mutation that changes no file proves nothing
# and is reported as a survivor rather than silently passing.
#
# Usage:
#   bash scripts/mutate-1121.sh
#
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

LIMITS="src/growth-limits.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$LIMITS" "$BACKUP_DIR/growth-limits.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/growth-limits.ts" "$LIMITS"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  npx tsc > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/growth-limits.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$LIMITS" "$SERVE"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1121-build.log 2>&1; then
    echo "    KILLED: does not compile"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test $TESTS > /tmp/mutate-1121-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1121-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1121-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

# --- The period a description states is the period the page states ---

m_absent_period_defaults_to_a_month() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  return `${quantity} ${noun}`;\n}', '  return `${quantity} ${noun}/mo`;\n}')
open(p, "w").write(s)
PY
}

m_every_period_renders_as_a_month() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  return period.scope ? `${base} per ${period.scope}` : base;',
              '  return "/mo";')
open(p, "w").write(s)
PY
}

m_minutes_are_read_as_months() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  minute: "min",\n  minutes: "min",', '  minute: "mo",\n  minutes: "mo",')
open(p, "w").write(s)
PY
}

m_seconds_are_read_as_months() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  second: "sec",\n  seconds: "sec",', '  second: "mo",\n  seconds: "mo",')
open(p, "w").write(s)
PY
}

m_hours_are_read_as_days() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  hour: "hour",\n  hours: "hour",', '  hour: "day",\n  hours: "day",')
open(p, "w").write(s)
PY
}

m_a_period_written_as_a_phrase_is_not_read() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  const worded = rest.match(WORDED_PERIOD);', '  const worded = "".match(WORDED_PERIOD);')
open(p, "w").write(s)
PY
}

m_a_period_written_as_an_adverb_is_not_read() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  const adverb = rest.match(ADVERB_PERIOD);', '  const adverb = "".match(ADVERB_PERIOD);')
open(p, "w").write(s)
PY
}

m_the_period_is_read_from_anywhere_in_the_description() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('const WORDED_PERIOD = /^(?:\\s+for)?(?:\\s+free)?\\s+(?:per|a|an|every)\\s+(?:(\\d[\\d,]*)[\\s-]*)?([a-z]+)/i;',
              'const WORDED_PERIOD = /(?:\\s+for)?(?:\\s+free)?\\s+(?:per|a|an|every)\\s+(?:(\\d[\\d,]*)[\\s-]*)?([a-z]+)/i;')
open(p, "w").write(s)
PY
}

m_the_adverb_is_read_from_anywhere_in_the_description() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('const ADVERB_PERIOD = /^(?:\\s+for)?(?:\\s+free)?\\s+(hourly|daily|weekly|monthly|yearly|annually)\\b/i;',
              'const ADVERB_PERIOD = /(?:\\s+for)?(?:\\s+free)?\\s+(hourly|daily|weekly|monthly|yearly|annually)\\b/i;')
open(p, "w").write(s)
PY
}

m_a_multi_unit_window_is_flattened_to_one_unit() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  const base = period.count\n    ? ` per ${period.count} ${PLURAL_UNITS[period.unit]}`\n    : `/${period.unit}`;',
              '  const base = `/${period.unit}`;')
open(p, "w").write(s)
PY
}

m_any_noun_counts_as_a_unit_of_time() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('function timeUnit(word: string | undefined): string | undefined {\n  return word ? TIME_UNITS[word.toLowerCase()] : undefined;',
              'function timeUnit(word: string | undefined): string | undefined {\n  return word ? TIME_UNITS[word.toLowerCase()] ?? "mo" : undefined;')
open(p, "w").write(s)
PY
}

m_a_stored_depth_is_published_as_a_bare_quantity() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  const qualifier = rest.match(NON_RATE_QUALIFIER);\n  if (qualifier) return `${quantity} ${noun} of ${qualifier[1]}`;', '')
open(p, "w").write(s)
PY
}

m_the_scope_a_rate_is_measured_against_is_dropped() {
  py <<'PY'
p = "src/growth-limits.ts"
s = open(p).read()
s = s.replace('  return period.scope ? `${base} per ${period.scope}` : base;', '  return base;')
open(p, "w").write(s)
PY
}

# --- The threshold withholds where the stability verdict withholds ---

m_a_withheld_record_asserts_its_threshold() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    growthBullets.push(levelWithheld\n", "    growthBullets.push(false\n")
open(p, "w").write(s)
PY
}

m_a_withheld_threshold_names_no_reason() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('      ? `We record ${phrase} as the limit, but ${withheldClause}, so we cannot confirm that threshold today.`',
              '      ? `We record ${phrase} as the limit, so we cannot confirm that threshold today.`')
open(p, "w").write(s)
PY
}

m_a_withheld_threshold_drops_the_recorded_figure() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('      ? `We record ${phrase} as the limit, but ${withheldClause}, so we cannot confirm that threshold today.`',
              '      ? `We cannot confirm a threshold for this vendor today.`')
open(p, "w").write(s)
PY
}

m_a_confirmed_record_withholds_too() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    growthBullets.push(levelWithheld\n", "    growthBullets.push(true\n")
open(p, "w").write(s)
PY
}

m_structured_data_keeps_its_own_copy_of_the_threshold() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const faqOutgrowAnswer = growthBullets.length > 0\n    ? `${growthBullets[0].replace(/<[^>]*>/g, "")} When you outgrow',
              '  const faqOutgrowAnswer = growthBullets.length > 0\n    ? `At ${primary.description} When you outgrow')
open(p, "w").write(s)
PY
}

run_mutation "a description with no period gets a month anyway"          m_absent_period_defaults_to_a_month
run_mutation "every period renders as a month"                           m_every_period_renders_as_a_month
run_mutation "minutes are read as months"                                m_minutes_are_read_as_months
run_mutation "seconds are read as months"                                m_seconds_are_read_as_months
run_mutation "hours are read as days"                                    m_hours_are_read_as_days
run_mutation "a period written as a phrase is not read"                  m_a_period_written_as_a_phrase_is_not_read
run_mutation "a period written as an adverb is not read"                 m_a_period_written_as_an_adverb_is_not_read
run_mutation "the period may come from any clause"                       m_the_period_is_read_from_anywhere_in_the_description
run_mutation "the adverb may come from any clause"                       m_the_adverb_is_read_from_anywhere_in_the_description
run_mutation "a window several units wide is flattened to one"           m_a_multi_unit_window_is_flattened_to_one_unit
run_mutation "any noun counts as a unit of time"                         m_any_noun_counts_as_a_unit_of_time
run_mutation "a stored depth is published as a bare quantity"            m_a_stored_depth_is_published_as_a_bare_quantity
run_mutation "the scope a rate is measured against is dropped"           m_the_scope_a_rate_is_measured_against_is_dropped
run_mutation "a withheld record asserts its threshold"                   m_a_withheld_record_asserts_its_threshold
run_mutation "a withheld threshold names no reason"                      m_a_withheld_threshold_names_no_reason
run_mutation "a withheld threshold drops the recorded figure"            m_a_withheld_threshold_drops_the_recorded_figure
run_mutation "a confirmed record withholds too"                          m_a_confirmed_record_withholds_too
run_mutation "structured data keeps its own copy of the threshold"       m_structured_data_keeps_its_own_copy_of_the_threshold

echo
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
