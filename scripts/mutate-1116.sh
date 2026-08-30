#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

GATE="scripts/change-gate.js"
REFUSALS="scripts/change-refusals.js"
ROLLING="scripts/reverify-rolling.js"
FETCH="scripts/verify-freshness.js"
BACKUP_DIR="$(mktemp -d)"
for f in "$GATE" "$REFUSALS" "$ROLLING" "$FETCH"; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in "$GATE" "$REFUSALS" "$ROLLING" "$FETCH"; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
}
trap restore EXIT

killed=0
survived=0
TESTS="test/change-gate.test.ts test/change-refusals.test.ts test/change-log-writer.test.ts test/reverify-rolling.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$GATE" "$REFUSALS" "$ROLLING" "$FETCH"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1116-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1116-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1116-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_absence_ignores_whether_we_read_it_all() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('        context.pageComplete === true ? storedDimensionsAbsentFromPage(entry, pageText) : [];',
              '        storedDimensionsAbsentFromPage(entry, pageText);')
open(p, "w").write(s)
PY
}

m_presence_counts_as_absence() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('    if (!present) absent.push({ value: attribute.value, measured: word });',
              '    if (present) absent.push({ value: attribute.value, measured: word });')
open(p, "w").write(s)
PY
}

m_one_absent_dimension_is_not_enough() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('      if (gone.length > 0) {', '      if (gone.length > 1) {')
open(p, "w").write(s)
PY
}

m_reclassifies_to_the_type_it_already_had() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('export const RECLASSIFIED_AS_RESTRUCTURE = "pricing_restructured";',
              'export const RECLASSIFIED_AS_RESTRUCTURE = "limits_reduced";')
open(p, "w").write(s)
PY
}

m_measured_word_takes_the_unit() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  return (attribute?.words ?? []).find(isAMeasureWord) ?? null;',
              '  return (attribute?.words ?? [])[0] ?? null;')
open(p, "w").write(s)
PY
}

m_an_amount_is_looked_for_literally() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('    const present = word === PRICE_ATTRIBUTE ? carriesAnAmount : lower.includes(word);',
              '    const present = lower.includes(word);')
open(p, "w").write(s)
PY
}

m_binary_units_scale_like_decimal() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  ["gib", 1024 ** 3],', '  ["gib", 1e9],')
open(p, "w").write(s)
PY
}

m_magnitude_ignores_the_unit() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('  return value * (attribute?.scale ?? 1);',
              '  return value;')
open(p, "w").write(s)
PY
}

m_a_figure_without_a_unit_still_measures() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('      BYTE_UNITS.get(unit ?? "") ??\n', '')
open(p, "w").write(s)
PY
}

m_the_second_opinion_is_never_overruled() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('      const difference = describesQuantifiedDifference(candidate);\n      if (!difference) {',
              '      const difference = describesQuantifiedDifference(candidate);\n      if (difference || !difference) {')
open(p, "w").write(s)
PY
}

m_the_second_opinion_is_always_overruled() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('      const difference = describesQuantifiedDifference(candidate);\n      if (!difference) {',
              '      const difference = describesQuantifiedDifference(candidate) ?? { attribute: "x", previous: "1 gb", current: "2 gb", from: 1, to: 2, direction: "increase" };\n      if (!difference) {')
open(p, "w").write(s)
PY
}

m_no_unit_is_extracted_from_the_text() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace('    const unit = unitMatch ? unitMatch[1].toLowerCase() : null;',
              '    const unit = null;')
open(p, "w").write(s)
PY
}

m_the_refusal_is_not_written() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace('  const merged = mergeRefusals(readRefusals(path), fresh);\n  writeFileSync(path, JSON.stringify({ refusals: merged }, null, 2) + "\\n");',
              '  mergeRefusals(readRefusals(path), fresh);')
open(p, "w").write(s)
PY
}

m_a_dry_run_writes_anyway() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace('  if (options.dryRun) return { written: fresh, path };\n', '')
open(p, "w").write(s)
PY
}

m_the_refusal_key_forgets_the_reason() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace('  return [refusal.vendor, refusal.source_url, refusal.reason].join("|");',
              '  return [refusal.vendor, refusal.source_url].join("|");')
open(p, "w").write(s)
PY
}

m_a_corrected_record_stays_held() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace('    if (refusal.previous_state !== offer.description) continue;\n', '')
open(p, "w").write(s)
PY
}

m_the_oldest_hold_wins() {
  py <<'PY'
p = "scripts/change-refusals.js"
s = open(p).read()
s = s.replace('    if (!held || refusal.refused_date > held) holds.set(key, refusal.refused_date);',
              '    if (!held) holds.set(key, refusal.refused_date);')
open(p, "w").write(s)
PY
}

m_the_queue_ignores_the_refusal() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace('  const dates = [offer?.verifiedDate, held, refusedOn, verificationRecord?.last_attempt_at].filter(Boolean);',
              '  const dates = [offer?.verifiedDate, held, verificationRecord?.last_attempt_at].filter(Boolean);')
open(p, "w").write(s)
PY
}

m_the_summary_omits_the_vendor() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace('  return [...byReason.entries()].map(([reason, vendors]) => `  refused as ${reason}: ${vendors.join(", ")}`);',
              '  return [...byReason.entries()].map(([reason, vendors]) => `  refused as ${reason}: ${vendors.length}`);')
open(p, "w").write(s)
PY
}

m_every_page_reads_as_whole() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace('      truncated: text.length > MAX_PAGE_TEXT_LENGTH,', '      truncated: false,')
open(p, "w").write(s)
PY
}

m_the_run_never_says_a_page_was_whole() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace('        if (!page.truncated) wholePages.add(change);', '')
open(p, "w").write(s)
PY
}

run_mutation "absence is read off a page we only partly read" m_absence_ignores_whether_we_read_it_all
run_mutation "a dimension still on the page counts as gone" m_presence_counts_as_absence
run_mutation "one vanished dimension is not enough to reclassify" m_one_absent_dimension_is_not_enough
run_mutation "the reclassification leaves the change type alone" m_reclassifies_to_the_type_it_already_had
run_mutation "the unit is read as the thing being measured" m_measured_word_takes_the_unit
run_mutation "an amount is looked for on the page as the word currency" m_an_amount_is_looked_for_literally
run_mutation "a gibibyte is scaled as a gigabyte" m_binary_units_scale_like_decimal
run_mutation "the magnitude ignores the unit written against it" m_magnitude_ignores_the_unit
run_mutation "a size unit does not scale the figure written against it" m_a_figure_without_a_unit_still_measures
run_mutation "no unit is read out of the text at all" m_no_unit_is_extracted_from_the_text
run_mutation "the second opinion is never overruled" m_the_second_opinion_is_never_overruled
run_mutation "the second opinion is always overruled" m_the_second_opinion_is_always_overruled
run_mutation "the refusal is not written to disk" m_the_refusal_is_not_written
run_mutation "a dry run writes the refusal anyway" m_a_dry_run_writes_anyway
run_mutation "two reasons for one record collapse into one" m_the_refusal_key_forgets_the_reason
run_mutation "a record corrected since the refusal stays held" m_a_corrected_record_stays_held
run_mutation "the earliest refusal wins over the latest" m_the_oldest_hold_wins
run_mutation "the queue ignores the day a record was refused" m_the_queue_ignores_the_refusal
run_mutation "the summary counts refusals without naming them" m_the_summary_omits_the_vendor
run_mutation "every page reports as read in full" m_every_page_reads_as_whole
run_mutation "the run never tells the gate a page was whole" m_the_run_never_says_a_page_was_whole

restore
echo ""
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
