#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/serve.ts src/vendor-verdict.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/alternative-to-record-claims.test.ts test/vendor-verdict.test.ts"

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
  if ! npm run build > /tmp/mutate-1297-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1297-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1297-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1297-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

ANSWER='vendorChanges.length === 0 ? "No pricing changes have been recorded." : narrowingSentence(vendorChanges)'

m_the_answer_is_derived_from_the_verdict_again() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''$ANSWER''',
              '''vendorChanges.length === 0 ? "No pricing changes have been recorded." : \`We hold \${vendorChanges.length === 1 ? "1 recorded change" : \`\${vendorChanges.length} recorded changes\`} for this vendor, none of them a free tier removal, limit reduction or pricing restructure.\`''')
open(p, "w").write(s)
PY
}

m_the_answer_says_nothing_about_the_records() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''\${$ANSWER}''', '''''')
open(p, "w").write(s)
PY
}

m_the_answer_reads_an_empty_record_set() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''$ANSWER''',
              '''vendorChanges.length === 0 ? "No pricing changes have been recorded." : narrowingSentence([])''')
open(p, "w").write(s)
PY
}

m_the_answer_reads_the_history_sentence_instead() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''$ANSWER''',
              '''vendorChanges.length === 0 ? "No pricing changes have been recorded." : vendorHistorySentence(vendorName, riskLevel, riskCause)''')
open(p, "w").write(s)
PY
}

m_the_empty_history_branch_is_inverted() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''$ANSWER''',
              '''vendorChanges.length > 0 ? "No pricing changes have been recorded." : narrowingSentence(vendorChanges)''')
open(p, "w").write(s)
PY
}

m_a_single_record_gets_no_sentence() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''$ANSWER''',
              '''vendorChanges.length < 2 ? "No pricing changes have been recorded." : narrowingSentence(vendorChanges)''')
open(p, "w").write(s)
PY
}

m_only_the_newest_record_is_read() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
s = s.replace('''$ANSWER''',
              '''vendorChanges.length === 0 ? "No pricing changes have been recorded." : narrowingSentence(vendorChanges.slice(0, 1))''')
open(p, "w").write(s)
PY
}

m_a_withdrawn_record_narrows_again() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c))',
              '    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative")')
open(p, "w").write(s)
PY
}

m_a_favourable_record_narrows() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c))',
              '    .filter(c => CHANGE_DIRECTION[c.change_type] !== "negative" && !isNoLongerInForce(c))')
open(p, "w").write(s)
PY
}

m_the_sentence_is_always_empty() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('export function narrowingSentence(changes: VendorVerdictInput["changes"]): string {',
              'export function narrowingSentence(changes: VendorVerdictInput["changes"]): string {\n  if (changes.length >= 0) return "";')
open(p, "w").write(s)
PY
}

m_nothing_ever_narrowed() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  const narrowing = narrowingChanges(byTheVendor);',
              '  const narrowing: VendorVerdictInput["changes"] = [];')
open(p, "w").write(s)
PY
}

m_a_correction_counts_as_a_change_the_vendor_made() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  const byTheVendor = changes.filter(c => !isACorrectionToOurOwnRecord(c));',
              '  const byTheVendor = changes;')
open(p, "w").write(s)
PY
}

run_mutation "the answer is derived from the verdict again" m_the_answer_is_derived_from_the_verdict_again
run_mutation "the answer says nothing about the records" m_the_answer_says_nothing_about_the_records
run_mutation "the answer reads an empty record set" m_the_answer_reads_an_empty_record_set
run_mutation "the answer reads the history sentence instead" m_the_answer_reads_the_history_sentence_instead
run_mutation "the empty-history branch is inverted" m_the_empty_history_branch_is_inverted
run_mutation "a single record gets no sentence" m_a_single_record_gets_no_sentence
run_mutation "only the newest record is read" m_only_the_newest_record_is_read
run_mutation "a withdrawn record narrows again" m_a_withdrawn_record_narrows_again
run_mutation "a favourable record narrows" m_a_favourable_record_narrows
run_mutation "the sentence is always empty" m_the_sentence_is_always_empty
run_mutation "nothing ever narrowed" m_nothing_ever_narrowed
run_mutation "a correction counts as a change the vendor made" m_a_correction_counts_as_a_change_the_vendor_made

echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
