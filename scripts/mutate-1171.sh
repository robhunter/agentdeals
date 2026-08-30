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
TESTS="test/homepage-past-tense-changes.test.ts test/change-structured-data.test.ts"

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
  if ! npm run build > /tmp/mutate-1171-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1171-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1171-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1171-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1171-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_past_tense_list_stops_filtering() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const recentChanges = [...dealChanges]\n  .filter(hasAlreadyTakenEffect)",
              "const recentChanges = [...dealChanges]\n  .filter(() => true)")
open(p, "w").write(s)
PY
}

m_a_change_taking_effect_today_counts_as_future() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const hasAlreadyTakenEffect = (c: { date: string }) => c.date <= today;",
              "const hasAlreadyTakenEffect = (c: { date: string }) => c.date < today;")
open(p, "w").write(s)
PY
}

m_the_boundary_is_inverted() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const hasAlreadyTakenEffect = (c: { date: string }) => c.date <= today;",
              "const hasAlreadyTakenEffect = (c: { date: string }) => c.date >= today;")
open(p, "w").write(s)
PY
}

m_the_filter_runs_after_the_list_is_cut() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const recentChanges = [...dealChanges]\n  .filter(hasAlreadyTakenEffect)\n  .sort((a, b) => b.date.localeCompare(a.date))\n  .slice(0, 5);",
              "const recentChanges = [...dealChanges]\n  .sort((a, b) => b.date.localeCompare(a.date))\n  .slice(0, 5)\n  .filter(hasAlreadyTakenEffect);")
open(p, "w").write(s)
PY
}

m_the_countdown_list_is_filled_from_past_changes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  .filter((c) => !hasAlreadyTakenEffect(c))",
              "  .filter((c) => hasAlreadyTakenEffect(c))")
open(p, "w").write(s)
PY
}

m_today_is_read_as_tomorrow() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const today = new Date().toISOString().slice(0, 10);\nconst hasAlreadyTakenEffect",
              "const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);\nconst hasAlreadyTakenEffect")
open(p, "w").write(s)
PY
}

m_today_is_read_as_yesterday() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const today = new Date().toISOString().slice(0, 10);\nconst hasAlreadyTakenEffect",
              "const today = new Date(Date.now() - 86400000).toISOString().slice(0, 10);\nconst hasAlreadyTakenEffect")
open(p, "w").write(s)
PY
}

m_the_past_tense_list_is_ordered_oldest_first() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  .filter(hasAlreadyTakenEffect)\n  .sort((a, b) => b.date.localeCompare(a.date))",
              "  .filter(hasAlreadyTakenEffect)\n  .sort((a, b) => a.date.localeCompare(b.date))")
open(p, "w").write(s)
PY
}

m_the_past_tense_list_is_cut_to_three() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  .filter(hasAlreadyTakenEffect)\n  .sort((a, b) => b.date.localeCompare(a.date))\n  .slice(0, 5);",
              "  .filter(hasAlreadyTakenEffect)\n  .sort((a, b) => b.date.localeCompare(a.date))\n  .slice(0, 3);")
open(p, "w").write(s)
PY
}

m_the_advertised_total_counts_every_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    numberOfItems: recentChanges.length,",
              "    numberOfItems: dealChanges.slice(0, 5).length,")
open(p, "w").write(s)
PY
}

m_the_structured_data_is_drawn_from_every_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    itemListElement: recentChanges.map((c, i) => ({",
              "    itemListElement: [...dealChanges].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((c, i) => ({")
open(p, "w").write(s)
PY
}

m_the_whats_changed_section_is_drawn_from_every_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("function buildChangesHtml(): string {\n  return recentChanges.map((c) => {",
              "function buildChangesHtml(): string {\n  return [...dealChanges].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((c) => {")
open(p, "w").write(s)
PY
}

m_the_fresh_intel_section_is_drawn_from_every_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const entries = recentChanges.map((c) => {",
              "  const entries = [...dealChanges].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((c) => {")
open(p, "w").write(s)
PY
}

run_mutation "the past-tense list stops filtering out changes that have not taken effect" m_the_past_tense_list_stops_filtering
run_mutation "a change taking effect today is treated as not yet taken effect" m_a_change_taking_effect_today_counts_as_future
run_mutation "the boundary is inverted so only future changes count as taken effect" m_the_boundary_is_inverted
run_mutation "the filter runs after the list has already been cut to five" m_the_filter_runs_after_the_list_is_cut
run_mutation "the countdown list is filled from changes that have already taken effect" m_the_countdown_list_is_filled_from_past_changes
run_mutation "today is read as tomorrow, so a change one day out counts as past" m_today_is_read_as_tomorrow
run_mutation "today is read as yesterday, so a change taking effect today is still counted down to" m_today_is_read_as_yesterday
run_mutation "the past-tense list is ordered oldest first" m_the_past_tense_list_is_ordered_oldest_first
run_mutation "the past-tense list is cut to three entries" m_the_past_tense_list_is_cut_to_three
run_mutation "the advertised total counts every change rather than the rendered list" m_the_advertised_total_counts_every_change
run_mutation "the structured data entries are drawn from every change rather than the rendered list" m_the_structured_data_is_drawn_from_every_change
run_mutation "the What's Changed section is drawn from every change rather than the filtered list" m_the_whats_changed_section_is_drawn_from_every_change
run_mutation "the Fresh Intel section is drawn from every change rather than the filtered list" m_the_fresh_intel_section_is_drawn_from_every_change

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
