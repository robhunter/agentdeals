#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

GATE=scripts/change-gate.js
TESTS="test/free-tier-removal-evidence.test.ts"

killed=0
total=0

run() {
  local name="$1"
  total=$((total + 1))
  if git diff --quiet $GATE; then
    echo "NOT APPLIED  $name"
    git checkout -- $GATE
    return
  fi
  if npx tsx --test $TESTS > /tmp/mutant-1336.log 2>&1; then
    echo "SURVIVED  $name"
  else
    killed=$((killed + 1))
    echo "killed    $name  ($(grep -c '^  *✖' /tmp/mutant-1336.log) failing)"
  fi
  git checkout -- $GATE
}

echo "== mutating $GATE =="

perl -0pi -e 's/if \(TAKEN_AWAY\.test\(sentence\)\) continue;/if (false) continue;/' $GATE
run "a clause that says the plan was taken away no longer suppresses the match"

perl -0pi -e 's/if \(REPLACED_BY_SOMETHING_TEMPORARY\.test\(around\)\) continue;/if (false) continue;/' $GATE
run "a trial replacing the free plan no longer suppresses the match"

perl -0pi -e 's/const QUALIFIER_WINDOW = 40;/const QUALIFIER_WINDOW = 400;/' $GATE
run "the trial qualifier may sit anywhere in the sentence"

perl -0pi -e 's{/\\bis\\s\+\\\$0\\s\*\(\?:\\/\|\\s\+per\\s\+\)\\s\*\(\?:month\|mo\|year\|yr\)\\b/i}{/\\bis\\s+\\\$0/i}' $GATE
run "a price of zero needs no period unit after it"

perl -0pi -e 's/const stated = \[record\?\.summary, record\?\.current_state\]/const stated = [record?.summary]/' $GATE
run "the rule reads the summary and not the current state"

perl -0pi -e 's/    const stillFree = clauseStatingAPlanIsStillFree\(record\);/    const stillFree = null;/' $GATE
run "the gate never consults the rule"

echo ""
echo "$killed of $total mutations killed"
[ "$killed" = "$total" ]
