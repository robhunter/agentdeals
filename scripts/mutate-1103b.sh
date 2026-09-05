#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/superseded-terms.test.ts"
KILLED=0
SURVIVED=0

run_mutation() {
  local label="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mutate-1103b-backup
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
    cp /tmp/mutate-1103b-backup "$file"
    printf '  %-62s NOT APPLIED\n' "$label"
    return
  fi
  ./node_modules/.bin/tsc > /tmp/mutate-1103b-tsc 2>&1
  if [ $? -ne 0 ]; then
    printf '  %-62s killed (does not compile)\n' "$label"
    KILLED=$((KILLED + 1))
  else
    node --test --test-concurrency 1 $TESTS > /tmp/mutate-1103b-out 2>&1
    if [ $? -ne 0 ]; then
      printf '  %-62s killed by %s\n' "$label" "$(grep -oE '^  ✖ .*\(' /tmp/mutate-1103b-out | head -1 | sed 's/^  ✖ //; s/ ($//')"
      KILLED=$((KILLED + 1))
    else
      printf '  %-62s SURVIVED\n' "$label"
      SURVIVED=$((SURVIVED + 1))
    fi
  fi
  cp /tmp/mutate-1103b-backup "$file"
  ./node_modules/.bin/tsc > /dev/null 2>&1
}

echo "── mutations of which direction withholds ──"

run_mutation "every quoting change withholds again" src/superseded-description.ts \
    '  if (!narrowsTheStoredTerms(change.change_type)) return false;
' \
    ''

run_mutation "a widening change withholds and a narrowing one does not" src/change-direction.ts \
    '  return direction === null || direction === "negative";' \
    '  return direction !== null && direction !== "negative";'

run_mutation "an unrecognised change type publishes the stored terms" src/change-direction.ts \
    '  return direction === null || direction === "negative";' \
    '  return direction === "negative";'

run_mutation "a neutral change withholds alongside the negative ones" src/change-direction.ts \
    '  return direction === null || direction === "negative";' \
    '  return direction !== "positive";'

run_mutation "a resolved narrowing change withholds again" src/superseded-description.ts \
    '  if (isNoLongerInForce(change)) return false;
' \
    ''

run_mutation "a change that quotes nothing withholds" src/superseded-description.ts \
    '  return quotesTheStoredTermsAsPrevious(change, description);' \
    '  return true;'

echo
echo "── mutations of the classification itself ──"

run_mutation "a limit increase is read as adverse" src/change-direction.ts \
    '  limits_increased: "positive",' \
    '  limits_increased: "negative",'

run_mutation "a restriction is read as harmless" src/change-direction.ts \
    '  restriction: "negative",' \
    '  restriction: "positive",'

run_mutation "a rebrand is read as adverse" src/change-direction.ts \
    '  rebranded: "neutral",' \
    '  rebranded: "negative",'

run_mutation "a price restructure is read as harmless" src/change-direction.ts \
    '  pricing_restructured: "negative",' \
    '  pricing_restructured: "neutral",'

run_mutation "a deprecation is read as harmless" src/change-direction.ts \
    '  product_deprecated: "negative",' \
    '  product_deprecated: "neutral",'

run_mutation "a new free tier is read as adverse" src/change-direction.ts \
    '  new_free_tier: "positive",' \
    '  new_free_tier: "negative",'

echo
echo "killed ${KILLED}, survived ${SURVIVED}"
