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
TESTS="test/short-page-floor.test.ts test/whole-page-read.test.ts test/change-gate.test.ts test/verify-freshness.test.ts test/verification-state.test.ts"

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
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1263-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1263-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1263-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_floor_back_to_fifty() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("export const MIN_PAGE_TEXT_LENGTH = 500;", "export const MIN_PAGE_TEXT_LENGTH = 50;")
open(p, "w").write(s)
PY
}

m_floor_raised_past_the_shortest_confirmed_page() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("export const MIN_PAGE_TEXT_LENGTH = 500;", "export const MIN_PAGE_TEXT_LENGTH = 1000;")
open(p, "w").write(s)
PY
}

m_floor_off_by_one_at_the_boundary() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("if (page.text.length < floor) {", "if (page.text.length <= floor) {")
open(p, "w").write(s)
PY
}

m_floor_not_applied_at_fetch() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("""    return withMinimumLength({
      ok: true,
      text,
      truncated: false,
      finalUrl: res.url || url,
    });""", """    return {
      ok: true,
      text,
      truncated: false,
      finalUrl: res.url || url,
    };""")
open(p, "w").write(s)
PY
}

m_refusal_drops_the_measured_length() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("return { ok: false, error: PAGE_TOO_SHORT_ERROR, chars: page.text.length };", "return { ok: false, error: PAGE_TOO_SHORT_ERROR };")
open(p, "w").write(s)
PY
}

m_refusal_leaves_the_text_readable() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("return { ok: false, error: PAGE_TOO_SHORT_ERROR, chars: page.text.length };", "return { ok: true, text: page.text, chars: page.text.length };")
open(p, "w").write(s)
PY
}

m_refusal_renamed_out_of_the_empty_page_class() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace('export const PAGE_TOO_SHORT_ERROR = "page content too short (likely JS-rendered SPA)";', 'export const PAGE_TOO_SHORT_ERROR = "page under the readable length";')
open(p, "w").write(s)
PY
}

m_floor_applied_to_a_failed_fetch() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace("export function withMinimumLength(page, floor = MIN_PAGE_TEXT_LENGTH) {\n  if (!page.ok) return page;", "export function withMinimumLength(page, floor = MIN_PAGE_TEXT_LENGTH) {\n  if (!page.ok) return { ok: false, error: PAGE_TOO_SHORT_ERROR, chars: 0 };")
open(p, "w").write(s)
PY
}

run_mutation "the floor goes back to the number that let a 53-character page speak" m_floor_back_to_fifty
run_mutation "the floor rises past the shortest page we confirm terms from" m_floor_raised_past_the_shortest_confirmed_page
run_mutation "the boundary refuses a page of exactly the floor" m_floor_off_by_one_at_the_boundary
run_mutation "the fetch stops applying the floor" m_floor_not_applied_at_fetch
run_mutation "the refusal stops reporting the length it measured" m_refusal_drops_the_measured_length
run_mutation "the refusal returns the text it refused" m_refusal_leaves_the_text_readable
run_mutation "the refusal is renamed out of the empty-page failure class" m_refusal_renamed_out_of_the_empty_page_class
run_mutation "the floor overwrites a fetch that never produced a body" m_floor_applied_to_a_failed_fetch

restore
echo ""
echo "killed:   $killed"
echo "survived: $survived"
