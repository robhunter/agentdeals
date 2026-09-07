#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/superseded-terms.test.ts
  test/superseded-terms-listings.test.ts
)

SOURCES=(src/superseding-reading.ts src/superseded-description.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1424"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1424" "$f"; done; }

backup
trap 'restore; npm run build >/dev/null 2>&1' EXIT

killed=0
survived=0

run_mutation() {
  local name="$1"; shift
  restore
  if ! "$@"; then
    echo "NOT APPLIED                $name"
    return
  fi
  if ! npm run build >/dev/null 2>&1; then
    echo "KILLED (does not compile)  $name"
    killed=$((killed + 1))
    return
  fi
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1424-out.txt 2>&1; then
    echo "SURVIVED                   $name"
    survived=$((survived + 1))
  else
    echo "KILLED                     $name"
    killed=$((killed + 1))
  fi
}

sub() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if old not in text:
    sys.exit("mutation target not found in " + path)
open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
PY
}

run_mutation "the opening never moves to the sentence that names the free plan" \
  sub src/superseding-reading.ts '  if (at <= 0) return opening;' \
                                 '  if (at >= 0) return opening;'

run_mutation "the meta sentence takes a raw slice again" \
  sub src/superseded-description.ts '  const opening = punctuated(openingOfAReading(reading.terms, 90));' \
                                    '  const opening = punctuated(reading.terms.slice(0, 90));'

run_mutation "a trial-only reading goes on withholding our terms" \
  sub src/superseded-description.ts '    if (readingPricesNothingButATrial(change, offer)) continue;' \
                                    '    if (false) continue;'

run_mutation "the withholding is lifted whatever the record's tier says" \
  sub src/superseded-description.ts '  if (!tierRecordsAFreeTier(offer.tier ?? "")) return false;' \
                                    '  if (false) return false;'

run_mutation "a trial reading counts as a plan reading" \
  sub src/superseding-reading.ts '  if (!A_TRIAL.test(reading)) return false;' \
                                 '  if (true) return false;'

run_mutation "a priced reading counts as a trial" \
  sub src/superseding-reading.ts '  if (A_PLAN_PRICE.test(reading)) return false;' \
                                 '  if (false) return false;'

run_mutation "a free price inside a trial clause counts as a free plan" \
  sub src/superseding-reading.ts '    if (!isQualifiedAway(text, match.index, match[0].length)) return match.index;' \
                                 '    return match.index;'

run_mutation "a sentence denying the free plan counts as naming one" \
  sub src/superseding-reading.ts '  return !DENIES_A_FREE_PLAN.test(clauseAround(sentence, at).text);' \
                                 '  return true;'

run_mutation "the moved opening is published unmarked" \
  sub src/superseding-reading.ts '  return `${CLIPPED_TERMS_MARKER}${openingOfTerms(reading.slice(at), cap - CLIPPED_TERMS_MARKER.length)}`;' \
                                 '  return openingOfTerms(reading.slice(at), cap);'

run_mutation "the opening moves even where it already says something is free" \
  sub src/superseding-reading.ts '  if (mentionsSomethingFree(opening)) return opening;' \
                                 '  if (false) return opening;'

echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
