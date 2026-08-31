#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

DATA="src/data.ts"
SERVE="src/serve.ts"
SUITE="test/weekly-window-provenance.test.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$DATA" "$BACKUP_DIR/data.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$SUITE" "$BACKUP_DIR/suite.ts"

restore() {
  cp "$BACKUP_DIR/data.ts" "$DATA"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/suite.ts" "$SUITE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/weekly-window-provenance.test.ts"

py() { python3 - "$@"; }

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/data.ts" "$DATA" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/suite.ts" "$SUITE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1184-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1184-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1184-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1184-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1184-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_headline_counts_the_discovery_batch_as_changes() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("across ${weekChanges.length} developer tool pricing change",
              "across ${weekChanges.length + weekDiscovered.length} developer tool pricing change")
open(p, "w").write(s)
PY
}

m_the_discovery_batch_loses_its_own_heading() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("    mdSections.push(`## ${firstReadHeading(weekDiscovered.length)}`);",
              "    mdSections.push(`## Other Notable Changes`);")
open(p, "w").write(s)
PY
}

m_a_week_with_no_discovery_batch_still_gets_the_sentence() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('const discoveryNote = weekDiscovered.length > 0 ? discoveryBatchNote(weekDiscovered.length, `during ${dateLabel}`) : "";',
              'const discoveryNote = discoveryBatchNote(weekDiscovered.length, `during ${dateLabel}`);')
open(p, "w").write(s)
PY
}

m_this_week_names_a_discovery_batch_it_does_not_have() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const firstReadHtml = digest.discovered_in_week > 0",
              "const firstReadHtml = digest.discovered_in_week >= 0")
open(p, "w").write(s)
PY
}

m_the_feed_drops_the_entry_that_carries_the_correction() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('${[...corrections, ...weekEntries].join("\\n")}',
              '${[...weekEntries].join("\\n")}')
open(p, "w").write(s)
PY
}

m_the_feed_publishes_a_week_that_tracked_no_change() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      if (digest.top_changes.length === 0) continue;\n", "")
open(p, "w").write(s)
PY
}

m_the_feed_reaches_further_back_than_it_publishes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    for (let w = 0; w < 4; w++) {\n      const digest = getFormattedWeeklyDigest(w, 50);",
              "    for (let w = 0; w < 12; w++) {\n      const digest = getFormattedWeeklyDigest(w, 50);")
open(p, "w").write(s)
PY
}

m_a_change_that_has_not_taken_effect_is_reported_as_tracked() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("    ? { start: thirtyDaysAgo, end: today }\n    : weekWindow;",
              "    ? { start: thirtyDaysAgo }\n    : weekWindow;")
open(p, "w").write(s)
PY
}

m_the_summary_opens_with_a_count_it_did_not_return() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("parts.push(`${changes.length} pricing change${changes.length !== 1 ? \"s\" : \"\"} with a known effective date tracked",
              "parts.push(`${changes.length + 1} pricing change${changes.length !== 1 ? \"s\" : \"\"} with a known effective date tracked")
open(p, "w").write(s)
PY
}

run_mutation "the headline counts the discovery batch as changes" m_the_headline_counts_the_discovery_batch_as_changes
run_mutation "the discovery batch loses its own heading" m_the_discovery_batch_loses_its_own_heading
run_mutation "a week with no discovery batch still gets the sentence" m_a_week_with_no_discovery_batch_still_gets_the_sentence
run_mutation "/this-week names a discovery batch it does not have" m_this_week_names_a_discovery_batch_it_does_not_have
run_mutation "the feed drops the entry that carries the correction" m_the_feed_drops_the_entry_that_carries_the_correction
run_mutation "the feed publishes a week that tracked no change" m_the_feed_publishes_a_week_that_tracked_no_change
run_mutation "the feed reaches further back than it publishes" m_the_feed_reaches_further_back_than_it_publishes
run_mutation "a change that has not taken effect is reported as tracked" m_a_change_that_has_not_taken_effect_is_reported_as_tracked
run_mutation "the summary opens with a count it did not return" m_the_summary_opens_with_a_count_it_did_not_return

restore
npm run build > /dev/null 2>&1
echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
