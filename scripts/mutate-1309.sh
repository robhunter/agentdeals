#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/serve.ts src/data.ts src/server-remote.ts src/api-client.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/changes-pagination.test.ts"

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
  if ! npm run build > /tmp/mutate-1309-build.log 2>&1; then
    echo "    KILLED BY TSC ONLY: rewrite it to typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1309-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1309-test.log) failing assertion(s)"
    grep '  ✖ ' /tmp/mutate-1309-test.log | head -3
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_limit_is_read_and_not_applied() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    const page = result.changes.slice(offset, offset + limit);",
              "    const page = result.changes;")
open(p, "w").write(s)
PY
}

m_total_reports_the_page_not_the_window() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      total: result.total,\n      returned: page.length,",
              "      total: page.length,\n      returned: page.length,")
open(p, "w").write(s)
PY
}

m_offset_is_read_and_not_applied() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    const page = result.changes.slice(offset, offset + limit);",
              "    const page = result.changes.slice(0, limit);")
open(p, "w").write(s)
PY
}

m_the_singular_category_is_ignored_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('const categoriesFilter = url.searchParams.get("categories") || url.searchParams.get("category") || undefined;',
              'const categoriesFilter = url.searchParams.get("categories") || undefined;')
open(p, "w").write(s)
PY
}

m_a_filter_returns_a_second_shape() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    res.end(JSON.stringify(cited({
      changes: page,
      total: result.total,""",
              """    res.end(JSON.stringify(cited({
      ...(vendorsFilter || categoriesFilter ? { your_stack_changes: page } : { changes: page }),
      total: result.total,""")
open(p, "w").write(s)
PY
}

m_the_period_is_not_named() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      summary: context.summary,\n", "")
open(p, "w").write(s)
PY
}

m_an_unreadable_page_size_is_ignored_rather_than_refused() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    if (badPaging) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: `Invalid '${badPaging[0]}' parameter. Expected a non-negative integer.` }));
      return;
    }""",
              """    if (badPaging) {
      void badPaging;
    }""")
s = s.replace("    const limit = limitParam === null ? CHANGES_DEFAULT_LIMIT : parseInt(limitParam, 10);",
              "    const limit = limitParam === null || !/^\\d+$/.test(limitParam) ? CHANGES_DEFAULT_LIMIT : parseInt(limitParam, 10);")
s = s.replace("    const offset = offsetParam === null ? 0 : parseInt(offsetParam, 10);",
              "    const offset = offsetParam === null || !/^\\d+$/.test(offsetParam) ? 0 : parseInt(offsetParam, 10);")
open(p, "w").write(s)
PY
}

m_the_whole_window_is_unreachable() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    const limit = limitParam === null ? CHANGES_DEFAULT_LIMIT : parseInt(limitParam, 10);",
              "    const limit = Math.min(limitParam === null ? CHANGES_DEFAULT_LIMIT : parseInt(limitParam, 10), 50);")
open(p, "w").write(s)
PY
}

m_the_default_page_grows_past_its_budget() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const CHANGES_DEFAULT_LIMIT = 20;", "const CHANGES_DEFAULT_LIMIT = 200;")
open(p, "w").write(s)
PY
}

m_the_proxy_pin_truncates_the_window() {
  py <<'PY'
p = "src/server-remote.ts"
s = open(p).read()
s = s.replace("export const TRACK_CHANGES_LIMIT = 1000;", "export const TRACK_CHANGES_LIMIT = 20;")
open(p, "w").write(s)
PY
}

m_the_proxy_drops_the_page_size_again() {
  py <<'PY'
p = "src/api-client.ts"
s = open(p).read()
s = s.replace("  if (params.limit) p.limit = params.limit;\n", "")
open(p, "w").write(s)
PY
}

run_mutation "limit is read and not applied" m_limit_is_read_and_not_applied
run_mutation "total reports the page instead of the window" m_total_reports_the_page_not_the_window
run_mutation "offset is read and not applied" m_offset_is_read_and_not_applied
run_mutation "the singular category spelling is ignored again" m_the_singular_category_is_ignored_again
run_mutation "a filter returns a second top-level shape" m_a_filter_returns_a_second_shape
run_mutation "the period the answer covers is not named" m_the_period_is_not_named
run_mutation "an unreadable page size is ignored rather than refused" m_an_unreadable_page_size_is_ignored_rather_than_refused
run_mutation "the whole window becomes unreachable" m_the_whole_window_is_unreachable
run_mutation "the default page grows past its budget" m_the_default_page_grows_past_its_budget
run_mutation "the proxy pin truncates the window" m_the_proxy_pin_truncates_the_window
m_the_proxy_drops_the_category_filter_again() {
  py <<'PY2'
p = "src/api-client.ts"
s = open(p).read()
s = s.replace("  if (params.categories) p.categories = params.categories;\n", "")
open(p, "w").write(s)
PY2
}

run_mutation "the proxy drops the page size again" m_the_proxy_drops_the_page_size_again
run_mutation "the proxy drops the category filter again" m_the_proxy_drops_the_category_filter_again

echo ""
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
