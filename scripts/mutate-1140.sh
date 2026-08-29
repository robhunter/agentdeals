#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

VERDICT="src/comparison-verdict.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$VERDICT" "$BACKUP_DIR/comparison-verdict.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/comparison-verdict.ts" "$VERDICT"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/comparison-verdict.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/comparison-verdict.ts" "$VERDICT" > /dev/null && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1140-build.log 2>&1; then
    echo "    KILLED (does not compile)"
    killed=$((killed + 1))
    return
  fi
  if timeout 300 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1140-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1140-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1140-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_the_count_never_decides() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  return stabler.recordedChanges < other.recordedChanges ? stabler : null;", "  return stabler;")
open(p, "w").write(s)
PY
}

m_an_equal_count_still_names_a_winner() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  return stabler.recordedChanges < other.recordedChanges ? stabler : null;", "  return stabler.recordedChanges <= other.recordedChanges ? stabler : null;")
open(p, "w").write(s)
PY
}

m_a_withheld_rating_ranks_below_stable() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  if (ratingIsWithheld(a) || ratingIsWithheld(b)) return null;\n", "")
open(p, "w").write(s)
PY
}

m_two_sides_of_one_rating_are_ranked() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  if (a.rating === b.rating) return null;\n", "")
open(p, "w").write(s)
PY
}

m_a_withheld_rating_is_passed_over_in_silence() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("    return `${withheld.map(whyWithheld).join(\" \")} We are not comparing the two pricing histories.`;", "    return \"\";")
open(p, "w").write(s)
PY
}

m_the_reader_is_not_told_we_stopped_comparing() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("    return `${withheld.map(whyWithheld).join(\" \")} We are not comparing the two pricing histories.`;", "    return withheld.map(whyWithheld).join(\" \");")
open(p, "w").write(s)
PY
}

m_only_the_first_withheld_side_is_explained() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("withheld.map(whyWithheld).join(\" \")", "withheld.slice(0, 1).map(whyWithheld).join(\" \")")
open(p, "w").write(s)
PY
}

m_the_reason_is_never_named() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  return side.ratingWithheldBecause\n    ? withheldLevelSentence(side.ratingWithheldBecause, side.vendor, side.unconfirmableSince)\n    : `We are not publishing a stability rating for ${side.vendor}.`;", "  return `We are not publishing a stability rating for ${side.vendor}.`;")
open(p, "w").write(s)
PY
}

m_a_date_is_never_given_for_an_unreachable_page() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("withheldLevelSentence(side.ratingWithheldBecause, side.vendor, side.unconfirmableSince)", "withheldLevelSentence(side.ratingWithheldBecause, side.vendor, \"\")")
open(p, "w").write(s)
PY
}

m_every_count_is_plural() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  return `${count} recorded change${count === 1 ? \"\" : \"s\"}`;", "  return `${count} recorded changes`;")
open(p, "w").write(s)
PY
}

m_the_claim_states_no_counts() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  return `${stabler.vendor} has a more stable pricing history (${recordedChangesPhrase(stabler.recordedChanges)} vs ${other.recordedChanges}).`;", "  return `${stabler.vendor} has a more stable pricing history.`;")
open(p, "w").write(s)
PY
}

m_the_claim_states_the_losing_count_first() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("(${recordedChangesPhrase(stabler.recordedChanges)} vs ${other.recordedChanges})", "(${recordedChangesPhrase(other.recordedChanges)} vs ${stabler.recordedChanges})")
open(p, "w").write(s)
PY
}

m_the_structured_answer_drops_the_clause() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("  return `${stated(a)} ${stated(b)}${clause ? ` ${clause}` : \"\"}`;", "  return `${stated(a)} ${stated(b)}`;")
open(p, "w").write(s)
PY
}

m_the_structured_answer_publishes_a_withheld_rating() {
  py <<'PY'
p = "src/comparison-verdict.ts"
s = open(p).read()
s = s.replace("${side.rating ? ` and is rated ${side.rating}` : \"\"}", " and is rated ${side.rating}")
open(p, "w").write(s)
PY
}

m_the_page_never_reads_why_a_rating_was_withheld() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      ratingWithheldBecause: levelWithheldReason(risk, risk.link_unreachable),", "      ratingWithheldBecause: null,")
open(p, "w").write(s)
PY
}

m_the_page_reads_a_withheld_rating_as_stable() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    const rated = risk.risk_cause || risk.risk_level === \"stable\" ? risk.risk_level : null;", "    const rated = \"stable\";")
open(p, "w").write(s)
PY
}

m_the_verdict_drops_the_clause() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  if (stabilityClause) verdictText += ` ${stabilityClause}`;\n", "")
open(p, "w").write(s)
PY
}

m_each_side_counts_the_other_vendors_changes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const sideA = comparisonSide(a.vendor, riskA, a.deal_changes.length);\n  const sideB = comparisonSide(b.vendor, riskB, b.deal_changes.length);", "  const sideA = comparisonSide(a.vendor, riskA, b.deal_changes.length);\n  const sideB = comparisonSide(b.vendor, riskB, a.deal_changes.length);")
open(p, "w").write(s)
PY
}

m_a_truncated_list_says_nothing() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    const truncationNote = changes.length > shown.length\n      ? `<p style=\"color:var(--text-dim);font-size:.8rem;margin-top:.5rem\">Showing the ${shown.length} most recent of ${changes.length} recorded changes for ${escHtmlServer(vendor)}.</p>`\n      : \"\";", "    const truncationNote = \"\";")
open(p, "w").write(s)
PY
}

m_a_truncated_list_counts_only_what_it_shows() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("Showing the ${shown.length} most recent of ${changes.length} recorded changes", "Showing the ${shown.length} most recent of ${shown.length} recorded changes")
open(p, "w").write(s)
PY
}

run_mutation "the count never decides" m_the_count_never_decides
run_mutation "an equal count still names a winner" m_an_equal_count_still_names_a_winner
run_mutation "a withheld rating ranks below stable" m_a_withheld_rating_ranks_below_stable
run_mutation "two sides of one rating are ranked" m_two_sides_of_one_rating_are_ranked
run_mutation "a withheld rating is passed over in silence" m_a_withheld_rating_is_passed_over_in_silence
run_mutation "the reader is not told we stopped comparing" m_the_reader_is_not_told_we_stopped_comparing
run_mutation "only the first withheld side is explained" m_only_the_first_withheld_side_is_explained
run_mutation "the reason is never named" m_the_reason_is_never_named
run_mutation "a date is never given for an unreachable page" m_a_date_is_never_given_for_an_unreachable_page
run_mutation "every count is plural" m_every_count_is_plural
run_mutation "the claim states no counts" m_the_claim_states_no_counts
run_mutation "the claim states the losing count first" m_the_claim_states_the_losing_count_first
run_mutation "the structured answer drops the clause" m_the_structured_answer_drops_the_clause
run_mutation "the structured answer publishes a withheld rating" m_the_structured_answer_publishes_a_withheld_rating
run_mutation "the page never reads why a rating was withheld" m_the_page_never_reads_why_a_rating_was_withheld
run_mutation "the page reads a withheld rating as stable" m_the_page_reads_a_withheld_rating_as_stable
run_mutation "the verdict drops the clause" m_the_verdict_drops_the_clause
run_mutation "each side counts the other vendor's changes" m_each_side_counts_the_other_vendors_changes
run_mutation "a truncated list says nothing" m_a_truncated_list_says_nothing
run_mutation "a truncated list counts only what it shows" m_a_truncated_list_counts_only_what_it_shows

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed, survived: $survived"
[ "$survived" -eq 0 ]
