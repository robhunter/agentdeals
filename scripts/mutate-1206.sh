#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

DATA="src/data.ts"
SERVE="src/serve.ts"
VERDICT="src/vendor-verdict.ts"
FILES=("$DATA" "$SERVE" "$VERDICT")
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
TESTS="test/one-verdict-engine.test.ts test/vendor-risk.test.ts test/risk-badge.test.ts"

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
  local name="$1"
  shift
  echo "=== $name"
  for f in "${FILES[@]}"; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1206-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1206-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1206-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1206-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_no_verdict_ever_expires() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  if (!CHANGE_IS_AN_EVENT.has(change.change_type)) return false;",
              "  if (!CHANGE_IS_AN_EVENT.has(change.change_type)) return false;\n  return false;")
open(p, "w").write(s)
PY
}

m_a_condition_verdict_expires_too() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  if (!CHANGE_IS_AN_EVENT.has(change.change_type)) return false;", "")
open(p, "w").write(s)
PY
}

m_the_window_is_open_ended() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("export const VERDICT_WINDOW_DAYS = 180;", "export const VERDICT_WINDOW_DAYS = 200000;")
open(p, "w").write(s)
PY
}

m_the_window_closes_immediately() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("export const VERDICT_WINDOW_DAYS = 180;", "export const VERDICT_WINDOW_DAYS = 0;")
open(p, "w").write(s)
PY
}

m_the_vendor_page_ignores_the_expiry() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("    const demotion = demotionInForce(c, nowMs);", "    const demotion = demotionForChange(c);")
open(p, "w").write(s)
PY
}

m_the_volatility_scale_ignores_the_expiry() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  const riskScaleActs = vendorChanges.some(c => demotionInForce(c, nowMs) !== null);",
              "  const riskScaleActs = vendorChanges.some(c => demotionForChange(c) !== null);")
open(p, "w").write(s)
PY
}

m_a_restriction_does_not_demote() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  restriction: "caution",\n  pricing_model_change: "caution",',
              '  restriction: null,\n  pricing_model_change: "caution",')
open(p, "w").write(s)
PY
}

m_a_pricing_model_change_does_not_demote() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  restriction: "caution",\n  pricing_model_change: "caution",',
              '  restriction: "caution",\n  pricing_model_change: null,')
open(p, "w").write(s)
PY
}

m_the_badge_keeps_its_own_list_of_removals() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  if (assessment.level === "risky" && assessment.cause) {
    return {
      status: "removed",
      label: assessment.cause.change_type === PRODUCT_DEPRECATED ? "deprecated" : "free tier removed",
      verifiedDate: assessment.cause.date,
    };
  }""",
"""  const removal = vendorChanges.find(c =>
    c.change_type === "free_tier_removed" || c.change_type === "product_deprecated" || c.change_type === "open_source_killed"
  );
  if (removal) {
    return { status: "removed", label: removal.change_type === "product_deprecated" ? "deprecated" : "free tier removed", verifiedDate: removal.date };
  }""")
open(p, "w").write(s)
PY
}

m_the_badge_keeps_its_own_window_on_negatives() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  if (assessment.level === "caution") {
    return { status: "at-risk", label: "at risk", verifiedDate: latestVerified };
  }""",
"""  const hasRecentNegativeChange = vendorChanges.some(c =>
    (c.change_type === "limits_reduced" || c.change_type === "pricing_restructured" || c.change_type === "pricing_model_change") &&
    Math.floor((Date.now() - new Date(c.date).getTime()) / (1000 * 60 * 60 * 24)) <= 90
  );
  if (hasRecentNegativeChange) {
    return { status: "at-risk", label: "at risk", verifiedDate: latestVerified };
  }""")
open(p, "w").write(s)
PY
}

m_the_badge_reads_stable_for_a_cautioned_vendor() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  if (assessment.level === "caution") {
    return { status: "at-risk", label: "at risk", verifiedDate: latestVerified };
  }""", "")
open(p, "w").write(s)
PY
}

m_a_stable_verdict_lists_the_types_it_rules_out() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace("  return `We rate it stable. ${narrowingSentence(input.changes)}`;",
              "  return `We rate it stable — we hold no free tier removal, limit reduction or pricing restructure for this vendor. ${narrowingSentence(input.changes)}`;")
open(p, "w").write(s)
PY
}

run_mutation "no verdict ever expires" m_no_verdict_ever_expires
run_mutation "a condition verdict expires too" m_a_condition_verdict_expires_too
run_mutation "the window never closes" m_the_window_is_open_ended
run_mutation "the window closes immediately" m_the_window_closes_immediately
run_mutation "the vendor page ignores the expiry" m_the_vendor_page_ignores_the_expiry
run_mutation "the volatility scale ignores the expiry" m_the_volatility_scale_ignores_the_expiry
run_mutation "a restriction does not demote" m_a_restriction_does_not_demote
run_mutation "a pricing model change does not demote" m_a_pricing_model_change_does_not_demote
run_mutation "the badge keeps its own list of removals" m_the_badge_keeps_its_own_list_of_removals
run_mutation "the badge keeps its own window on negatives" m_the_badge_keeps_its_own_window_on_negatives
run_mutation "the badge reads stable for a cautioned vendor" m_the_badge_reads_stable_for_a_cautioned_vendor
run_mutation "a stable verdict lists the types it rules out" m_a_stable_verdict_lists_the_types_it_rules_out

restore
echo
echo "killed: $killed   survived: $survived"
[ "$survived" -eq 0 ]
