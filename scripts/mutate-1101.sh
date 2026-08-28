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
  if timeout 300 node --test test/change-gate.test.ts > /tmp/mutate-1101-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖' /tmp/mutate-1101-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1101-test.log | head -4
    killed=$((killed + 1))
  fi
}

m_never_rejects() {
  python3 - <<'PY'
import re
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("export function describesChange(entry, context = {}) {", "export function describesChange(entry, context = {}) {\n  return { ok: true };")
open(p, "w").write(s)
PY
}

m_null_comparison_ignored() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("if (nulls.length > 0 && containsAll(current, previous)) {", "if (false && nulls.length > 0 && containsAll(current, previous)) {")
open(p, "w").write(s)
PY
}

m_null_comparison_ignores_dropped_quantity() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("if (nulls.length > 0 && containsAll(current, previous)) {", "if (nulls.length > 0) {")
open(p, "w").write(s)
PY
}

m_operands_need_not_be_equal() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("if (left !== undefined && right !== undefined && left === right) {", "if (left !== undefined && right !== undefined) {")
open(p, "w").write(s)
PY
}

m_operand_window_unbounded() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("const OPERAND_WINDOW = 30;", "const OPERAND_WINDOW = 100000;")
open(p, "w").write(s)
PY
}

m_agreement_alone_rejects() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  "    QUANTITY_CHANGE_TYPES.includes(entry?.change_type) &&\n    assertsAgreement(entry?.summary) &&\n    multisetEqual(previous, current)",
  "    assertsAgreement(entry?.summary)")
open(p, "w").write(s)
PY
}

m_agreement_ignores_change_type() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    QUANTITY_CHANGE_TYPES.includes(entry?.change_type) &&\n", "")
open(p, "w").write(s)
PY
}

m_equal_quantities_alone_rejects() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    assertsAgreement(entry?.summary) &&\n", "")
open(p, "w").write(s)
PY
}

m_quantities_ignore_thousands_separator() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('const NUMBER = /\\d+(?:,\\d{3})*(?:\\.\\d+)?/g;', 'const NUMBER = /\\d+/g;')
open(p, "w").write(s)
PY
}

m_second_opinion_no_verdict_rejects() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('if (confirmation.verdict === "no") {', 'if (confirmation.verdict !== "yes") {')
open(p, "w").write(s)
PY
}

m_second_opinion_error_drops_the_record() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  '      unchecked.push({ candidate, error: err.message });\n      accepted.push(candidate);\n      continue;',
  '      unchecked.push({ candidate, error: err.message });\n      continue;')
open(p, "w").write(s)
PY
}

m_second_opinion_asked_before_the_first_layer() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
before = s
s = s.replace(
  "    if (!verdict.ok) {\n      rejected.push({ candidate: original, reason: verdict.reason, detail: verdict.detail });\n      continue;\n    }\n    let candidate = original;",
  "    let candidate = original;")
if s == before:
    raise SystemExit("the first layer's refusal block moved; retarget this mutation")
s = s.replace(
  "    if (confirmation.verdict === \"no\") {",
  "    if (!verdict.ok) {\n      rejected.push({ candidate, reason: verdict.reason, detail: verdict.detail });\n      continue;\n    }\n    if (confirmation.verdict === \"no\") {")
open(p, "w").write(s)
PY
}

m_parse_accepts_any_shape() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  '    parsed && (parsed.change === "yes" || parsed.change === "no") ? parsed : null;',
  '    parsed ? { change: parsed.change ?? "yes" } : null;')
open(p, "w").write(s)
PY
}

m_parse_drops_fence_stripping() {
  python3 - <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace(
  '      ? raw.trim().replace(/^```(?:json)?\\s*/i, "").replace(/```$/, "").trim()',
  '      ? raw.trim()')
open(p, "w").write(s)
PY
}

m_run_writes_the_rejected_candidates() {
  python3 - <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("const { appended, suppressed } = appendFn(accepted, {", "const { appended, suppressed } = appendFn(changes, {")
open(p, "w").write(s)
PY
}

m_summary_hides_the_rejections() {
  python3 - <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace('    lines.push(`Rejected (no change described): ${(result.rejected ?? []).length}`);\n', "")
open(p, "w").write(s)
PY
}

m_summary_hides_the_unchecked() {
  python3 - <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace('    lines.push(`Recorded without a second opinion: ${(result.unchecked ?? []).length}`);\n', "")
open(p, "w").write(s)
PY
}

m_url_mode_reports_rejections() {
  python3 - <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace(
  '  const lines = ["", "── Summary ──", `Checked: ${checked}`, `Verified (date bumped): ${result.verified}`];\n  if (useAi) {',
  '  const lines = ["", "── Summary ──", `Checked: ${checked}`, `Verified (date bumped): ${result.verified}`];\n  lines.push(`Rejected (no change described): ${(result.rejected ?? []).length}`);\n  if (useAi) {')
open(p, "w").write(s)
PY
}

run_mutation "the gate never refuses anything" m_never_rejects
run_mutation "an equal-valued comparison stops being read" m_null_comparison_ignored
run_mutation "an equal-valued comparison refuses even when a stored figure vanished" m_null_comparison_ignores_dropped_quantity
run_mutation "any comparison counts, equal-valued or not" m_operands_need_not_be_equal
run_mutation "the comparison operands may sit anywhere in the summary" m_operand_window_unbounded
run_mutation "an agreement phrase alone refuses the record" m_agreement_alone_rejects
run_mutation "an agreement phrase refuses whatever the record claims changed" m_agreement_ignores_change_type
run_mutation "matching figures alone refuse the record" m_equal_quantities_alone_rejects
run_mutation "figures are read without their thousands separator" m_quantities_ignore_thousands_separator
run_mutation "an unreadable second opinion refuses the record" m_second_opinion_no_verdict_rejects
run_mutation "a second opinion that could not be asked drops the record" m_second_opinion_error_drops_the_record
run_mutation "the second opinion is spent before the first layer runs" m_second_opinion_asked_before_the_first_layer
run_mutation "any JSON object counts as a verdict" m_parse_accepts_any_shape
run_mutation "a fenced verdict is no longer unwrapped" m_parse_drops_fence_stripping
run_mutation "the run writes every candidate, refused or not" m_run_writes_the_rejected_candidates
run_mutation "the run summary hides the refusals" m_summary_hides_the_rejections
run_mutation "the run summary hides the records recorded unchecked" m_summary_hides_the_unchecked
run_mutation "the mode that detects nothing reports refusals anyway" m_url_mode_reports_rejections

restore

echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
