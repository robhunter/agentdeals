#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

ROLE="src/product-role.ts"
SERVE="src/serve.ts"
FILES=("$ROLE" "$SERVE")
BACKUP_DIR="$(mktemp -d)"
for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "${FILES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
  npx tsc > /dev/null 2>&1
}
trap 'restore' EXIT

killed=0
survived=0
ROLE_TESTS="test/product-role.test.ts"
PAGE_TESTS="test/product-role.test.ts test/alternatives-membership.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "${FILES[@]}"; do
    if ! diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null; then
      return 0
    fi
  done
  return 1
}

run_mutation() {
  local tests="$1"
  local name="$2"
  shift 2
  echo "=== $name"
  for f in "${FILES[@]}"; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1212-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $tests > /tmp/mutate-1212-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1212-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1212-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_category_declares_no_taxonomy() {
  py <<'PY'
import re
p = "src/product-role.ts"
s = open(p).read()
s = re.sub(r'  Monitoring: \[\n(?:    \{ subtype:.*\n)+  \],\n', '', s, count=1)
open(p, "w").write(s)
PY
}

m_one_function_is_left_undeclared() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = "\n".join(l for l in s.split("\n") if 'subtype: "page_change_watch"' not in l)
open(p, "w").write(s)
PY
}

m_a_function_is_declared_without_a_definition() {
  py <<'PY'
import re
p = "src/product-role.ts"
s = open(p).read()
s = re.sub(r'(\{ subtype: "synthetic_check", definition: )"[^"]*"', r'\1""', s, count=1)
open(p, "w").write(s)
PY
}

m_a_function_is_declared_under_another_name() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('{ subtype: "uptime_check", definition:', '{ subtype: "uptime_checks", definition:', 1)
open(p, "w").write(s)
PY
}

m_the_category_declares_no_membership_group() {
  py <<'PY'
import re
p = "src/product-role.ts"
s = open(p).read()
s = re.sub(r'  Monitoring: \[\n    \{\n      subtypes: \["host_metrics".*\n      rule: "A reader leaving one of these.*\n    \},\n  \],\n', '', s, count=1)
open(p, "w").write(s)
PY
}

m_exception_grouping_joins_the_group() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('subtypes: ["host_metrics", "apm_traces", "log_management", "metrics_backend", "dashboards"],',
              'subtypes: ["host_metrics", "apm_traces", "log_management", "metrics_backend", "dashboards", "error_tracking"],')
open(p, "w").write(s)
PY
}

m_the_view_is_left_out_of_the_group() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('subtypes: ["host_metrics", "apm_traces", "log_management", "metrics_backend", "dashboards"],',
              'subtypes: ["host_metrics", "apm_traces", "log_management", "metrics_backend"],')
open(p, "w").write(s)
PY
}

m_the_group_admits_a_subtype_from_any_category() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("export function membershipGroupsFor(taxonomy: string): SubtypeMembershipGroup[] {\n  return SUBTYPE_MEMBERSHIP_GROUPS[taxonomy] ?? [];\n}",
              "export function membershipGroupsFor(taxonomy: string): SubtypeMembershipGroup[] {\n  return Object.values(SUBTYPE_MEMBERSHIP_GROUPS).flat();\n}")
open(p, "w").write(s)
PY
}

m_the_criteria_page_publishes_two_taxonomies() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const subtypeTaxonomyTables = Object.entries(SUBTYPE_TAXONOMIES).map(",
              "const subtypeTaxonomyTables = Object.entries(SUBTYPE_TAXONOMIES).slice(0, 2).map(")
open(p, "w").write(s)
PY
}

m_the_criteria_page_states_no_coverage_for_the_newest_taxonomy() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const parts = Object.keys(SUBTYPE_TAXONOMIES).map(taxonomy => {",
              "const parts = Object.keys(SUBTYPE_TAXONOMIES).slice(0, 2).map(taxonomy => {")
open(p, "w").write(s)
PY
}

run_mutation "$ROLE_TESTS" "the category declares no taxonomy" m_the_category_declares_no_taxonomy
run_mutation "$ROLE_TESTS" "one function is left undeclared" m_one_function_is_left_undeclared
run_mutation "$ROLE_TESTS" "a function is declared without a definition" m_a_function_is_declared_without_a_definition
run_mutation "$ROLE_TESTS" "a function is declared under another name" m_a_function_is_declared_under_another_name
run_mutation "$ROLE_TESTS" "the category declares no membership group" m_the_category_declares_no_membership_group
run_mutation "$ROLE_TESTS" "exception grouping joins the group" m_exception_grouping_joins_the_group
run_mutation "$ROLE_TESTS" "the view is left out of the group" m_the_view_is_left_out_of_the_group
run_mutation "$ROLE_TESTS" "the group admits a subtype from any category" m_the_group_admits_a_subtype_from_any_category
run_mutation "$PAGE_TESTS" "the criteria page publishes two taxonomies" m_the_criteria_page_publishes_two_taxonomies
run_mutation "$PAGE_TESTS" "the criteria page states no coverage for the newest taxonomy" m_the_criteria_page_states_no_coverage_for_the_newest_taxonomy

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
