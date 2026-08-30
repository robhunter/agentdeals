#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

LEDGER="src/ledger.ts"
CODES="src/referral-codes.ts"
SERVE="src/serve.ts"
SERVER="src/server.ts"
ATTRIB="src/referral-attribution.ts"
BACKUP_DIR="$(mktemp -d)"
for f in "$LEDGER" "$CODES" "$SERVE" "$SERVER" "$ATTRIB"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "$LEDGER" "$CODES" "$SERVE" "$SERVER" "$ATTRIB"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
}
trap 'restore; npm run build > /dev/null 2>&1' EXIT

killed=0
survived=0
TESTS="test/ledger.test.ts test/ranking-leaderboard.test.ts test/payout.test.ts test/marketplace-dashboard.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "$LEDGER" "$CODES" "$SERVE" "$SERVER" "$ATTRIB"; do
    if ! diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null; then
      return 0
    fi
  done
  return 1
}

run_mutation() {
  local name="$1"
  shift
  local scope="$TESTS"
  if [ "$1" = "--only" ]; then
    scope="$2"
    shift 2
  fi
  echo "=== $name"
  restore
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1163-split-build.log 2>&1; then
    echo "    DID NOT COMPILE: a mutation the compiler rejects proves nothing about the tests"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $scope > /tmp/mutate-1163-split-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1163-split-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1163-split-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_submitter_share_rate_back_to_seventy() {
  py <<'PY'
p = "src/ledger.ts"
s = open(p).read()
s = s.replace("export const SUBMITTER_SHARE_RATE = 0.4;", "export const SUBMITTER_SHARE_RATE = 0.7;")
open(p, "w").write(s)
PY
}

m_share_accrues_to_everyone_even_without_a_submitter() {
  py <<'PY'
p = "src/ledger.ts"
s = open(p).read()
s = s.replace("const submitterShare = submitterId ? roundCents(commission * SUBMITTER_SHARE_RATE) : 0;",
              "const submitterShare = roundCents(commission * SUBMITTER_SHARE_RATE);")
open(p, "w").write(s)
PY
}

m_balance_is_never_updated() {
  py <<'PY'
p = "src/ledger.ts"
s = open(p).read()
s = s.replace("  if (submitterId && submitterShare > 0) {\n    const submitterBalance = getOrCreateBalance(submitterId);",
              "  if (false as boolean) {\n    const submitterBalance = getOrCreateBalance(submitterId!);")
open(p, "w").write(s)
PY
}

m_entry_records_no_credited_agent() {
  py <<'PY'
p = "src/ledger.ts"
s = open(p).read()
s = s.replace("    agent_id: submitterId,\n    submitter_id: submitterId,",
              "    agent_id: null,\n    submitter_id: submitterId,")
open(p, "w").write(s)
PY
}

m_share_is_recorded_on_the_wrong_field() {
  py <<'PY'
p = "src/ledger.ts"
s = open(p).read()
s = s.replace("    agent_share: submitterShare,\n    submitter_share: 0,",
              "    agent_share: 0,\n    submitter_share: submitterShare,")
open(p, "w").write(s)
PY
}

m_rounding_is_dropped() {
  py <<'PY'
p = "src/ledger.ts"
s = open(p).read()
s = s.replace("const submitterShare = submitterId ? roundCents(commission * SUBMITTER_SHARE_RATE) : 0;",
              "const submitterShare = submitterId ? commission * SUBMITTER_SHARE_RATE : 0;")
open(p, "w").write(s)
PY
}

m_code_lookup_ignores_the_vendor() {
  py <<'PY'
p = "src/referral-codes.ts"
s = open(p).read()
s = s.replace("const match = loadCodes().find(c => c.vendor.toLowerCase() === lowerName && c.code === code);",
              "const match = loadCodes().find(c => c.code === code);")
open(p, "w").write(s)
PY
}

m_code_lookup_ignores_the_code() {
  py <<'PY'
p = "src/referral-codes.ts"
s = open(p).read()
s = s.replace("const match = loadCodes().find(c => c.vendor.toLowerCase() === lowerName && c.code === code);",
              "const match = loadCodes().find(c => c.vendor.toLowerCase() === lowerName);")
open(p, "w").write(s)
PY
}

m_code_lookup_is_vendor_case_sensitive() {
  py <<'PY'
p = "src/referral-codes.ts"
s = open(p).read()
s = s.replace("const match = loadCodes().find(c => c.vendor.toLowerCase() === lowerName && c.code === code);",
              "const match = loadCodes().find(c => c.vendor === vendorName && c.code === code);")
open(p, "w").write(s)
PY
}

m_empty_code_resolves_to_a_submitter() {
  py <<'PY'
p = "src/referral-codes.ts"
s = open(p).read()
s = s.replace('  if (!code) return null;\n  const lowerName = vendorName.toLowerCase();',
              '  const lowerName = vendorName.toLowerCase();')
open(p, "w").write(s)
PY
}

m_page_publishes_a_surfer_column_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("<thead><tr><th>Scenario</th><th>Submitter</th><th>Platform</th></tr></thead>",
              "<thead><tr><th>Scenario</th><th>Surfer</th><th>Submitter</th><th>Platform</th></tr></thead>")
open(p, "w").write(s)
PY
}

m_page_publishes_the_old_seventy_thirty_row() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("<tr><td>One of our own codes converts</td><td>&mdash;</td><td>100%</td></tr>",
              "<tr><td>One of our own codes converts</td><td>70%</td><td>30%</td></tr>")
open(p, "w").write(s)
PY
}

m_page_drops_the_no_surfacing_share_statement() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('<strong style="color:var(--text)">There is no share for surfacing a code.</strong> ', '')
open(p, "w").write(s)
PY
}

m_the_rate_changes_and_the_page_does_not_follow() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const submitterSharePercent = Math.round(SUBMITTER_SHARE_RATE * 100);",
              "const submitterSharePercent = 40;")
open(p, "w").write(s)

p = "src/ledger.ts"
s = open(p).read()
s = s.replace("export const SUBMITTER_SHARE_RATE = 0.4;", "export const SUBMITTER_SHARE_RATE = 0.5;")
open(p, "w").write(s)
PY
}


echo "Mutation testing the revenue split: what must fail if the rule or the published table drifts"
echo

run_mutation "the submitter share rate goes back to 70%" m_submitter_share_rate_back_to_seventy
run_mutation "a share accrues even when no agent submitted the code" m_share_accrues_to_everyone_even_without_a_submitter
run_mutation "the credited agent's balance is never updated" m_balance_is_never_updated
run_mutation "the entry records no credited agent" m_entry_records_no_credited_agent
run_mutation "the share is recorded on submitter_share instead of agent_share" m_share_is_recorded_on_the_wrong_field
run_mutation "the share is not rounded to cents" m_rounding_is_dropped
run_mutation "the code lookup ignores the vendor" m_code_lookup_ignores_the_vendor
run_mutation "the code lookup ignores the code" m_code_lookup_ignores_the_code
run_mutation "the code lookup becomes vendor case-sensitive" m_code_lookup_is_vendor_case_sensitive
run_mutation "an empty code resolves to a submitter" m_empty_code_resolves_to_a_submitter
run_mutation "the page publishes a surfer column again" m_page_publishes_a_surfer_column_again
run_mutation "the page publishes the old 70/30 row" m_page_publishes_the_old_seventy_thirty_row
run_mutation "the page drops the no-surfacing-share statement" m_page_drops_the_no_surfacing_share_statement
run_mutation "the rate changes and the published table does not follow" --only "test/marketplace-dashboard.test.ts" m_the_rate_changes_and_the_page_does_not_follow

echo
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
