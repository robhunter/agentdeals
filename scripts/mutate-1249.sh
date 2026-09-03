#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="scripts/change-gate.js"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
}
trap restore EXIT

killed=0
survived=0
TESTS="test/change-summary.test.ts"

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
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1249-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1249-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1249-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

swap() {
  py <<PY
p = "scripts/change-gate.js"
s = open(p).read()
before = s
s = s.replace("""$1""", """$2""", $3)
assert s != before, "mutation string not found"
open(p, "w").write(s)
PY
}

m_redirect_terminates_again() {
  swap 'if (evidence.kept.length === 0) {' \
       'if (movedTo) return { outcome: OUTCOME_REWRITTEN, reason: null, detail: "x", summary: summaryFromClauses([redirectClauseFor(record?.vendor, movedTo), ...evidence.kept]), dropped };
  if (evidence.kept.length === 0) {' 1
}

m_redirect_only_gate_removed() {
  swap 'if (!evidenced && evidence.kept.every(statesARedirect)) {' \
       'if (false && !evidenced && evidence.kept.every(statesARedirect)) {' 1
}

m_redirect_only_gate_ignores_the_removal_evidence() {
  swap 'if (!evidenced && evidence.kept.every(statesARedirect)) {' \
       'if (evidence.kept.every(statesARedirect)) {' 1
}

m_redirect_only_gate_accepts_any_surviving_clause() {
  swap 'if (!evidenced && evidence.kept.every(statesARedirect)) {' \
       'if (!evidenced && evidence.kept.some(statesARedirect)) {' 1
}

m_annotation_never_applied() {
  swap '    movedTo && !statesARedirect(record?.summary)' \
       '    false && movedTo && !statesARedirect(record?.summary)' 1
}

m_annotation_applied_twice() {
  swap '    movedTo && !statesARedirect(record?.summary)' \
       '    movedTo' 1
}

m_annotation_drops_the_original_summary() {
  swap '? summaryFromClauses([redirectClauseFor(record?.vendor, movedTo), record?.summary])' \
       '? summaryFromClauses([redirectClauseFor(record?.vendor, movedTo)])' 1
}

m_unchanged_ignores_the_annotation() {
  swap '  const nothingMoved = annotated === record?.summary && dropped.length === 0 && restored === 0;' \
       '  const nothingMoved = dropped.length === 0 && restored === 0;' 1
}

m_redirect_reader_matches_nothing() {
  swap 'const STATES_A_REDIRECT = /\\b(?:page|site|domain|url)\\s+(?:now\\s+)?redirects?\\s+to\\b/i;' \
       'const STATES_A_REDIRECT = /\\bnever matches this\\b/i;' 1
}

m_redirect_reader_matches_any_mention() {
  swap 'const STATES_A_REDIRECT = /\\b(?:page|site|domain|url)\\s+(?:now\\s+)?redirects?\\s+to\\b/i;' \
       'const STATES_A_REDIRECT = /./i;' 1
}

m_removal_from_root_gate_removed() {
  swap 'if (!evidenced && isDomainRoot(record?.source_url)) {' \
       'if (false && !evidenced && isDomainRoot(record?.source_url)) {' 1
}

m_still_offered_gate_removed() {
  swap 'if (reportsSomethingStillFree(record?.summary)) {' \
       'if (false && reportsSomethingStillFree(record?.summary)) {' 1
}

run_mutation "the redirect branch returns early again, exempting every gate below it" m_redirect_terminates_again
run_mutation "the redirect-only refusal is removed" m_redirect_only_gate_removed
run_mutation "the redirect-only refusal fires even where the summary states a removal" m_redirect_only_gate_ignores_the_removal_evidence
run_mutation "the redirect-only refusal fires on any clause that mentions a redirect" m_redirect_only_gate_accepts_any_surviving_clause
run_mutation "the redirect is never stated in the summary" m_annotation_never_applied
run_mutation "the redirect is stated again on a summary that already carries it" m_annotation_applied_twice
run_mutation "the annotation replaces the summary instead of preceding it" m_annotation_drops_the_original_summary
run_mutation "an annotated record is reported unchanged and loses the redirect" m_unchanged_ignores_the_annotation
run_mutation "no clause is read as reporting a redirect" m_redirect_reader_matches_nothing
run_mutation "every clause is read as reporting a redirect" m_redirect_reader_matches_any_mention
run_mutation "the root refusal is removed" m_removal_from_root_gate_removed
run_mutation "the still-offered refusal is removed" m_still_offered_gate_removed

echo
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
