#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

GATE="scripts/change-gate.js"
BACKUP_DIR="$(mktemp -d)"
cp "$GATE" "$BACKUP_DIR/change-gate.js"

restore() {
  cp "$BACKUP_DIR/change-gate.js" "$GATE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/change-summary.test.ts test/change-gate.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/change-gate.js" "$GATE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1136-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1136-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1136-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_a_period_is_never_normalised() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (over !== null && under !== null) {\n    from /= over;\n    to /= under;\n  }", "")
open(p, "w").write(s)
PY
}

m_a_period_count_counts_for_one() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return Number.isFinite(count) && count > 0 ? count * seconds : seconds;", "  return seconds;")
open(p, "w").write(s)
PY
}

m_a_magnitude_suffix_is_read_as_a_word() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    const scale =\n      BYTE_UNITS.get(unit ?? \"\") ??\n      MAGNITUDE_UNITS.get(magnitude) ??\n      spanOf(durationMatch ? durationMatch[1] : null) ??\n      1;", "    const scale = BYTE_UNITS.get(unit ?? \"\") ?? 1;")
open(p, "w").write(s)
PY
}

m_a_bare_duration_counts_as_its_own_number() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("      spanOf(durationMatch ? durationMatch[1] : null) ??\n", "")
open(p, "w").write(s)
PY
}

m_the_words_run_past_the_next_figure() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("      beside.search(A_FIGURE),\n", "")
open(p, "w").write(s)
PY
}

m_the_words_run_past_the_clause() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("      beside.search(CLAUSE_ENDS),\n", "")
open(p, "w").write(s)
PY
}

m_the_words_run_past_a_scope() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("      beside.search(A_SCOPE),\n", "")
open(p, "w").write(s)
PY
}

m_a_figure_with_no_words_nearby_is_dropped() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    words.push(...(named.length > 0 || rate ? named : wordsIn(trailing)));", "    words.push(...named);")
open(p, "w").write(s)
PY
}

m_a_number_spelling_a_period_is_a_quantity_of_its_own() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return readQuantities(text).filter(({ words, spellsAPeriod }) => words.length > 0 && !spellsAPeriod);", "  return readQuantities(text).filter(({ words }) => words.length > 0);")
open(p, "w").write(s)
PY
}

m_two_figures_measure_the_same_thing_whatever_they_name() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return after.words.includes(left) || before.words.includes(right);", "  return true;")
open(p, "w").write(s)
PY
}

m_a_price_is_compared_with_a_count() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (priced(before) !== priced(after)) return false;", "")
open(p, "w").write(s)
PY
}

m_a_price_counts_as_a_quantity_the_record_compares() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const previous = quantifiedAttributes(entry?.previous_state).filter(measuresAnAmount);\n  const current = quantifiedAttributes(entry?.current_state).filter(measuresAnAmount);", "  const previous = quantifiedAttributes(entry?.previous_state);\n  const current = quantifiedAttributes(entry?.current_state);")
open(p, "w").write(s)
PY
}

m_a_record_is_refused_whenever_nothing_moved() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (!everyStatedFigureHeldStill(published, compared, restated)) return null;\n", "")
open(p, "w").write(s)
PY
}

m_a_stated_figure_with_no_subject_is_held_still() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("      if (measuredWord(stated) === null) return false;", "      if (measuredWord(stated) === null) return true;")
open(p, "w").write(s)
PY
}

m_a_summary_restating_one_figure_never_counts() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const restated = nullComparisons(published);", "  const restated = [];")
open(p, "w").write(s)
PY
}

m_one_contradicting_figure_is_enough_to_refuse() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (contradicts.length === moved.length && contradicts.some((q) => statesBothSides(published, q))) {", "  if (contradicts.length > 0 && contradicts.some((q) => statesBothSides(published, q))) {")
open(p, "w").write(s)
PY
}

m_the_summary_need_not_state_the_figures_that_contradict() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (contradicts.length === moved.length && contradicts.some((q) => statesBothSides(published, q))) {", "  if (contradicts.length === moved.length) {")
open(p, "w").write(s)
PY
}

m_the_summary_need_only_state_one_side() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return carries(quantity.before) && carries(quantity.after);", "  return carries(quantity.before) || carries(quantity.after);")
open(p, "w").write(s)
PY
}

m_an_increase_and_a_reduction_expect_the_same_direction() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  limits_increased: \"increase\",", "  limits_increased: \"decrease\",")
open(p, "w").write(s)
PY
}

m_the_claim_is_judged_on_the_summary_as_written() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const measured = measuredAgainstItsClaim(record, rewritten);", "  const measured = measuredAgainstItsClaim(record, record?.summary);")
open(p, "w").write(s)
PY
}

m_the_words_are_read_from_in_front_of_the_period() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    const beside = trailing.slice(rate?.at === 0 ? rate.ends : 0);", "    const beside = trailing;")
open(p, "w").write(s)
PY
}

run_mutation "a period is never normalised" m_a_period_is_never_normalised
run_mutation "a period count counts for one" m_a_period_count_counts_for_one
run_mutation "a magnitude suffix is read as a word" m_a_magnitude_suffix_is_read_as_a_word
run_mutation "a bare duration counts as its own number" m_a_bare_duration_counts_as_its_own_number
run_mutation "the words run past the next figure" m_the_words_run_past_the_next_figure
run_mutation "the words run past the clause" m_the_words_run_past_the_clause
run_mutation "the words run past a scope" m_the_words_run_past_a_scope
run_mutation "a figure with no words nearby is dropped" m_a_figure_with_no_words_nearby_is_dropped
run_mutation "the words are read from in front of the period" m_the_words_are_read_from_in_front_of_the_period
run_mutation "a number spelling a period is a quantity of its own" m_a_number_spelling_a_period_is_a_quantity_of_its_own
run_mutation "two figures measure the same thing whatever they name" m_two_figures_measure_the_same_thing_whatever_they_name
run_mutation "a price is compared with a count" m_a_price_is_compared_with_a_count
run_mutation "a price counts as a quantity the record compares" m_a_price_counts_as_a_quantity_the_record_compares
run_mutation "a record is refused whenever nothing moved" m_a_record_is_refused_whenever_nothing_moved
run_mutation "a stated figure with no subject is held still" m_a_stated_figure_with_no_subject_is_held_still
run_mutation "a summary restating one figure never counts" m_a_summary_restating_one_figure_never_counts
run_mutation "one contradicting figure is enough to refuse" m_one_contradicting_figure_is_enough_to_refuse
run_mutation "the summary need not state the figures that contradict" m_the_summary_need_not_state_the_figures_that_contradict
run_mutation "the summary need only state one side" m_the_summary_need_only_state_one_side
run_mutation "an increase and a reduction expect the same direction" m_an_increase_and_a_reduction_expect_the_same_direction
run_mutation "the claim is judged on the summary as written" m_the_claim_is_judged_on_the_summary_as_written

restore
echo
echo "killed: $killed, survived: $survived"
[ "$survived" -eq 0 ]
