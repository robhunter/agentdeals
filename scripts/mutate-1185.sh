#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/served-scripts.test.ts"

py() { python3 - "$@"; }

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1185-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1185-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1185-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1185-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1185-test.log | head -3
    killed=$((killed + 1))
  fi
}

replace() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
old = """$1"""
new = """$2"""
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_the_unterminated_literal_returns_to_the_budget_builder() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = """    + '  document.getElementById("summary-cards").innerHTML =\\n'
    + '    \\'<div class="summary-card"><div class="value">$\\' + totalCost + \\'</div><div class="label">Total Monthly Cost</div></div>\\'\\n'
    + '    + \\'<div class="summary-card"><div class="value">\\' + totalServices + \\'</div><div class="label">Services</div></div>\\'\\n'
    + '    + \\'<div class="summary-card"><div class="value">\\' + freeCount + \\'</div><div class="label">Free Services</div></div>\\'\\n'
    + '    + \\'<div class="summary-card"><div class="value">\\' + (totalServices - freeCount) + \\'</div><div class="label">Paid Services</div></div>\\';\\n'"""
new = """    + '  document.getElementById("summary-cards").innerHTML = \\'\\n'
    + '    <div class="summary-card"><div class="value">$\\' + totalCost + \\'</div><div class="label">Total Monthly Cost</div></div>\\n'
    + '    <div class="summary-card"><div class="value">\\' + totalServices + \\'</div><div class="label">Services</div></div>\\n'
    + '    <div class="summary-card"><div class="value">\\' + freeCount + \\'</div><div class="label">Free Services</div></div>\\n'
    + '    <div class="summary-card"><div class="value">\\' + (totalServices - freeCount) + \\'</div><div class="label">Paid Services</div></div>\\n'
    + '  \\';\\n'"""
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_an_unparseable_block_reaches_the_vendor_index() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = '  var input = document.getElementById("vendor-search");'
new = '  var input = document.getElementById("vendor-search";'
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_an_unparseable_block_reaches_the_navigation_on_every_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "var hamburger=document.querySelector('.nav-hamburger');"
new = "var hamburger=document.querySelector('.nav-hamburger';"
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_an_unparseable_block_reaches_the_stack_checker() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "function checkStack("
new = "function checkStack(("
if s.count(old) < 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new, 1))
PY
}

m_a_summary_card_loses_its_label() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = '<div class="label">Free Services</div>'
new = '<div class="label">Freebies</div>'
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_the_free_and_paid_counts_swap() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = """    + '    + \\'<div class="summary-card"><div class="value">\\' + freeCount + \\'</div><div class="label">Free Services</div></div>\\'\\n'
    + '    + \\'<div class="summary-card"><div class="value">\\' + (totalServices - freeCount) + \\'</div><div class="label">Paid Services</div></div>\\';\\n'"""
new = """    + '    + \\'<div class="summary-card"><div class="value">\\' + (totalServices - freeCount) + \\'</div><div class="label">Free Services</div></div>\\'\\n'
    + '    + \\'<div class="summary-card"><div class="value">\\' + freeCount + \\'</div><div class="label">Paid Services</div></div>\\';\\n'"""
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_one_category_drops_out_of_the_stack() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "  catKeys.forEach(function(catId) {\\n'\n    + '    var rec = recommendVendor(catId, selectedBudget);\\n'\n    + '    if (!rec) return;\\n'"
new = "  catKeys.slice(1).forEach(function(catId) {\\n'\n    + '    var rec = recommendVendor(catId, selectedBudget);\\n'\n    + '    if (!rec) return;\\n'"
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_the_zero_budget_bar_stops_saying_so() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = 'selectedBudget === 0 ? "Free tier only" : "of $"'
new = 'selectedBudget === 0 ? "No budget set" : "of $"'
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_a_control_calls_a_function_the_page_never_defines() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "'function toggleCategory(catId) {\\n'"
new = "'function toggleCategoryImpl(catId) {\\n'"
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_the_shared_link_drops_the_categories_it_encodes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = '"/budget-builder?budget=" + selectedBudget + "&categories=" + Array.from(selectedCategories).join(",")'
new = '"/budget-builder?budget=" + selectedBudget'
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_the_builder_runs_before_a_category_is_chosen() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "  if (cats) {\\n'"
new = "  if (cats !== undefined) {\\n'"
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

m_the_stack_stops_rendering_a_card_per_category() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "    stackHtml += \\'<div class=\"stack-card\">\\';"
new = "    stackHtml += \\'<div class=\"stack-tile\">\\';"
if s.count(old) != 1:
    raise SystemExit("anchor appears " + str(s.count(old)) + " times")
open(p, "w").write(s.replace(old, new))
PY
}

run_mutation "the unterminated literal returns to the budget builder" m_the_unterminated_literal_returns_to_the_budget_builder
run_mutation "an unparseable block reaches the vendor index" m_an_unparseable_block_reaches_the_vendor_index
run_mutation "an unparseable block reaches the navigation on every page" m_an_unparseable_block_reaches_the_navigation_on_every_page
run_mutation "an unparseable block reaches the stack checker" m_an_unparseable_block_reaches_the_stack_checker
run_mutation "a summary card loses its label" m_a_summary_card_loses_its_label
run_mutation "the free and paid counts swap" m_the_free_and_paid_counts_swap
run_mutation "one category drops out of the stack" m_one_category_drops_out_of_the_stack
run_mutation "the zero budget bar stops saying so" m_the_zero_budget_bar_stops_saying_so
run_mutation "a control calls a function the page never defines" m_a_control_calls_a_function_the_page_never_defines
run_mutation "the shared link drops the categories it encodes" m_the_shared_link_drops_the_categories_it_encodes
run_mutation "the builder runs before a category is chosen" m_the_builder_runs_before_a_category_is_chosen
run_mutation "the stack stops rendering a card per category" m_the_stack_stops_rendering_a_card_per_category

restore
npm run build > /dev/null 2>&1
echo
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
