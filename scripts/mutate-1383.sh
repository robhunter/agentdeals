#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/superseded-terms.test.ts test/stale-page-facts.test.ts"
KILLED=0
SURVIVED=0

run_mutation() {
  local label="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mutate-1383-backup
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding="utf-8").read()
n = s.count(frm)
if n != 1:
    print(f"SKIP: pattern appears {n} times", file=sys.stderr)
    sys.exit(3)
open(path, "w", encoding="utf-8").write(s.replace(frm, to))
PY
  local applied=$?
  if [ $applied -ne 0 ]; then
    cp /tmp/mutate-1383-backup "$file"
    printf '  %-62s NOT APPLIED\n' "$label"
    return
  fi
  ./node_modules/.bin/tsc > /tmp/mutate-1383-tsc 2>&1
  if [ $? -ne 0 ]; then
    printf '  %-62s killed (does not compile)\n' "$label"
    KILLED=$((KILLED + 1))
  else
    node --test --test-concurrency 1 $TESTS > /tmp/mutate-1383-out 2>&1
    if [ $? -ne 0 ]; then
      printf '  %-62s killed by %s\n' "$label" "$(grep -oE '^  ✖ .*\(' /tmp/mutate-1383-out | head -1 | sed 's/^  ✖ //; s/ ($//')"
      KILLED=$((KILLED + 1))
    else
      printf '  %-62s SURVIVED\n' "$label"
      SURVIVED=$((SURVIVED + 1))
    fi
  fi
  cp /tmp/mutate-1383-backup "$file"
  ./node_modules/.bin/tsc > /dev/null 2>&1
}

echo "── mutations of the census the budget is written from ──"

run_mutation "every superseded record counts as a page, not just the first" src/superseded-census.ts \
    'if (primaryOfferFor(offers, offer.vendor) === offer) vendorPages++;' \
    'vendorPages++;'

run_mutation "a gated page counts among the ungated ones" src/superseded-census.ts \
    '    if (gateFor(primary, date)) continue;
' \
    ''

run_mutation "every ungated page counts, superseded or not" src/superseded-census.ts \
    'if (supersededOffers.has(primary)) ungatedPages++;' \
    'ungatedPages++;'

run_mutation "the vendor index stops folding case" src/superseded-census.ts \
    'const key = change.vendor.toLowerCase();' \
    'const key = change.vendor;'

run_mutation "the record lookup stops folding case" src/superseded-census.ts \
    'byVendor.get(offer.vendor.toLowerCase()) ?? []' \
    'byVendor.get(offer.vendor) ?? []'

run_mutation "a vendor's last record answers for its page, not its first" src/superseded-census.ts \
    'return offers.find((offer) => offer.vendor === vendor) ?? null;' \
    'return offers.filter((offer) => offer.vendor === vendor).at(-1) ?? null;'

echo
echo "── mutations of which direction holds the commit ──"

run_mutation "any budget may be raised by a data run" scripts/ratchet-quality-budgets.js \
    '} else if (is > was && aDataRunMayRaise(name)) {' \
    '} else if (is > was) {'

run_mutation "no budget may be raised by a data run" scripts/ratchet-quality-budgets.js \
    '} else if (is > was && aDataRunMayRaise(name)) {' \
    '} else if (is > was && false) {'

run_mutation "a raise is reported but never written" scripts/ratchet-quality-budgets.js \
    '      next[name] = is;
      raised.push({ name, from: was, to: is });' \
    '      raised.push({ name, from: was, to: is });'

run_mutation "a fall in one of the three is written as a raise" scripts/ratchet-quality-budgets.js \
    '    } else if (is < was) {' \
    '    } else if (is < was && !aDataRunMayRaise(name)) {'

run_mutation "the page census is left out of the exemption" src/page-reviews.ts \
    '  "vendor_pages_withholding_superseded_terms",
  "ungated_pages_withholding_superseded_terms",
];' \
    '  "ungated_pages_withholding_superseded_terms",
];'

run_mutation "every budget is exempt" src/page-reviews.ts \
    'return QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE.includes(name);' \
    'return true;'

echo
echo "killed ${KILLED}, survived ${SURVIVED}"
