#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

GATE="scripts/change-gate.js"
ALIASES="scripts/unit-aliases.js"
VERDICT="src/vendor-verdict.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$GATE" "$BACKUP_DIR/change-gate.js"
cp "$ALIASES" "$BACKUP_DIR/unit-aliases.js"
cp "$VERDICT" "$BACKUP_DIR/vendor-verdict.ts"

restore() {
  cp "$BACKUP_DIR/change-gate.js" "$GATE"
  cp "$BACKUP_DIR/unit-aliases.js" "$ALIASES"
  cp "$BACKUP_DIR/vendor-verdict.ts" "$VERDICT"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/restriction-evidence.test.ts test/vendor-verdict.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/change-gate.js" "$GATE" > /dev/null \
    && diff -q "$BACKUP_DIR/unit-aliases.js" "$ALIASES" > /dev/null \
    && diff -q "$BACKUP_DIR/vendor-verdict.ts" "$VERDICT" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1145-build.log 2>&1; then
    echo "    KILLED (does not compile)"
    killed=$((killed + 1))
    return
  fi
  if timeout 300 npx tsx --test $TESTS > /tmp/mutate-1145-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1145-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1145-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_a_summary_never_reports_that_nothing_moved() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return nothingMoved && summaryEvidence(summary).changed.length === 0;",
              "  return false;")
open(p, "w").write(s)
PY
}

m_a_free_tier_still_offered_is_enough_on_its_own() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return nothingMoved && summaryEvidence(summary).changed.length === 0;",
              "  return nothingMoved;")
open(p, "w").write(s)
PY
}

m_every_baseline_was_written_by_hand() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  return record?.date_source !== HAND_WRITTEN;', '  return false;')
open(p, "w").write(s)
PY
}

m_no_baseline_was_written_by_hand() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  return record?.date_source !== HAND_WRITTEN;', '  return true;')
open(p, "w").write(s)
PY
}

m_quantities_that_held_still_need_no_alias() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    compared.some(({ aliased }) => aliased) &&", "    compared.length > 0 &&")
open(p, "w").write(s)
PY
}

m_the_page_defines_no_units() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  for (const { left, right } of definedEquivalences(pageText)) {",
              "  for (const { left, right } of []) {")
open(p, "w").write(s)
PY
}

m_an_alias_reaches_only_one_way() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("        link(a, b);\n        link(b, a);", "        link(a, b);")
open(p, "w").write(s)
PY
}

m_any_parenthesis_is_an_abbreviation() {
  py <<'PY'
p = "scripts/unit-aliases.js"
s = open(p).read()
s = s.replace("  return initials === letters ? phrase.join(\" \") : null;", "  return phrase.join(\" \");")
open(p, "w").write(s)
PY
}

m_naming_our_own_entry_is_enough() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    return OUR_OWN_ENTRY.test(clause) && STATED_IT_WRONGLY.test(clause);",
              "    return OUR_OWN_ENTRY.test(clause);")
open(p, "w").write(s)
PY
}

m_the_two_halves_may_sit_in_different_clauses() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("""export function correctsOurOwnRecord(record) {
  return summaryClauses(record?.summary).some((raw) => {
    const clause = clauseText(raw);
    return OUR_OWN_ENTRY.test(clause) && STATED_IT_WRONGLY.test(clause);
  });
}""",
"""export function correctsOurOwnRecord(record) {
  const summary = record?.summary ?? "";
  return OUR_OWN_ENTRY.test(summary) && STATED_IT_WRONGLY.test(summary);
}""")
open(p, "w").write(s)
PY
}

m_the_gate_never_consults_the_restriction_rule() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const restriction = restrictionEvidence(entry, context);\n  if (!restriction.ok) return restriction;",
              "  const restriction = restrictionEvidence(entry, context);\n  if (false) return restriction;")
open(p, "w").write(s)
PY
}

m_the_gate_drops_the_reclassification() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("""  if (restriction.reclassifyAs) {
    return { ok: true, reclassifyAs: restriction.reclassifyAs, detail: restriction.detail };
  }""", "")
open(p, "w").write(s)
PY
}

m_the_rule_judges_every_change_type() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (record?.change_type !== RESTRICTION) return { ok: true };", "")
open(p, "w").write(s)
PY
}

m_the_page_it_read_never_reaches_the_rule() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const { compared, unmatched } = quantityComparison(record, unitAliases(context.pageText));",
              "  const { compared, unmatched } = quantityComparison(record, unitAliases(undefined));")
open(p, "w").write(s)
PY
}

m_a_repair_counts_as_a_change_the_vendor_made() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace("  const byTheVendor = changes.filter(c => !isACorrectionToOurOwnRecord(c));",
              "  const byTheVendor = changes;")
open(p, "w").write(s)
PY
}

m_a_page_holding_only_repairs_says_nothing_about_them() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace("""    return corrections.length === 1
      ? `The one record we hold corrects our own earlier entry rather than reporting a change the vendor made.`
      : `All ${corrections.length} records we hold correct our own earlier entries rather than reporting changes the vendor made.`;""",
"""    return corrections.length === 1
      ? `The one change we have recorded did not narrow the terms.`
      : `None of the ${corrections.length} recorded changes narrowed the terms.`;""")
open(p, "w").write(s)
PY
}

m_a_repair_is_counted_in_the_total() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace("  const total = byTheVendor.length;", "  const total = changes.length;")
open(p, "w").write(s)
PY
}

run_mutation "a summary never reports that nothing moved" m_a_summary_never_reports_that_nothing_moved
run_mutation "a free tier still offered is enough on its own" m_a_free_tier_still_offered_is_enough_on_its_own
run_mutation "every baseline was written by hand" m_every_baseline_was_written_by_hand
run_mutation "no baseline was written by hand" m_no_baseline_was_written_by_hand
run_mutation "quantities that held still need no alias" m_quantities_that_held_still_need_no_alias
run_mutation "the page defines no units" m_the_page_defines_no_units
run_mutation "an alias reaches only one way" m_an_alias_reaches_only_one_way
run_mutation "any parenthesis is an abbreviation" m_any_parenthesis_is_an_abbreviation
run_mutation "naming our own entry is enough" m_naming_our_own_entry_is_enough
run_mutation "the two halves may sit in different clauses" m_the_two_halves_may_sit_in_different_clauses
run_mutation "the gate never consults the restriction rule" m_the_gate_never_consults_the_restriction_rule
run_mutation "the gate drops the reclassification" m_the_gate_drops_the_reclassification
run_mutation "the rule judges every change type" m_the_rule_judges_every_change_type
run_mutation "the page it read never reaches the rule" m_the_page_it_read_never_reaches_the_rule
run_mutation "a repair counts as a change the vendor made" m_a_repair_counts_as_a_change_the_vendor_made
run_mutation "a page holding only repairs says nothing about them" m_a_page_holding_only_repairs_says_nothing_about_them
run_mutation "a repair is counted in the total" m_a_repair_is_counted_in_the_total

restore
npm run build > /dev/null 2>&1
echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
