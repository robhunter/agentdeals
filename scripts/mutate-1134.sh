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
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1134-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1134-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1134-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }


m_an_absent_mention_is_read_as_a_term() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (ABSENCE_FRAMES.some((pattern) => pattern.test(clause))) return CLAUSE_ABSENCE;\n", "")
open(p, "w").write(s)
PY
}

m_an_empty_summary_still_describes_a_change() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (evidence.kept.length === 0) {", "  if (false) {")
open(p, "w").write(s)
PY
}

m_a_clause_about_our_record_is_kept() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (BOOKKEEPING_FRAMES.some((pattern) => pattern.test(clause))) return CLAUSE_BOOKKEEPING;\n", "")
open(p, "w").write(s)
PY
}

m_a_hedged_clause_is_kept() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (HEDGE_FRAMES.some((pattern) => pattern.test(clause))) return CLAUSE_HEDGE;\n", "")
open(p, "w").write(s)
PY
}

m_a_clause_about_the_page_is_kept_even_with_no_term() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (narratesTheReading(clause) && !statesTerms(clause)) return CLAUSE_NARRATION;\n", "")
open(p, "w").write(s)
PY
}

m_a_clause_about_the_page_is_dropped_even_when_it_states_a_term() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("if (narratesTheReading(clause) && !statesTerms(clause)) return CLAUSE_NARRATION;",
              "if (narratesTheReading(clause)) return CLAUSE_NARRATION;")
open(p, "w").write(s)
PY
}


m_a_summary_is_one_clause() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  return summary\n    .replace(/([.!?])\\s+(?=["\'“(]?[A-Z0-9])/g',
              '  return [summary].map((x) => x).join("")\n    .replace(/(NEVER)([.!?])\\s+(?=["\'“(]?[A-Z0-9])/g')
open(p, "w").write(s)
PY
}

m_a_contrast_does_not_start_a_new_clause() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("/[,;]\\s+(?=(?:but|while|whereas|which|although|though|however|yet)\\b)/gi",
              "/[,;]\\s+(?=(?:but|although|though|however|yet)\\b)/gi")
open(p, "w").write(s)
PY
}

m_a_bookkeeping_comparison_does_not_start_a_new_clause() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("compared\\s+to|versus|vs\\.?|as\\s+opposed\\s+to|instead\\s+of|rather\\s+than",
              "as\\s+opposed\\s+to")
open(p, "w").write(s)
PY
}


m_evidence_need_not_survive_the_rewrite() {
  py <<'PYX'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    const evidenced = statesARemoval(rewritten);", "    const evidenced = statesARemoval(record?.summary);")
open(p, "w").write(s)
PYX
}

m_a_removal_needs_no_evidence() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (!evidenced && dropped.some(({ kind }) => kind === CLAUSE_ABSENCE)) {", "    if (false) {")
open(p, "w").write(s)
PY
}

m_a_homepage_is_evidence_enough() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (!evidenced && isDomainRoot(record?.source_url)) {", "    if (false) {")
open(p, "w").write(s)
PY
}

m_a_path_is_read_as_a_domain_root() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('    return parsed.pathname === "/" && !parsed.search && !parsed.hash;', "    return true;")
open(p, "w").write(s)
PY
}

m_a_summary_reporting_a_free_tier_still_records_its_removal() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (reportsSomethingStillFree(record?.summary)) {", "    if (false) {")
open(p, "w").write(s)
PY
}

m_a_free_trial_counts_as_a_free_tier_still_offered() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  const withoutTrials = summary.replace(/\\bfree\\s+trials?\\b/gi, "trial");',
              "  const withoutTrials = summary;")
open(p, "w").write(s)
PY
}


m_a_redirect_is_not_evidence() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const movedOffDomain = redirectedOffDomain(record?.source_url, context.finalUrl);",
              "  const movedOffDomain = false;")
open(p, "w").write(s)
PY
}

m_a_redirect_within_the_same_domain_is_evidence() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (!from || !to || from === to) return false;", "  if (!from || !to) return false;")
open(p, "w").write(s)
PY
}


m_agreement_is_only_read_when_it_names_our_record() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return AGREEMENT_CLAUSES.some((pattern) => pattern.test(summary));", "  return false;")
open(p, "w").write(s)
PY
}

m_agreement_alone_refuses_the_record() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    evidence.changed.length === 0 &&\n    !namesSomethingNew(rewritten, record?.previous_state)\n", "    true\n")
open(p, "w").write(s)
PY
}


m_a_restated_figure_is_a_change() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (sameQuantities(clauses[i - 1], clauses[i])) kinds[i] = CLAUSE_RESTATEMENT;", "")
open(p, "w").write(s)
PY
}

m_a_differing_figure_is_a_restatement() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return left.length > 0 && multisetEqual(left, right);", "  return left.length > 0;")
open(p, "w").write(s)
PY
}

m_a_stripped_summary_need_not_keep_a_figure() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    quantities(rewritten).length === 0 &&", "    false &&")
open(p, "w").write(s)
PY
}


m_the_rewrite_is_never_applied() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (verdict.outcome !== OUTCOME_REWRITTEN) return record;\n  return { ...record, summary: verdict.summary };",
              "  return record;")
open(p, "w").write(s)
PY
}

m_the_rewrite_mutates_the_record_it_was_built_from() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  return { ...record, summary: verdict.summary };",
              "  record.summary = verdict.summary;\n  return record;")
open(p, "w").write(s)
PY
}

m_a_dropped_connective_is_left_at_the_front() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('    const opened = clause.replace(CONTINUES_A_SENTENCE, "").replace(TRAILING_CONNECTIVE, "");',
              '    const opened = clause.replace(CONTINUES_A_SENTENCE, "");')
open(p, "w").write(s)
PY
}

m_a_baseline_is_never_restored() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (restored === 0) return null;", "  return null;")
open(p, "w").write(s)
PY
}

m_our_records_subject_survives_the_strip() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  for (const [pattern, replacement] of STORED_REFERENCE_REWRITES) text = text.replace(pattern, replacement);\n", "")
open(p, "w").write(s)
PY
}

m_a_directional_record_never_needs_a_baseline() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (!DIRECTIONAL_CLAIMS.includes(record?.change_type)) return false;", "  if (!DIRECTIONAL_CLAIMS.includes(record?.change_type)) return false;\n  return false;")
open(p, "w").write(s)
PY
}

m_a_dangling_opener_is_published() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  const first = evidence.kinds.indexOf(CLAUSE_TERMS);\n  if (first <= 0) return false;", "  return false;")
open(p, "w").write(s)
PY
}

m_any_opening_pronoun_is_dangling() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (first <= 0) return false;", "  if (first < 0) return false;")
open(p, "w").write(s)
PY
}

m_a_restated_figure_can_supply_the_baseline() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    const restatedByTheNext = evidence.kinds[i + 1] === CLAUSE_RESTATEMENT;", "    const restatedByTheNext = false;")
open(p, "w").write(s)
PY
}

m_a_speed_claim_is_a_term_of_the_offer() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('"hour", "minute", "min", "second", "sec", "mo", "yr",', '"hour", "minute", "min", "mo", "yr",')
open(p, "w").write(s)
PY
}

m_a_restored_clause_need_not_carry_a_figure() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("if (!stripped || namesOurRecord(stripped) || quantities(stripped).length === 0) return null;", "if (!stripped) return null;")
open(p, "w").write(s)
PY
}

m_a_restoration_leaves_the_record_unchanged() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if ((dropped.length === 0 && restored === 0) || rewritten === record?.summary) {", "  if (dropped.length === 0 || rewritten === record?.summary) {")
open(p, "w").write(s)
PY
}

m_a_reclassified_record_is_judged_as_the_type_it_had() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("""        const asRestructure = auditRecord(
          { ...entry, change_type: RECLASSIFIED_AS_RESTRUCTURE },
          context
        );""", "        const asRestructure = auditRecord(entry, context);")
open(p, "w").write(s)
PY
}

m_a_summary_with_no_terms_is_refused_before_the_baseline_is_tried() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    const restated = withBaselineRestored(evidence, true);", "    const restated = null;")
open(p, "w").write(s)
PY
}

m_a_restored_clause_need_not_state_a_difference() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (mustStateADifference && !statesADifference(stripped)) return null;", "")
open(p, "w").write(s)
PY
}

run_mutation "an absence of mention is read as a term" m_an_absent_mention_is_read_as_a_term
run_mutation "a summary with nothing left still describes a change" m_an_empty_summary_still_describes_a_change
run_mutation "a clause about our own record is kept" m_a_clause_about_our_record_is_kept
run_mutation "a hedged clause is kept" m_a_hedged_clause_is_kept
run_mutation "a clause about the page is kept even when it names no term" m_a_clause_about_the_page_is_kept_even_with_no_term
run_mutation "a clause about the page is dropped even when it names a term" m_a_clause_about_the_page_is_dropped_even_when_it_states_a_term
run_mutation "a summary is read as a single clause" m_a_summary_is_one_clause
run_mutation "a contrasting connective does not start a clause" m_a_contrast_does_not_start_a_new_clause
run_mutation "a bookkeeping comparison does not start a clause" m_a_bookkeeping_comparison_does_not_start_a_new_clause
run_mutation "a free tier removal needs no positive evidence" m_a_removal_needs_no_evidence
run_mutation "the removal evidence need not survive the rewrite" m_evidence_need_not_survive_the_rewrite
run_mutation "a homepage's silence is evidence enough" m_a_homepage_is_evidence_enough
run_mutation "a URL with a path is read as a domain root" m_a_path_is_read_as_a_domain_root
run_mutation "a summary reporting a free tier still records its removal" m_a_summary_reporting_a_free_tier_still_records_its_removal
run_mutation "a free trial counts as a free tier still on offer" m_a_free_trial_counts_as_a_free_tier_still_offered
run_mutation "a redirect off the vendor's domain is not evidence" m_a_redirect_is_not_evidence
run_mutation "a redirect within the same domain is evidence" m_a_redirect_within_the_same_domain_is_evidence
run_mutation "agreement is only read when it names our record" m_agreement_is_only_read_when_it_names_our_record
run_mutation "agreement alone refuses the record" m_agreement_alone_refuses_the_record
run_mutation "a figure restated on both sides is a change" m_a_restated_figure_is_a_change
run_mutation "a differing figure is read as a restatement" m_a_differing_figure_is_a_restatement
run_mutation "a stripped summary need not keep a figure" m_a_stripped_summary_need_not_keep_a_figure
run_mutation "the rewrite is never applied to the record" m_the_rewrite_is_never_applied
run_mutation "the rewrite mutates the record it was built from" m_the_rewrite_mutates_the_record_it_was_built_from
run_mutation "a dropped connective is left at the front of the sentence" m_a_dropped_connective_is_left_at_the_front
run_mutation "a baseline is never restored" m_a_baseline_is_never_restored
run_mutation "our record's subject survives the strip" m_our_records_subject_survives_the_strip
run_mutation "a directional record never needs a baseline" m_a_directional_record_never_needs_a_baseline
run_mutation "a dangling opener is published" m_a_dangling_opener_is_published
run_mutation "any opening pronoun is a dangling reference" m_any_opening_pronoun_is_dangling
run_mutation "a restated figure can supply the baseline" m_a_restated_figure_can_supply_the_baseline
run_mutation "a speed claim is a term of the offer" m_a_speed_claim_is_a_term_of_the_offer
run_mutation "a restored clause need not carry a figure" m_a_restored_clause_need_not_carry_a_figure
run_mutation "a restoration leaves the record unchanged" m_a_restoration_leaves_the_record_unchanged
run_mutation "a reclassified record is judged as the type it had" m_a_reclassified_record_is_judged_as_the_type_it_had
run_mutation "a summary with no terms is refused before the baseline is tried" m_a_summary_with_no_terms_is_refused_before_the_baseline_is_tried
run_mutation "a restored clause need not state a difference" m_a_restored_clause_need_not_state_a_difference

restore
echo
echo "killed: $killed, survived: $survived"
[ "$survived" -eq 0 ]
