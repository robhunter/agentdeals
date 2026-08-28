#!/usr/bin/env bash
#
# Mutation testing for the rule that withholds a stability judgement when we
# could not read the page a record cites.
#
# Each mutation breaks one property the change is supposed to hold, rebuilds,
# and runs the tests that claim to pin it. A surviving mutation means no test
# is asserting that property. A mutation that changes no file proves nothing
# and is reported as a survivor rather than silently passing.
#
# Usage:
#   bash scripts/mutate-1113.sh
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
TESTS="test/source-check.test.ts test/source-check-pages.test.ts test/enrich.test.ts test/link-liveness-pages.test.ts"

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
  if ! npx tsc > /tmp/mutate-1113-build.log 2>&1; then
    echo "    KILLED: does not compile"
    killed=$((killed + 1))
    return
  fi
  if timeout 600 node --test $TESTS > /tmp/mutate-1113-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1113-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1113-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_unreadable_no_longer_withholds() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  "does_not_name_vendor",\n  "unreadable",\n];', '  "does_not_name_vendor",\n];')
open(p, "w").write(s)
PY
}

m_thin_page_also_withholds() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  "does_not_name_vendor",\n  "unreadable",\n];',
              '  "does_not_name_vendor",\n  "unreadable",\n  "states_no_terms",\n];')
open(p, "w").write(s)
PY
}

m_every_outcome_withholds() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  if (outcome && LEVEL_WITHHOLDING_OUTCOMES.includes(outcome)) return outcome as LevelWithheldReason;',
              '  if (outcome) return outcome as LevelWithheldReason;')
open(p, "w").write(s)
PY
}

m_reason_collapses_to_one() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  if (outcome && LEVEL_WITHHOLDING_OUTCOMES.includes(outcome)) return outcome as LevelWithheldReason;',
              '  if (outcome && LEVEL_WITHHOLDING_OUTCOMES.includes(outcome)) return "does_not_name_vendor";')
open(p, "w").write(s)
PY
}

m_dead_link_loses_its_precedence() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  if (linkUnreachable) return "link_unreachable";\n  const outcome = offer.source_check?.outcome;',
              '  const outcome = offer.source_check?.outcome;')
s = s.replace('  if (outcome && LEVEL_WITHHOLDING_OUTCOMES.includes(outcome)) return outcome as LevelWithheldReason;\n  return null;',
              '  if (outcome && LEVEL_WITHHOLDING_OUTCOMES.includes(outcome)) return outcome as LevelWithheldReason;\n  if (linkUnreachable) return "link_unreachable";\n  return null;')
open(p, "w").write(s)
PY
}

m_clause_does_not_distinguish() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  return `we could not read the page we cite for this offer`;',
              '  return `the page we cite for this offer does not name it`;')
open(p, "w").write(s)
PY
}

m_sentence_does_not_distinguish() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  return `We could not read the page we cite for ${vendorName}.`;',
              '  return `The page we cite for ${vendorName} does not name it.`;')
open(p, "w").write(s)
PY
}

m_table_keeps_its_value() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const withheld = offer ? levelWithheldReason(offer, null) : null;", "  const withheld = null;")
open(p, "w").write(s)
PY
}

m_hero_keeps_its_verdict() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const verdictLine2 = levelWithheld", "  const verdictLine2 = false")
open(p, "w").write(s)
PY
}

m_empty_history_reads_as_good_news() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${escHtmlServer(vendorName)} — but ${escHtmlServer(withheldClause)}, so nothing we have read describes these terms.",
              "${escHtmlServer(vendorName)}. This is a good sign — stable pricing.")
open(p, "w").write(s)
PY
}

m_faq_keeps_its_answer() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("`We cannot say. ${withheldLevelSentence(levelWithheld, vendorName, unconfirmableSince)} Nothing we have read describes these terms, so we are not publishing a stability judgement for this vendor until that is fixed.`",
              "`${vendorName} is considered stable: we hold no free tier removal on record.`")
open(p, "w").write(s)
PY
}

m_change_answer_keeps_its_positive_signal() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    : levelWithheld\n    ? `We hold no recorded pricing changes for ${vendorName}, but ${withheldClause}, so that is a statement about our records rather than a positive signal.`\n", "")
open(p, "w").write(s)
PY
}

m_tool_result_claims_a_stable_history() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  } else if (sourceUnreadable(offer)) {", "  } else if (false) {")
open(p, "w").write(s)
PY
}

m_unreadable_predicate_matches_anything() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  return offer.source_check?.outcome === "unreadable";',
              '  return offer.source_check ? offer.source_check.outcome !== "ok" : false;')
open(p, "w").write(s)
PY
}

run_mutation "a page we could not read no longer withholds the level" m_unreadable_no_longer_withholds
run_mutation "a page stating no terms also withholds the level" m_thin_page_also_withholds
run_mutation "every non-ok outcome withholds the level" m_every_outcome_withholds
run_mutation "both withheld reasons report as the same reason" m_reason_collapses_to_one
run_mutation "a dead link loses its precedence over the page check" m_dead_link_loses_its_precedence
run_mutation "the withheld clause does not distinguish the reasons" m_clause_does_not_distinguish
run_mutation "the withheld sentence does not distinguish the reasons" m_sentence_does_not_distinguish
run_mutation "the comparison table still prints a stability value" m_table_keeps_its_value
run_mutation "the hero still opens with a stability verdict" m_hero_keeps_its_verdict
run_mutation "the page still calls an empty history good news" m_empty_history_reads_as_good_news
run_mutation "the reliability answer still calls it stable" m_faq_keeps_its_answer
run_mutation "the change answer still reads as a positive signal" m_change_answer_keeps_its_positive_signal
run_mutation "the tool result still claims a stable history" m_tool_result_claims_a_stable_history
run_mutation "the unread-page predicate matches any imperfect check" m_unreadable_predicate_matches_anything

echo ""
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
