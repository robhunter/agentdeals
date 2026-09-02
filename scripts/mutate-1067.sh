#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/change-lineup.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/change-lineup.test.ts"

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
  if ! npm run build > /tmp/mutate-1067-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1067-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1067-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1067-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_one_price_is_a_lineup() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace("export const PRICES_THAT_MAKE_A_LINEUP = 2;", "export const PRICES_THAT_MAKE_A_LINEUP = 1;")
open(p, "w").write(s)
PY
}

m_three_prices_make_a_lineup() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace("export const PRICES_THAT_MAKE_A_LINEUP = 2;", "export const PRICES_THAT_MAKE_A_LINEUP = 3;")
open(p, "w").write(s)
PY
}

m_repeated_price_counts_twice() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "  return new Set(text.match(PRICE_TOKEN) ?? []);",
  "  return new Set((text.match(PRICE_TOKEN) ?? []).map((m, i) => `${m}#${i}`));")
open(p, "w").write(s)
PY
}

m_reads_only_the_summary() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "  const text = [change.summary, change.current_state].filter(Boolean).join(\" \");",
  "  const text = [change.summary].filter(Boolean).join(\" \");")
open(p, "w").write(s)
PY
}

m_reads_only_the_current_state() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "  const text = [change.summary, change.current_state].filter(Boolean).join(\" \");",
  "  const text = [change.current_state].filter(Boolean).join(\" \");")
open(p, "w").write(s)
PY
}

m_a_correction_states_a_vendor_lineup() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace("  if (change.change_type === NOT_A_VENDOR_CHANGE) return false;\n", "")
open(p, "w").write(s)
PY
}

m_price_needs_no_digit() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace("const PRICE_TOKEN = /\\$\\d[\\d,]*(?:\\.\\d+)?/g;", "const PRICE_TOKEN = /\\$\\d*/g;")
open(p, "w").write(s)
PY
}

m_price_stops_at_the_decimal_point() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace("const PRICE_TOKEN = /\\$\\d[\\d,]*(?:\\.\\d+)?/g;", "const PRICE_TOKEN = /\\$\\d[\\d,]*/g;")
open(p, "w").write(s)
PY
}

m_any_other_record_supersedes_regardless_of_date() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "    if (newest !== change && newest.date > change.date) superseded.set(change, newest);",
  "    if (newest !== change) superseded.set(change, newest);")
open(p, "w").write(s)
PY
}

m_the_oldest_lineup_is_the_current_one() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "    if (!held || change.date > held.date) newestByVendor.set(change.vendor, change);",
  "    if (!held || change.date < held.date) newestByVendor.set(change.vendor, change);")
open(p, "w").write(s)
PY
}

m_lineups_supersede_across_vendors() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace("newestByVendor.get(change.vendor)!", "[...newestByVendor.values()].sort((a, b) => (a.date < b.date ? 1 : -1))[0]")
s = s.replace(
  "    const held = newestByVendor.get(change.vendor);\n    if (!held || change.date > held.date) newestByVendor.set(change.vendor, change);",
  "    const held = newestByVendor.get(change.vendor);\n    if (!held || change.date > held.date) newestByVendor.set(change.vendor, change);")
open(p, "w").write(s)
PY
}

m_records_stating_no_lineup_get_marked_too() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "  for (const change of changes) {\n    if (!statesAPlanLineup(change)) continue;\n    const newest = newestByVendor.get(change.vendor)!;",
  "  for (const change of changes) {\n    const newest = newestByVendor.get(change.vendor);\n    if (!newest) continue;")
open(p, "w").write(s)
PY
}

m_the_note_names_no_date() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  "  return `Superseded by our ${formatDate(newest.date)} record`;",
  "  return \"Superseded by a later record\";")
open(p, "w").write(s)
PY
}

m_the_timeline_date_drops_the_year() {
  py <<'PY'
p = "src/change-lineup.ts"
s = open(p).read()
s = s.replace(
  '{ month: "short", day: "numeric", year: "numeric" }',
  '{ month: "short", day: "numeric" }')
open(p, "w").write(s)
PY
}

run_mutation "one price is a lineup" m_one_price_is_a_lineup
run_mutation "three prices are needed for a lineup" m_three_prices_make_a_lineup
run_mutation "the same price named twice counts twice" m_repeated_price_counts_twice
run_mutation "prices are read from the summary only" m_reads_only_the_summary
run_mutation "prices are read from the current state only" m_reads_only_the_current_state
run_mutation "a correction to our own record states a vendor lineup" m_a_correction_states_a_vendor_lineup
run_mutation "a dollar sign with no digit is a price" m_price_needs_no_digit
run_mutation "a price stops at the decimal point" m_price_stops_at_the_decimal_point
run_mutation "a same-dated record supersedes its twin" m_any_other_record_supersedes_regardless_of_date
run_mutation "the oldest lineup is the current one" m_the_oldest_lineup_is_the_current_one
run_mutation "a record stating no lineup is marked too" m_records_stating_no_lineup_get_marked_too
run_mutation "the note names no date" m_the_note_names_no_date
run_mutation "the timeline date drops the year" m_the_timeline_date_drops_the_year

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
