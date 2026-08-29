#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

VERDICT="src/vendor-verdict.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$VERDICT" "$BACKUP_DIR/vendor-verdict.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/vendor-verdict.ts" "$VERDICT"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/vendor-verdict.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/vendor-verdict.ts" "$VERDICT" > /dev/null && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1143-build.log 2>&1; then
    echo "    KILLED (does not compile)"
    killed=$((killed + 1))
    return
  fi
  if timeout 300 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1143-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1143-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1143-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_a_level_publishes_without_its_cause() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  return level && (level === "stable" || cause) ? level : "stable";', '  return level ?? "stable";')
open(p, "w").write(s)
PY
}

m_every_level_is_rewritten_to_stable() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  return level && (level === "stable" || cause) ? level : "stable";', '  return "stable";')
open(p, "w").write(s)
PY
}

m_every_record_counts_as_narrowing() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    .filter(c => CHANGE_DIRECTION[c.change_type] === "negative")\n', '')
open(p, "w").write(s)
PY
}

m_the_records_that_helped_count_as_narrowing() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('CHANGE_DIRECTION[c.change_type] === "negative"', 'CHANGE_DIRECTION[c.change_type] === "positive"')
open(p, "w").write(s)
PY
}

m_the_oldest_narrowing_record_is_called_the_most_recent() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    .sort((a, b) => b.date.localeCompare(a.date));', '    .sort((a, b) => a.date.localeCompare(b.date));')
open(p, "w").write(s)
PY
}

m_the_stable_sentence_reports_the_total_instead() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  return `${narrowing.length} recorded changes narrowed the terms, the most recent ${changeDateClause(narrowing[0])}.`;',
              '  return `${total} recorded changes narrowed the terms, the most recent ${changeDateClause(narrowing[0])}.`;')
open(p, "w").write(s)
PY
}

m_a_single_narrowing_record_is_left_unnamed() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    return `One recorded ${changeKindNoun(narrowing[0].change_type)} narrowed the terms, ${changeDateClause(narrowing[0])}.`;',
              '    return `One recorded change narrowed the terms, ${changeDateClause(narrowing[0])}.`;')
open(p, "w").write(s)
PY
}

m_a_stable_rating_never_mentions_the_records_it_holds() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  return `We rate it stable — we hold no ${DEMOTING_KINDS_PHRASE} for this vendor. ${narrowingSentence(input.changes)}`;',
              '  return `We rate it stable — we hold no ${DEMOTING_KINDS_PHRASE} for this vendor.`;')
open(p, "w").write(s)
PY
}

m_a_non_stable_rating_falls_through_to_the_stable_sentence() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  if (level !== "stable" && input.cause) {', '  if (level === "stable" && input.cause) {')
open(p, "w").write(s)
PY
}

m_the_cause_is_reported_as_a_count() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    return `We rate it ${level} — one recorded ${changeKindNoun(input.cause.change_type)}, ${changeDateClause(input.cause)}.${unconfirmed}`;',
              '    return `We rate it ${level} — ${input.changes.length} pricing changes recorded.`;')
open(p, "w").write(s)
PY
}

m_a_cause_we_found_ourselves_is_dated_as_the_day_it_took_effect() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('${changeDateClause(input.cause)}', 'on ${input.cause.date}')
s = s.replace('${changeDateClause(narrowing[0])}', 'on ${narrowing[0].date}')
open(p, "w").write(s)
PY
}

m_a_withheld_rating_is_published_as_a_word() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  if (withholdingDecides(input)) return null;\n  return publishedVendorLevel(input.level, input.cause);',
              '  return publishedVendorLevel(input.level, input.cause);')
open(p, "w").write(s)
PY
}

m_a_restriction_is_named_as_a_limit_reduction() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  restriction: "restriction",', '  restriction: "limit reduction",')
open(p, "w").write(s)
PY
}

m_the_one_record_it_holds_is_reported_as_none() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('      ? `The one change we have recorded did not narrow the terms.`', '      ? `None of the 0 recorded changes narrowed the terms.`')
open(p, "w").write(s)
PY
}

m_the_page_forgets_it_is_withholding_the_rating() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    changes: vendorChanges,\n    levelWithheld,\n    unconfirmableSince,", "    changes: vendorChanges,\n    levelWithheld: null,\n    unconfirmableSince,")
open(p, "w").write(s)
PY
}

m_the_verdict_reads_no_records_at_all() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    cause: riskCause,\n    changes: vendorChanges,", "    cause: riskCause,\n    changes: [],")
open(p, "w").write(s)
PY
}

m_the_badge_renders_the_second_classifier() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('border:1px solid ${riskColor}40">${riskLevel}</span>`;',
              'border:1px solid ${riskColor}40">${enriched.stability ?? "stable"}</span>`;')
open(p, "w").write(s)
PY
}

m_the_comparison_cell_rates_the_vendor_stable_regardless() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('<td>${stabilityCellHtml(enriched.risk_level, riskCause, linkUnreachable, primary)}</td>',
              '<td>${stabilityCellHtml("stable", null, linkUnreachable, primary)}</td>')
open(p, "w").write(s)
PY
}

m_the_comparison_cell_publishes_a_level_with_no_cause() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('export function publishedVendorLevel(\n  level: PublishedRiskLevel | null,\n  cause: RiskCause | null,\n): PublishedRiskLevel {',
              'export function publishedVendorLevel(\n  level: PublishedRiskLevel | null,\n  _cause: RiskCause | null,\n): PublishedRiskLevel {')
s = s.replace('  return level && (level === "stable" || cause) ? level : "stable";', '  return level ?? "stable";')
open(p, "w").write(s)
PY
}

m_the_comparison_cell_loses_its_word() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  return `<span class="stability-dot" style="background:${color}"></span> <span${title}>${escHtmlServer(published)}</span>`;',
              '  return `<span class="stability-dot" style="background:${color}"></span>`;')
open(p, "w").write(s)
PY
}

m_the_reliability_answer_goes_back_to_a_bare_count() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('${vendorChanges.length > 0 ? ` ${narrowingSentence(vendorChanges)} See the pricing history below.` : ""}',
              '${vendorChanges.length > 0 ? ` We do hold ${vendorChanges.length} other recorded changes — see the pricing history below.` : ""}')
open(p, "w").write(s)
PY
}

m_the_production_answer_names_a_level_of_its_own() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("but we rate it ${riskLevel}${riskCause", "but we rate it caution${riskCause")
open(p, "w").write(s)
PY
}

m_the_verdict_line_is_dropped_from_the_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const verdictLine2 = vendorVerdictSentence(verdictInput);', '  const verdictLine2 = "";')
open(p, "w").write(s)
PY
}

run_mutation "a level publishes without its cause" m_a_level_publishes_without_its_cause
run_mutation "every level is rewritten to stable" m_every_level_is_rewritten_to_stable
run_mutation "every record counts as narrowing" m_every_record_counts_as_narrowing
run_mutation "the records that helped count as narrowing" m_the_records_that_helped_count_as_narrowing
run_mutation "the oldest narrowing record is called the most recent" m_the_oldest_narrowing_record_is_called_the_most_recent
run_mutation "the stable sentence reports the total instead" m_the_stable_sentence_reports_the_total_instead
run_mutation "a single narrowing record is left unnamed" m_a_single_narrowing_record_is_left_unnamed
run_mutation "a stable rating never mentions the records it holds" m_a_stable_rating_never_mentions_the_records_it_holds
run_mutation "a non-stable rating falls through to the stable sentence" m_a_non_stable_rating_falls_through_to_the_stable_sentence
run_mutation "the cause is reported as a count" m_the_cause_is_reported_as_a_count
run_mutation "a cause we found ourselves is dated as the day it took effect" m_a_cause_we_found_ourselves_is_dated_as_the_day_it_took_effect
run_mutation "a withheld rating is published as a word" m_a_withheld_rating_is_published_as_a_word
run_mutation "a restriction is named as a limit reduction" m_a_restriction_is_named_as_a_limit_reduction
run_mutation "the one record it holds is reported as none" m_the_one_record_it_holds_is_reported_as_none
run_mutation "the page forgets it is withholding the rating" m_the_page_forgets_it_is_withholding_the_rating
run_mutation "the verdict reads no records at all" m_the_verdict_reads_no_records_at_all
run_mutation "the badge renders the second classifier" m_the_badge_renders_the_second_classifier
run_mutation "the comparison cell rates the vendor stable regardless" m_the_comparison_cell_rates_the_vendor_stable_regardless
run_mutation "the comparison cell publishes a level with no cause" m_the_comparison_cell_publishes_a_level_with_no_cause
run_mutation "the comparison cell loses its word" m_the_comparison_cell_loses_its_word
run_mutation "the reliability answer goes back to a bare count" m_the_reliability_answer_goes_back_to_a_bare_count
run_mutation "the production answer names a level of its own" m_the_production_answer_names_a_level_of_its_own
run_mutation "the verdict line is dropped from the page" m_the_verdict_line_is_dropped_from_the_page

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed, survived: $survived"
[ "$survived" -eq 0 ]
