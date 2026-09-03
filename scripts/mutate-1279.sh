#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="scripts/structured-prices.js scripts/vendor-naming.js scripts/verify-freshness.js"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/typed-price-read.test.ts test/source-check.test.ts test/price-evidence-grade.test.ts test/short-page-floor.test.ts test/whole-page-read.test.ts"

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
  if ! npm run build > /tmp/mutate-1279-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 npx tsx --test $TESTS > /tmp/mutate-1279-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1279-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1279-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_only_the_offer_type_is_read() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace(
  '''export const PRICED_TYPES = new Set([
  "Offer",
  "AggregateOffer",
  "PriceSpecification",
  "UnitPriceSpecification",
]);''',
  'export const PRICED_TYPES = new Set(["Offer"]);')
open(p, "w").write(s)
PY
}

m_a_range_low_price_is_not_a_price() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('const PRICE_KEYS = ["price", "lowPrice"];', 'const PRICE_KEYS = ["price"];')
open(p, "w").write(s)
PY
}

m_a_type_array_is_ignored() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('  if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");\n', '')
open(p, "w").write(s)
PY
}

m_a_price_needs_no_figure() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('  if (!trimmed || !A_FIGURE.test(trimmed)) return null;', '  if (!trimmed) return null;')
open(p, "w").write(s)
PY
}

m_a_malformed_block_stops_the_read() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('''    let value;
    try {
      value = JSON.parse(block);
    } catch {
      continue;
    }''', '    const value = JSON.parse(block);')
open(p, "w").write(s)
PY
}

m_the_same_price_counts_twice() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('return { blocks: blocks.length, parsed, prices: distinctPrices(prices) };',
              'return { blocks: blocks.length, parsed, prices };')
open(p, "w").write(s)
PY
}

m_an_unnamed_twin_is_kept() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('  return distinct.filter((price) => price.name || !named.has(amountKey(price)));',
              '  return distinct;')
open(p, "w").write(s)
PY
}

m_a_nameless_offer_takes_no_name_from_its_item() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('''  const offered = node.itemOffered;
  if (offered && typeof offered === "object" && typeof offered.name === "string" && offered.name.trim()) {
    return offered.name.trim();
  }
''', '')
open(p, "w").write(s)
PY
}

m_absent_markup_reads_the_same_as_priceless_markup() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('  if (structured.blocks === 0) return NO_STRUCTURED_DATA;\n', '')
open(p, "w").write(s)
PY
}

m_a_zero_counts_as_a_price_the_page_hides() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('  return structured.prices.filter((price) => !isZero(price) && !renderedIn(price, text));',
              '  return structured.prices.filter((price) => !renderedIn(price, text));')
open(p, "w").write(s)
PY
}

m_a_price_inside_a_longer_number_counts_as_rendered() {
  py <<'PY'
p = "scripts/structured-prices.js"
s = open(p).read()
s = s.replace('    if (new RegExp(`(?<![\\\\d.,])${form.replace(/\\./g, "\\\\.")}(?![\\\\d])`).test(text)) return true;',
              '    if (text.includes(form)) return true;')
open(p, "w").write(s)
PY
}

m_markup_cannot_lift_a_grade() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace('  if (!rendersAnAmount && structured && structured.prices.length > 0) {',
              '  if (false && !rendersAnAmount && structured && structured.prices.length > 0) {')
open(p, "w").write(s)
PY
}

m_markup_overrides_a_rendered_amount() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace('  if (!rendersAnAmount && structured && structured.prices.length > 0) {',
              '  if (structured && structured.prices.length > 0) {')
open(p, "w").write(s)
PY
}

m_the_grade_does_not_say_which_reading_made_it() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace('      read: READ_FROM_MARKUP,\n', '')
open(p, "w").write(s)
PY
}

m_the_unrendered_prices_are_not_recorded() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace('''  if (unrendered.length > 0) {
    record.unrendered_prices = unrendered.slice(0, MAX_UNRENDERED_PRICES_RECORDED).map(priceLabel);
  }''', '')
open(p, "w").write(s)
PY
}

m_the_page_is_fetched_without_reading_its_markup() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace('      structured: readStructuredPrices(body.html),\n', '')
open(p, "w").write(s)
PY
}

m_the_markup_is_read_after_the_scripts_are_stripped() {
  py <<'PY'
p = "scripts/verify-freshness.js"
s = open(p).read()
s = s.replace('      structured: readStructuredPrices(body.html),',
              '      structured: readStructuredPrices(text),')
open(p, "w").write(s)
PY
}

run_mutation "only Offer nodes carry a price" m_only_the_offer_type_is_read
run_mutation "a range's low price is not a price" m_a_range_low_price_is_not_a_price
run_mutation "a node typed as a list is ignored" m_a_type_array_is_ignored
run_mutation "a price needs no figure in it" m_a_price_needs_no_figure
run_mutation "a malformed block stops the read" m_a_malformed_block_stops_the_read
run_mutation "the same price stated twice counts twice" m_the_same_price_counts_twice
run_mutation "an unnamed twin of a named price is kept" m_an_unnamed_twin_is_kept
run_mutation "a nameless offer takes no name from its item" m_a_nameless_offer_takes_no_name_from_its_item
run_mutation "absent markup reads the same as priceless markup" m_absent_markup_reads_the_same_as_priceless_markup
run_mutation "a zero counts as a price the page hides" m_a_zero_counts_as_a_price_the_page_hides
run_mutation "a price inside a longer number counts as rendered" m_a_price_inside_a_longer_number_counts_as_rendered
run_mutation "markup cannot lift a grade" m_markup_cannot_lift_a_grade
run_mutation "markup overrides a rendered amount" m_markup_overrides_a_rendered_amount
run_mutation "the grade does not say which reading made it" m_the_grade_does_not_say_which_reading_made_it
run_mutation "the prices a page hides are not recorded" m_the_unrendered_prices_are_not_recorded
run_mutation "the page is fetched without reading its markup" m_the_page_is_fetched_without_reading_its_markup
run_mutation "the markup is read after the scripts are stripped" m_the_markup_is_read_after_the_scripts_are_stripped

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
