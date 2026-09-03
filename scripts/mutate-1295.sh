#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/change-resolution.ts src/vendor-verdict.ts test/one-verdict-engine.test.ts test/risk-badge.test.ts test/enrich.test.ts test/vendor-verdict.test.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$(echo "$f")"; done
  npm run build > /dev/null 2>&1
}

restore_paths() {
  cp "$BACKUP_DIR/change-resolution.ts" src/change-resolution.ts
  cp "$BACKUP_DIR/vendor-verdict.ts" src/vendor-verdict.ts
  cp "$BACKUP_DIR/one-verdict-engine.test.ts" test/one-verdict-engine.test.ts
  cp "$BACKUP_DIR/risk-badge.test.ts" test/risk-badge.test.ts
  cp "$BACKUP_DIR/enrich.test.ts" test/enrich.test.ts
  cp "$BACKUP_DIR/vendor-verdict.test.ts" test/vendor-verdict.test.ts
}

trap 'restore_paths; npm run build > /dev/null 2>&1' EXIT

killed=0
survived=0
TESTS="test/one-verdict-engine.test.ts test/risk-badge.test.ts test/enrich.test.ts test/vendor-verdict.test.ts test/change-resolution.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore_paths
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
  if ! npm run build > /tmp/mutate-1295-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1295-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1295-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1295-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_nothing_is_ever_no_longer_in_force() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''export function isNoLongerInForce(change: { resolution?: ChangeResolution | null }): boolean {
  return Boolean(change.resolution);
}''', '''export function isNoLongerInForce(change: { resolution?: ChangeResolution | null }): boolean {
  return false;
}''')
open(p, "w").write(s)
PY
}

m_everything_is_no_longer_in_force() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''export function isNoLongerInForce(change: { resolution?: ChangeResolution | null }): boolean {
  return Boolean(change.resolution);
}''', '''export function isNoLongerInForce(change: { resolution?: ChangeResolution | null }): boolean {
  return true;
}''')
open(p, "w").write(s)
PY
}

m_one_verdict_stops_exempting_a_withdrawal() {
  py <<'PY'
p = "test/one-verdict-engine.test.ts"
s = open(p).read()
s = s.replace("  if (isNoLongerInForce(change)) return false;\n", "")
open(p, "w").write(s)
PY
}

m_one_verdict_exempts_every_removal() {
  py <<'PY'
p = "test/one-verdict-engine.test.ts"
s = open(p).read()
s = s.replace("  if (isNoLongerInForce(change)) return false;",
              "  if (isNoLongerInForce(change) || change.change_type === \"free_tier_removed\") return false;")
open(p, "w").write(s)
PY
}

m_one_verdict_drops_its_vacuity_guard() {
  py <<'PY'
p = "test/one-verdict-engine.test.ts"
s = open(p).read()
s = s.replace('    assert.ok(checked > 0, "no vendor holds a record that points down, so this asserts nothing");\n', "")
s = s.replace("  if (isNoLongerInForce(change)) return false;",
              "  if (true) return false;")
open(p, "w").write(s)
PY
}

m_risk_badge_stops_exempting_a_withdrawal() {
  py <<'PY'
p = "test/risk-badge.test.ts"
s = open(p).read()
s = s.replace("""      const narrowing = changes.filter(
        (c) => NEGATIVE_CHANGE_TYPES.has(c.change_type) && !isNoLongerInForce(c as never),
      ).length;""",
"""      const narrowing = changes.filter(
        (c) => NEGATIVE_CHANGE_TYPES.has(c.change_type),
      ).length;""")
s = s.replace('    const counts = (c: Change) => NEGATIVE_CHANGE_TYPES.has(c.change_type) && !isNoLongerInForce(c as never);',
              '    const counts = (c: Change) => NEGATIVE_CHANGE_TYPES.has(c.change_type);')
open(p, "w").write(s)
PY
}

m_risk_badge_counts_no_narrowing_at_all() {
  py <<'PY'
p = "test/risk-badge.test.ts"
s = open(p).read()
s = s.replace("""      const narrowing = changes.filter(
        (c) => NEGATIVE_CHANGE_TYPES.has(c.change_type) && !isNoLongerInForce(c as never),
      ).length;""",
"""      const narrowing = changes.filter(
        (c) => NEGATIVE_CHANGE_TYPES.has(c.change_type) && false,
      ).length;""")
open(p, "w").write(s)
PY
}

m_enrich_admits_a_standing_narrowing() {
  py <<'PY'
p = "test/enrich.test.ts"
s = open(p).read()
s = s.replace("      FAVOURABLE.has(c.change_type) || isNoLongerInForce(c as never);",
              "      FAVOURABLE.has(c.change_type) || true;")
open(p, "w").write(s)
PY
}

m_vendor_verdict_stops_exempting_a_withdrawal() {
  py <<'PY'
p = "test/vendor-verdict.test.ts"
s = open(p).read()
s = s.replace('  CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c);',
              '  CHANGE_DIRECTION[c.change_type] === "negative";')
open(p, "w").write(s)
PY
}

m_the_verdict_sentence_counts_a_withdrawn_narrowing() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c))',
              '    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative")')
open(p, "w").write(s)
PY
}

m_the_verdict_sentence_counts_no_narrowing_at_all() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c))',
              '    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative" && false)')
open(p, "w").write(s)
PY
}

m_the_verdict_input_drops_the_resolution_again() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  changes: Array<Pick<DealChange, "date" | "date_source" | "change_type"> & { resolution?: DealChange["resolution"] }>;',
              '  changes: Array<Pick<DealChange, "date" | "date_source" | "change_type">>;')
open(p, "w").write(s)
PY
}

run_mutation "the predicate the exemptions ride on never fires" m_nothing_is_ever_no_longer_in_force
run_mutation "the predicate the exemptions ride on always fires" m_everything_is_no_longer_in_force
run_mutation "one-verdict-engine counts a withdrawn record again" m_one_verdict_stops_exempting_a_withdrawal
run_mutation "one-verdict-engine exempts every removal, not only a withdrawn one" m_one_verdict_exempts_every_removal
run_mutation "one-verdict-engine exempts everything and drops its vacuity guard" m_one_verdict_drops_its_vacuity_guard
run_mutation "risk-badge counts a withdrawn narrowing again" m_risk_badge_stops_exempting_a_withdrawal
run_mutation "risk-badge counts no narrowing at all" m_risk_badge_counts_no_narrowing_at_all
run_mutation "enrich requires a stable verdict over a standing narrowing" m_enrich_admits_a_standing_narrowing
run_mutation "the vendor page may establish a narrowing from a withdrawn record" m_vendor_verdict_stops_exempting_a_withdrawal
run_mutation "the verdict sentence counts a withdrawn record as a narrowing" m_the_verdict_sentence_counts_a_withdrawn_narrowing
run_mutation "the verdict sentence counts no narrowing at all" m_the_verdict_sentence_counts_no_narrowing_at_all
run_mutation "the verdict input drops the resolution from its projection again" m_the_verdict_input_drops_the_resolution_again

echo
echo "killed: $killed  survived: $survived"
