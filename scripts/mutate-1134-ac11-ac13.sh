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
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1134-ac11-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1134-ac11-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1134-ac11-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_a_baseline_is_restored_over_the_figure_that_already_stands() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    const alreadyStated =\n      baseline !== null &&", "    const alreadyStated =\n      false &&")
open(p, "w").write(s)
PY
}

m_a_baseline_needs_neither_a_subject_of_its_own_nor_one_in_front() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("if (baseline === null || alreadyStated || !(carriesItsOwnSubject || followsASurvivor)) {", "if (baseline === null || alreadyStated) {")
open(p, "w").write(s)
PY
}

m_a_baseline_must_follow_a_survivor_even_when_it_names_its_own_subject() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("!(carriesItsOwnSubject || followsASurvivor)", "!followsASurvivor")
open(p, "w").write(s)
PY
}

m_a_baseline_must_name_its_own_subject_even_when_one_stands_in_front() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("!(carriesItsOwnSubject || followsASurvivor)", "!carriesItsOwnSubject")
open(p, "w").write(s)
PY
}

m_every_baseline_names_what_it_measures() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("export function namesWhatItMeasures(baseline) {\n  return quantifiedAttributes(baseline).length > 0;", "export function namesWhatItMeasures(baseline) {\n  return true;")
open(p, "w").write(s)
PY
}

m_the_clause_in_front_counts_whether_it_survived_or_not() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("const followsASurvivor = i > 0 && kinds[i - 1] === CLAUSE_TERMS;", "const followsASurvivor = i > 0;")
open(p, "w").write(s)
PY
}

m_the_restated_figure_keeps_the_predicate_that_follows_it() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const breaks = text.slice(tailFrom).search(A_NEW_PREDICATE_AFTER_THE_FIGURE);", "  const breaks = -1;")
open(p, "w").write(s)
PY
}

m_a_reporting_verb_survives_in_front_of_the_figure() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('    .replace(DOUBLED_CONNECTIVE, "previously")\n', "")
open(p, "w").write(s)
PY
}

m_two_figures_of_equal_value_are_the_same_figure() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('already.some((other) => comparedQuantity(figure, other)?.direction === "equal")', "already.some((other) => measuredValue(figure) === measuredValue(other))")
open(p, "w").write(s)
PY
}

m_one_matching_figure_makes_the_whole_baseline_a_repeat() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return carried.every((figure) =>", "  return carried.some((figure) =>")
open(p, "w").write(s)
PY
}

m_a_baseline_carrying_no_attribute_is_a_repeat_of_anything() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (carried.length === 0) return false;", "  if (carried.length === 0) return true;")
open(p, "w").write(s)
PY
}

m_a_directional_record_never_loses_the_subject_of_its_claim() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (statesABaseline(summary) || statesWhatChanged(record, summary)) return false;\n  return evidence.dropped.some(({ clause }) => statesWhatChanged(record, clause));", "  return false;")
open(p, "w").write(s)
PY
}

m_the_subject_need_not_have_been_dropped_by_the_gate() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return evidence.dropped.some(({ clause }) => statesWhatChanged(record, clause));", "  return true;")
open(p, "w").write(s)
PY
}

m_a_summary_stating_a_baseline_is_refused_anyway() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (statesABaseline(summary) || statesWhatChanged(record, summary)) return false;", "  if (statesWhatChanged(record, summary)) return false;")
open(p, "w").write(s)
PY
}

m_any_summary_names_the_dimension_that_changed() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("export function namesTheDimensionThatChanged(record, summary) {\n  const stored = quantifiedAttributes(record?.previous_state);", "export function namesTheDimensionThatChanged(record, summary) {\n  return true;\n  const stored = quantifiedAttributes(record?.previous_state);")
open(p, "w").write(s)
PY
}

m_a_stored_description_measuring_nothing_refuses_the_record() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (stored.length === 0) return true;\n  const stated = quantifiedAttributes(summary);", "  if (stored.length === 0) return false;\n  const stated = quantifiedAttributes(summary);")
open(p, "w").write(s)
PY
}

m_a_removal_is_read_by_its_stored_figures_rather_than_its_words() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (record?.change_type === FREE_TIER_REMOVED) return statesARemoval(summary);\n  return namesTheDimensionThatChanged(record, summary);", "  return namesTheDimensionThatChanged(record, summary);")
open(p, "w").write(s)
PY
}

run_mutation "a baseline is restored over the figure that already stands" m_a_baseline_is_restored_over_the_figure_that_already_stands
run_mutation "a baseline needs neither a subject of its own nor one in front" m_a_baseline_needs_neither_a_subject_of_its_own_nor_one_in_front
run_mutation "a baseline must follow a survivor even when it names its own subject" m_a_baseline_must_follow_a_survivor_even_when_it_names_its_own_subject
run_mutation "a baseline must name its own subject even when one stands in front" m_a_baseline_must_name_its_own_subject_even_when_one_stands_in_front
run_mutation "every baseline names what it measures" m_every_baseline_names_what_it_measures
run_mutation "the clause in front counts whether it survived or not" m_the_clause_in_front_counts_whether_it_survived_or_not
run_mutation "the restated figure keeps the predicate that follows it" m_the_restated_figure_keeps_the_predicate_that_follows_it
run_mutation "a reporting verb survives in front of the figure" m_a_reporting_verb_survives_in_front_of_the_figure
run_mutation "two figures of equal value are the same figure" m_two_figures_of_equal_value_are_the_same_figure
run_mutation "one matching figure makes the whole baseline a repeat" m_one_matching_figure_makes_the_whole_baseline_a_repeat
run_mutation "a baseline carrying no attribute is a repeat of anything" m_a_baseline_carrying_no_attribute_is_a_repeat_of_anything
run_mutation "a directional record never loses the subject of its claim" m_a_directional_record_never_loses_the_subject_of_its_claim
run_mutation "the subject need not have been dropped by the gate" m_the_subject_need_not_have_been_dropped_by_the_gate
run_mutation "a summary stating a baseline is refused anyway" m_a_summary_stating_a_baseline_is_refused_anyway
run_mutation "any summary names the dimension that changed" m_any_summary_names_the_dimension_that_changed
run_mutation "a stored description measuring nothing refuses the record" m_a_stored_description_measuring_nothing_refuses_the_record
run_mutation "a removal is read by its stored figures rather than its words" m_a_removal_is_read_by_its_stored_figures_rather_than_its_words

restore
echo
echo "killed: $killed, survived: $survived"
[ "$survived" -eq 0 ]
