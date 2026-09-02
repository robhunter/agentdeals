#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

VERIFY="scripts/verify-freshness.js"
BACKUP_DIR="$(mktemp -d)"
cp "$VERIFY" "$BACKUP_DIR/verify-freshness.js"

restore() {
  cp "$BACKUP_DIR/verify-freshness.js" "$VERIFY"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/whole-page-read.test.ts test/change-gate.test.ts test/verify-freshness.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/verify-freshness.js" "$VERIFY" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1258-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1258-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1258-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_cut_restored_at_fetch() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("      text,\n      truncated: false,", "      text: text.slice(0, MAX_PAGE_TEXT_LENGTH),\n      truncated: text.length > MAX_PAGE_TEXT_LENGTH,")
open(p, "w").write(s)
PY
}

m_prompt_stops_truncating() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace('  const pageText = String(wholePageText ?? "").slice(0, MAX_PAGE_TEXT_LENGTH);', '  const pageText = String(wholePageText ?? "");')
open(p, "w").write(s)
PY
}

m_ceiling_never_refuses() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("    if (bytes > ceiling) {", "    if (false) {")
s = s.replace("  if (Number.isFinite(declared) && declared > ceiling) {", "  if (false) {")
open(p, "w").write(s)
PY
}

m_ceiling_ignores_declared_length() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("  if (Number.isFinite(declared) && declared > ceiling) {", "  if (false) {")
open(p, "w").write(s)
PY
}

m_ceiling_counts_characters() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("    bytes += chunk.length;", "    bytes += 0;")
open(p, "w").write(s)
PY
}

m_ceiling_set_below_the_corpus() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("export const MAX_PAGE_BYTES = 16_000_000;", "export const MAX_PAGE_BYTES = 100_000;")
open(p, "w").write(s)
PY
}

m_truncated_flag_lies() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("      truncated: false,", "      truncated: true,")
open(p, "w").write(s)
PY
}

run_mutation "the cut goes back to where the page is fetched" m_cut_restored_at_fetch
run_mutation "the prompt stops applying the cut" m_prompt_stops_truncating
run_mutation "the ceiling never refuses anything" m_ceiling_never_refuses
run_mutation "the ceiling ignores a declared content length" m_ceiling_ignores_declared_length
run_mutation "the ceiling stops counting bytes" m_ceiling_counts_characters
run_mutation "the ceiling is set below pages we already read" m_ceiling_set_below_the_corpus
run_mutation "the reader claims it truncated when it did not" m_truncated_flag_lies

echo
echo "killed $killed, survived $survived"
