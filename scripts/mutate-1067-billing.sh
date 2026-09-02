#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/copilot-billing-unit.test.ts"

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
  if ! npm run build > /tmp/mutate-1067-billing-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1067-billing-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1067-billing-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1067-billing-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

swap() {
  py <<PY
p = "src/serve.ts"
s = open(p).read()
before = s
s = s.replace("""$1""", """$2""", $3)
assert s != before, "mutation string not found"
open(p, "w").write(s)
PY
}

m_copilot_power_back_to_pro_plus() {
  swap 'power: "$100/mo (Max)",' 'power: "$39/mo (Pro+)",' 2
}

m_copilot_model_back_to_premium_requests() {
  swap 'model: "Tier + AI credits",' 'model: "Tier + premium requests",' 2
}

m_copilot_free_details_page_one_back() {
  swap '2,000 code completions/month plus limited chat and agent use. On paid plans' \
       '2,000 code completions/month, 50 premium requests/month. Pro: 300 premium requests. On paid plans' 1
}

m_copilot_free_details_page_two_back() {
  swap '2,000 code completions/month plus limited chat and agent usage, no credit card.' \
       '2,000 code completions/month, 50 premium requests/month.' 1
}

m_copilot_hidden_costs_back() {
  swap "Agent and chat usage is metered — an AI credit is \$0.01" \
       "Advanced models burn 5x–20x premium requests faster" 1
}

m_copilot_faq_back() {
  swap 'The free tier gives 2,000 code completions a month plus limited chat and agent use.' \
       'The free tier gives 2,000 code completions and 50 premium requests a month.' 1
}

m_free_ai_stack_back() {
  swap 'why: "2,000 completions/month free.' \
       'why: "2,000 completions/month + 50 premium requests free.' 1
}

m_overage_no_longer_marked_retired() {
  swap "and the \$0.04 per-request overage are retired; GitHub's own billing docs label that model legacy." \
       "and the \$0.04 per-request overage still apply." 1
}

m_credit_price_dropped_page_one() {
  swap "metered in GitHub AI Credits at \$0.01 each" "metered in GitHub AI Credits" 1
}

m_credit_price_dropped_page_two() {
  swap "metered in GitHub AI Credits at \$0.01 per credit" "metered in GitHub AI Credits" 1
}

m_cursor_power_back_to_unpriced() {
  swap 'power: "$200/mo (Ultra)",' 'power: "Pro+ / Ultra",' 2
}

m_cursor_pro_plus_price_dropped_page_one() {
  swap "Pro \$20/mo, Pro+ \$60/mo (3x Pro's Agent limits), Ultra \$200/mo (20x)" \
       "Individual \$20/mo (Pro), Pro+ (3x Pro's Agent limits), Ultra (20x)" 1
}

m_hidden_costs_truncated_again() {
  swap "escHtmlServer(t.monthlyCostTeam5) + '</td>' +
      '<td style=\"font-size:.85rem;color:var(--text-muted)\">' + escHtmlServer(t.hiddenCosts)" \
       "escHtmlServer(t.monthlyCostTeam5) + '</td>' +
      '<td style=\"font-size:.85rem;color:var(--text-muted)\">' + escHtmlServer(t.hiddenCosts.substring(0, 80))" 1
}

m_cursor_pro_plus_price_dropped_page_two() {
  swap "Pro is \$20/mo, Pro+ \$60/mo at 3x Pro's Agent limits, Ultra \$200/mo at 20x." \
       "Individual plans start at \$20/mo (Pro), with Pro+ at 3x Pro's Agent limits and Ultra at 20x." 1
}

run_mutation "Copilot's power cell names Pro+ instead of Max" m_copilot_power_back_to_pro_plus
run_mutation "Copilot's billing model reads premium requests" m_copilot_model_back_to_premium_requests
run_mutation "the first page states a premium-request allowance" m_copilot_free_details_page_one_back
run_mutation "the second page states a premium-request allowance" m_copilot_free_details_page_two_back
run_mutation "the hidden-cost note is written in premium requests" m_copilot_hidden_costs_back
run_mutation "the FAQ answer states a premium-request allowance" m_copilot_faq_back
run_mutation "the free AI stack page states a premium-request allowance" m_free_ai_stack_back
run_mutation "the per-request overage is no longer marked retired" m_overage_no_longer_marked_retired
run_mutation "the first page states no price for an AI credit" m_credit_price_dropped_page_one
run_mutation "the second page states no price for an AI credit" m_credit_price_dropped_page_two
run_mutation "the hidden-cost cell is truncated again" m_hidden_costs_truncated_again
run_mutation "Cursor's power cell carries no price" m_cursor_power_back_to_unpriced
run_mutation "the first page drops Pro+ and Ultra's prices" m_cursor_pro_plus_price_dropped_page_one
run_mutation "the second page drops Pro+ and Ultra's prices" m_cursor_pro_plus_price_dropped_page_two

echo ""
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
