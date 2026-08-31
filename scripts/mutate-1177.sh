#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
APPS="src/mcp-apps.ts"
SUITE="test/served-comments.test.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$APPS" "$BACKUP_DIR/mcp-apps.ts"
cp "$SUITE" "$BACKUP_DIR/suite.ts"

restore() {
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/mcp-apps.ts" "$APPS"
  cp "$BACKUP_DIR/suite.ts" "$SUITE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/served-comments.test.ts"

py() { python3 - "$@"; }

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/mcp-apps.ts" "$APPS" > /dev/null \
    && diff -q "$BACKUP_DIR/suite.ts" "$SUITE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1177-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1177-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1177-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1177-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1177-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_a_css_comment_returns_to_the_home_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(".hero{text-align:center;padding:5rem 0 3rem}",
              "/* Hero */\n.hero{text-align:center;padding:5rem 0 3rem}")
open(p, "w").write(s)
PY
}

m_a_line_comment_returns_to_a_script_block() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      var newUrl = window.location.pathname + '?s=' + encodeURIComponent(services.join(','));",
              "      // Update URL\n      var newUrl = window.location.pathname + '?s=' + encodeURIComponent(services.join(','));")
open(p, "w").write(s)
PY
}

m_a_block_comment_returns_to_a_script_block() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      var newUrl = window.location.pathname + '?s=' + encodeURIComponent(services.join(','));",
              "      /* Update URL */\n      var newUrl = window.location.pathname + '?s=' + encodeURIComponent(services.join(','));")
open(p, "w").write(s)
PY
}

m_a_comment_returns_to_the_concatenated_script() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    + '    var cost = v.starter;\\n'",
              "    + '    // use starter tier cost as baseline\\n'\n    + '    var cost = v.starter;\\n'")
open(p, "w").write(s)
PY
}

m_a_trailing_comment_returns_to_the_concatenated_script() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    + '    var cost = v.starter;\\n'",
              "    + '    var cost = v.starter; // use starter tier cost as baseline\\n'")
open(p, "w").write(s)
PY
}

m_a_comment_returns_to_the_apps_module() {
  py <<'PY'
p = "src/mcp-apps.ts"
s = open(p).read()
s = s.replace("  if (Array.isArray(data) && data[0]?.name && data[0]?.count !== undefined) {",
              "  // Category list mode\n  if (Array.isArray(data) && data[0]?.name && data[0]?.count !== undefined) {")
open(p, "w").write(s)
PY
}

m_the_scan_covers_the_whole_page_rather_than_its_markup_blocks() {
  py <<'PY'
p = "test/served-comments.test.ts"
s = open(p).read()
s = s.replace("""function commentsInServedHtml(html: string): string[] {
  const found: string[] = [];""",
              """function commentsInServedHtml(html: string): string[] {
  const found: string[] = commentsIn(html, true);""")
open(p, "w").write(s)
PY
}

m_the_route_sample_narrows_to_the_home_page() {
  py <<'PY'
p = "test/served-comments.test.ts"
s = open(p).read()
s = s.replace('  const routes = new Set<string>(["/"]);',
              '  const routes = new Set<string>(["/"]);\n  if (routes.size) return [...routes];')
open(p, "w").write(s)
PY
}

m_a_comment_returns_to_an_apps_template_literal() {
  py <<'PY'
p = "src/mcp-apps.ts"
s = open(p).read()
s = s.replace("  if (mode === \"estimate\" && (data.services || data.costs)) {",
              "  // Estimate mode\n  if (mode === \"estimate\" && (data.services || data.costs)) {")
open(p, "w").write(s)
PY
}

m_a_comment_returns_after_a_nested_template_literal() {
  py <<'PY'
p = "src/mcp-apps.ts"
s = open(p).read()
s = s.replace("  const results = data.results || [];",
              "  // Search results mode\n  const results = data.results || [];")
open(p, "w").write(s)
PY
}

m_the_app_resource_list_is_empty() {
  py <<'PY'
p = "test/served-comments.test.ts"
s = open(p).read()
s = s.replace("        .filter((uri) => uri.startsWith(\"ui://\"));",
              "        .filter((uri) => uri.startsWith(\"ui://\"))\n        .slice(0, 0);")
open(p, "w").write(s)
PY
}

run_mutation "a css comment returns to the home page" m_a_css_comment_returns_to_the_home_page
run_mutation "a line comment returns to a script block" m_a_line_comment_returns_to_a_script_block
run_mutation "a block comment returns to a script block" m_a_block_comment_returns_to_a_script_block
run_mutation "a comment returns to the script built by string concatenation" m_a_comment_returns_to_the_concatenated_script
run_mutation "a trailing comment returns to the script built by string concatenation" m_a_trailing_comment_returns_to_the_concatenated_script
run_mutation "a comment returns to the apps module" m_a_comment_returns_to_the_apps_module
run_mutation "the scan covers the whole page rather than its style and script blocks" m_the_scan_covers_the_whole_page_rather_than_its_markup_blocks
run_mutation "the route sample narrows to the home page" m_the_route_sample_narrows_to_the_home_page
run_mutation "a comment returns to a template literal inside an apps script block" m_a_comment_returns_to_an_apps_template_literal
run_mutation "a comment returns to a position that follows a nested template literal" m_a_comment_returns_after_a_nested_template_literal
run_mutation "the app resource list is empty" m_the_app_resource_list_is_empty

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
