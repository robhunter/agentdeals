#!/usr/bin/env bash
#
# Mutation testing for the rule that a record whose cited page states no terms
# we can read gets no stability verdict, and for the answers that must not open
# with a bare "Yes" when we cannot vouch for the terms behind them.
#
# Each mutation breaks one property the change is supposed to hold, rebuilds,
# and runs the tests that claim to pin it. A surviving mutation means no test
# is asserting that property. A mutation that changes no file proves nothing
# and is reported as a survivor rather than silently passing.
#
# Usage:
#   bash scripts/mutate-1122.sh
#
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SOURCE="src/source-check.ts"
SERVE="src/serve.ts"
DATA="src/data.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$SOURCE" "$BACKUP_DIR/source-check.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$DATA" "$BACKUP_DIR/data.ts"

restore() {
  cp "$BACKUP_DIR/source-check.ts" "$SOURCE"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/data.ts" "$DATA"
  npx tsc > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/source-check.test.ts test/source-check-pages.test.ts test/enrich.test.ts test/link-liveness-pages.test.ts test/vendor-risk.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$SOURCE" "$SERVE" "$DATA"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1122-build.log 2>&1; then
    echo "    KILLED: does not compile"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test $TESTS > /tmp/mutate-1122-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1122-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1122-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

# --- Part A: the outcome that was left out of the withholding list ---

m_no_terms_no_longer_withholds() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  "does_not_name_vendor",\n  "states_no_terms",\n  "unreadable",\n];',
              '  "does_not_name_vendor",\n  "unreadable",\n];')
open(p, "w").write(s)
PY
}

m_confirmed_source_withholds_too() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('export const LEVEL_WITHHOLDING_OUTCOMES: SourceCheckOutcome[] = [\n  "does_not_name_vendor",',
              'export const LEVEL_WITHHOLDING_OUTCOMES: SourceCheckOutcome[] = [\n  "ok",\n  "does_not_name_vendor",')
open(p, "w").write(s)
PY
}

# --- AC-2: three distinct sentences, one per outcome ---

m_no_terms_clause_reads_as_unreadable() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  states_no_terms: () => `the page we cite for this offer states no terms we can read`,',
              '  states_no_terms: () => `we could not read the page we cite for this offer`,')
open(p, "w").write(s)
PY
}

m_no_terms_sentence_reads_as_unnamed() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  states_no_terms: (subject) => `The page we cite for ${subject} states no terms we can read.`,',
              '  states_no_terms: (subject) => `The page we cite for ${subject} does not name it.`,')
open(p, "w").write(s)
PY
}

m_every_reason_shares_one_sentence() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('export function withheldLevelSentence(\n  reason: LevelWithheldReason,\n  subject: string,\n  since = "",\n): string {\n  return WITHHELD_LEVEL_SENTENCES[reason](subject, since);',
              'export function withheldLevelSentence(\n  reason: LevelWithheldReason,\n  subject: string,\n  since = "",\n): string {\n  return WITHHELD_LEVEL_SENTENCES.unreadable(subject, since);')
open(p, "w").write(s)
PY
}

# --- Part B: the question an answer engine quotes first ---

m_is_x_free_ignores_the_withholding() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const faqFreeAnswer = levelWithheld\n', '  const faqFreeAnswer = false\n')
open(p, "w").write(s)
PY
}

m_what_is_x_tier_ignores_the_withholding() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const faqTierAnswer = levelWithheld\n', '  const faqTierAnswer = false\n')
open(p, "w").write(s)
PY
}

m_answer_drops_the_reason_it_cannot_confirm() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('    ? `We cannot confirm that today. ${withheldLevelSentence(levelWithheld, vendorName, unconfirmableSince)} `',
              '    ? `We cannot confirm that today. `')
open(p, "w").write(s)
PY
}

m_answer_drops_the_unverified_caveat() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(' We have not confirmed these terms against the source we cite, so treat them as unverified.`;',
              '`;')
open(p, "w").write(s)
PY
}

m_answer_drops_the_stored_terms() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('Our stored record says ${vendorName} offers a free tier: ${primary.tier}. ${withUnconfirmedTermsCaveat(storedTerms)}',
              'Our stored record says ${vendorName} offers a free tier.')
open(p, "w").write(s)
PY
}

# --- the alternatives page, which re-asserted a level of its own ---

m_alternatives_page_publishes_the_level_anyway() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('    parts.push(\n      enriched.risk_level === null\n', '    parts.push(\n      false\n')
open(p, "w").write(s)
PY
}

m_alternatives_page_answers_yes_anyway() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const faqFreeTierAnswer = altLevelWithheld\n', '  const faqFreeTierAnswer = false\n')
open(p, "w").write(s)
PY
}

m_alternatives_page_reads_an_empty_history_as_stable() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('    : altLevelWithheld\n    ? `We hold no recorded pricing changes for ${vendorName}, but ${altWithheldClause}, so that is a statement about our records rather than a positive signal.`\n',
              '    : false\n    ? `We hold no recorded pricing changes for ${vendorName}, but ${altWithheldClause}, so that is a statement about our records rather than a positive signal.`\n')
open(p, "w").write(s)
PY
}

m_alternatives_page_names_no_reason() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const altWithheldSentence = altLevelWithheld\n    ? withheldLevelSentence(altLevelWithheld, vendorName, altUnconfirmableSince)\n    : "";',
              '  const altWithheldSentence = "";')
open(p, "w").write(s)
PY
}

# --- the tool result, which is a surface like any other ---

m_tool_summary_falls_through_to_a_stable_history() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  } else if (withheldReason) {', '  } else if (withheldReason && withheldReason !== "states_no_terms") {')
open(p, "w").write(s)
PY
}

m_tool_summary_names_the_wrong_reason() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('${withheldLevelSentence(withheldReason, offer.vendor, unreachableSince)}',
              '${withheldLevelSentence("unreadable", offer.vendor, unreachableSince)}')
open(p, "w").write(s)
PY
}

m_enriched_record_keeps_its_level() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('      cannotVouchForLevel(offer, link_unreachable) && assessment.level === "stable"\n        ? null\n        : assessment.level;',
              '      assessment.level;')
open(p, "w").write(s)
PY
}

run_mutation "states_no_terms is dropped from the withholding list"        m_no_terms_no_longer_withholds
run_mutation "a confirmed source withholds a level too"                    m_confirmed_source_withholds_too
run_mutation "the states-no-terms clause reads as an unread page"          m_no_terms_clause_reads_as_unreadable
run_mutation "the states-no-terms sentence reads as an unnamed vendor"     m_no_terms_sentence_reads_as_unnamed
run_mutation "every reason collapses to one sentence"                      m_every_reason_shares_one_sentence
run_mutation "'Is X free?' ignores the withholding"                        m_is_x_free_ignores_the_withholding
run_mutation "'What is X's free tier?' ignores the withholding"            m_what_is_x_tier_ignores_the_withholding
run_mutation "the answer drops the reason we cannot confirm it"            m_answer_drops_the_reason_it_cannot_confirm
run_mutation "the answer drops the unverified caveat"                      m_answer_drops_the_unverified_caveat
run_mutation "the answer drops the stored terms"                           m_answer_drops_the_stored_terms
run_mutation "the alternatives page publishes a level anyway"              m_alternatives_page_publishes_the_level_anyway
run_mutation "the alternatives page answers Yes anyway"                    m_alternatives_page_answers_yes_anyway
run_mutation "the alternatives page reads an empty history as stable"      m_alternatives_page_reads_an_empty_history_as_stable
run_mutation "the alternatives page names no reason"                       m_alternatives_page_names_no_reason
run_mutation "the tool summary falls through to a stable history"          m_tool_summary_falls_through_to_a_stable_history
run_mutation "the tool summary names the wrong reason"                     m_tool_summary_names_the_wrong_reason
run_mutation "the enriched record keeps its withheld level"                m_enriched_record_keeps_its_level

echo
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
