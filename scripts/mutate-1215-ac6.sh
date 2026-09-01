#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

ELIGIBILITY="src/eligibility.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$ELIGIBILITY" "$BACKUP_DIR/eligibility.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/eligibility.ts" "$ELIGIBILITY"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  npx tsc > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/eligibility-disclosure.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$ELIGIBILITY" "$SERVE"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1215-ac6-build.log 2>&1; then
    echo "    KILLED: does not compile"
    killed=$((killed + 1))
    return
  fi
  if timeout 600 node --test $TESTS > /tmp/mutate-1215-ac6-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1215-ac6-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1215-ac6-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_lede_never_qualifies() {
  py <<'PY'
p = "src/eligibility.ts"
s = open(p).read()
s = s.replace("  if (gated === 0) return `${counted}.`;", "  if (gated >= 0) return `${counted}.`;")
open(p, "w").write(s)
PY
}

m_lede_always_qualifies() {
  py <<'PY'
p = "src/eligibility.ts"
s = open(p).read()
s = s.replace("  if (gated === 0) return `${counted}.`;", "")
open(p, "w").write(s)
PY
}

m_lede_counts_the_whole_category() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${gatedShareLede(catCount, catGatedCount)}", "${gatedShareLede(catCount, catCount)}")
open(p, "w").write(s)
PY
}

m_lede_states_a_partial_share_as_total() {
  py <<'PY'
p = "src/eligibility.ts"
s = open(p).read()
s = s.replace("  if (gated >= total) return `${counted}, none of them generally available",
              "  if (gated >= 1) return `${counted}, none of them generally available")
open(p, "w").write(s)
PY
}

m_description_clause_removed() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${catGatedClause ? ` ${catGatedClause}` : \"\"}", "")
open(p, "w").write(s)
PY
}

m_description_clause_appended_last() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
old = "developer deals.${catGatedClause ? ` ${catGatedClause}` : \"\"} Verified pricing for ${catOffers.slice(0, 5).map(o => o.vendor).join(\", \")}${catCount > 5 ? \" and more\" : \"\"}.`;"
new = "developer deals. Verified pricing for ${catOffers.slice(0, 5).map(o => o.vendor).join(\", \")}${catCount > 5 ? \" and more\" : \"\"}.${catGatedClause ? ` ${catGatedClause}` : \"\"}`;"
assert old in s
s = s.replace(old, new)
open(p, "w").write(s)
PY
}

m_tier_answer_drops_the_gate() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    : eligibilityGateSentence + (levelWithheld\n    ? `${unconfirmedTermsPreamble}Our stored record calls",
              "    : \"\" + (levelWithheld\n    ? `${unconfirmedTermsPreamble}Our stored record calls")
open(p, "w").write(s)
PY
}

m_production_answer_drops_the_gate() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const faqProductionAnswer = eligibilityGateSentence + (levelWithheld",
              "  const faqProductionAnswer = \"\" + (levelWithheld")
open(p, "w").write(s)
PY
}

m_gate_spreads_to_the_stability_answer() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("{ q: `Is ${vendorName}'s free tier reliable?`, a: faqReliableAnswer }",
              "{ q: `Is ${vendorName}'s free tier reliable?`, a: faqProductionAnswer }")
open(p, "w").write(s)
PY
}

run_mutation "the lede never qualifies the count" m_lede_never_qualifies
run_mutation "the lede qualifies every category" m_lede_always_qualifies
run_mutation "the lede counts the whole category as gated" m_lede_counts_the_whole_category
run_mutation "a partial share reads as the whole category" m_lede_states_a_partial_share_as_total
run_mutation "the search snippet drops the qualification" m_description_clause_removed
run_mutation "the search snippet appends it after the vendor list" m_description_clause_appended_last
run_mutation "the free-tier terms answer drops the gate" m_tier_answer_drops_the_gate
run_mutation "the production answer drops the gate" m_production_answer_drops_the_gate
run_mutation "the gate spreads to the stability answer" m_gate_spreads_to_the_stability_answer

echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
