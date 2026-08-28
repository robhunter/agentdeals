#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

GATE="scripts/change-gate.js"
ROLLING="scripts/reverify-rolling.js"
BACKUP_DIR="$(mktemp -d)"
cp "$GATE" "$BACKUP_DIR/change-gate.js"
cp "$ROLLING" "$BACKUP_DIR/reverify-rolling.js"

restore() {
  cp "$BACKUP_DIR/change-gate.js" "$GATE"
  cp "$BACKUP_DIR/reverify-rolling.js" "$ROLLING"
}
trap restore EXIT

killed=0
survived=0

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/change-gate.js" "$GATE" > /dev/null && \
     diff -q "$BACKUP_DIR/reverify-rolling.js" "$ROLLING" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if timeout 300 node --test test/change-gate.test.ts > /tmp/mutate-1107-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖' /tmp/mutate-1107-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1107-test.log | head -4
    killed=$((killed + 1))
  fi
}

m_price_rule_removed() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  if (typeof pageText === "string") {', "  if (false) {")
open(p, "w").write(s)
PY
}

m_price_threshold_never_reached() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("export const MIN_PRICE_SIGNALS = 1;", "export const MIN_PRICE_SIGNALS = 0;")
open(p, "w").write(s)
PY
}

m_only_currency_counts() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT, NAMED_TIER, METERED_RATE, PERIODIC_ALLOWANCE];",
  "const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT];")
open(p, "w").write(s)
PY
}

m_allowance_needs_the_word_per() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT, NAMED_TIER, METERED_RATE, PERIODIC_ALLOWANCE];",
  "const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT, NAMED_TIER, METERED_RATE];")
open(p, "w").write(s)
PY
}

m_any_figure_counts_as_a_price() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT, NAMED_TIER, METERED_RATE, PERIODIC_ALLOWANCE];",
  "const PRICE_SIGNAL_PATTERNS = [CURRENCY_AMOUNT, NAMED_TIER, METERED_RATE, PERIODIC_ALLOWANCE, /\\d+/g];")
open(p, "w").write(s)
PY
}

m_the_word_free_alone_is_a_tier() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "|free\\s+(?:api|forever|version)|starts?\\s+at)\\b/gi;",
  "|free)\\b/gi;")
open(p, "w").write(s)
PY
}

m_unquantified_rule_removed() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "  if (QUANTITY_CHANGE_TYPES.includes(entry?.change_type)) {\n    const unquantified = unquantifiedInCurrentState(entry);",
  "  if (false) {\n    const unquantified = unquantifiedInCurrentState(entry);")
open(p, "w").write(s)
PY
}

m_unquantified_ignores_change_type() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "  if (QUANTITY_CHANGE_TYPES.includes(entry?.change_type)) {\n    const unquantified = unquantifiedInCurrentState(entry);",
  "  if (true) {\n    const unquantified = unquantifiedInCurrentState(entry);")
open(p, "w").write(s)
PY
}

m_every_stored_attribute_must_be_recited() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "  if (previous.some((a) => a.words.some((word) => currentWords.has(word)))) return null;",
  "  if (previous.every((a) => a.words.some((word) => currentWords.has(word)))) return null;")
open(p, "w").write(s)
PY
}

m_an_amount_is_not_an_attribute() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  '    if (/[$€£¥₹]\\s?$/.test(text.slice(0, match.index))) words.push(PRICE_ATTRIBUTE);\n',
  "")
open(p, "w").write(s)
PY
}

m_attribute_window_closed() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("const ATTRIBUTE_WINDOW = 60;", "const ATTRIBUTE_WINDOW = 0;")
open(p, "w").write(s)
PY
}

m_attribute_reads_one_word_only() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("const ATTRIBUTE_WORDS = 6;", "const ATTRIBUTE_WORDS = 1;")
open(p, "w").write(s)
PY
}

m_stored_state_with_no_figures_refuses() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("  if (previous.length === 0) return null;\n", "")
open(p, "w").write(s)
PY
}

m_gate_never_reads_the_page() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "    const verdict = describesChange(candidate, { pageText: pageTextFor(candidate) });",
  "    const verdict = describesChange(candidate);")
open(p, "w").write(s)
PY
}

m_run_forgets_which_page_it_read() {
  python3 - <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("        pageTexts.set(change, page.text);\n", "")
open(p, "w").write(s)
PY
}

m_run_hides_the_new_refusals() {
  python3 - <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace(
  '    lines.push(`  of which the page carried no pricing: ${refusals.get(REJECT_NO_PRICE_SIGNAL) ?? 0}`);\n',
  "")
s = s.replace(
  '    lines.push(`  of which claimed a limit quantified on one side only: ${refusals.get(REJECT_UNQUANTIFIED_LIMIT) ?? 0}`);\n',
  "")
open(p, "w").write(s)
PY
}

m_every_refusal_counts_as_every_reason() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "  for (const { reason } of rejected) {\n    counts.set(reason, (counts.get(reason) ?? 0) + 1);\n  }",
  "  for (const _ of rejected) {\n    for (const reason of GATE_REASONS) counts.set(reason, (counts.get(reason) ?? 0) + 1);\n  }")
open(p, "w").write(s)
PY
}

run_mutation "a page with no pricing no longer refuses the record" m_price_rule_removed
run_mutation "the price-signal threshold can never be reached" m_price_threshold_never_reached
run_mutation "only a currency amount counts as pricing" m_only_currency_counts
run_mutation "an allowance must use the word per to count" m_allowance_needs_the_word_per
run_mutation "any figure on the page counts as pricing" m_any_figure_counts_as_a_price
run_mutation "the word free alone names a tier" m_the_word_free_alone_is_a_tier
run_mutation "a limit claimed on one side only is recorded" m_unquantified_rule_removed
run_mutation "the one-sided-limit rule applies to every change type" m_unquantified_ignores_change_type
run_mutation "every stored figure must be restated or the record is refused" m_every_stored_attribute_must_be_recited
run_mutation "an amount is not an attribute a restructure can cite" m_an_amount_is_not_an_attribute
run_mutation "no words follow a figure" m_attribute_window_closed
run_mutation "only the word touching a figure names its attribute" m_attribute_reads_one_word_only
run_mutation "a stored state that quantified nothing still refuses" m_stored_state_with_no_figures_refuses
run_mutation "the gate never sees the page the run read" m_gate_never_reads_the_page
run_mutation "the run does not remember which page produced which report" m_run_forgets_which_page_it_read
run_mutation "the run summary hides the two new refusals" m_run_hides_the_new_refusals
run_mutation "every refusal is counted under every reason" m_every_refusal_counts_as_every_reason

restore

echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
