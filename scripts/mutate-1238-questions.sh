#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/gated-vendor-answers.test.ts
  test/vendor-verdict.test.ts
  test/eligibility-disclosure.test.ts
  test/retired-vendor-page.test.ts
  test/retired-records.test.ts
)

SOURCES=(src/serve.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").qorig"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").qorig" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-out.txt 2>&1; then
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

run_mutation "the tier question ignores the gate" \
  sub src/serve.ts 'const gateStatesThereIsNoFreeTier = productionGate !== null;' 'const gateStatesThereIsNoFreeTier = false;'

run_mutation "the tier question is withheld from every page" \
  sub src/serve.ts 'const gateStatesThereIsNoFreeTier = productionGate !== null;' 'const gateStatesThereIsNoFreeTier = true;'

run_mutation "the tier question is withheld from every gated page" \
  sub src/serve.ts 'const gateStatesThereIsNoFreeTier = productionGate !== null;' 'const gateStatesThereIsNoFreeTier = primaryGate !== null;'

run_mutation "the reliability question ignores the gate" \
  sub src/serve.ts 'const reliabilityAnswerWouldRateAGatedOffer = primaryGate !== null && !offerHasEnded && !levelWithheld;' 'const reliabilityAnswerWouldRateAGatedOffer = false;'

run_mutation "the reliability question is withheld from every page" \
  sub src/serve.ts 'const reliabilityAnswerWouldRateAGatedOffer = primaryGate !== null && !offerHasEnded && !levelWithheld;' 'const reliabilityAnswerWouldRateAGatedOffer = true;'

run_mutation "the reliability question ignores an ended offer" \
  sub src/serve.ts 'const reliabilityAnswerWouldRateAGatedOffer = primaryGate !== null && !offerHasEnded && !levelWithheld;' 'const reliabilityAnswerWouldRateAGatedOffer = primaryGate !== null && !levelWithheld;'

run_mutation "the reliability question ignores a withheld level" \
  sub src/serve.ts 'const reliabilityAnswerWouldRateAGatedOffer = primaryGate !== null && !offerHasEnded && !levelWithheld;' 'const reliabilityAnswerWouldRateAGatedOffer = primaryGate !== null && !offerHasEnded;'

run_mutation "the free-tier question the gate answers is dropped too" \
  sub src/serve.ts '    { q: `Is ${vendorName} free?`, a: faqFreeAnswer },
' ''

run_mutation "the reliability answer stops naming the tier it rates" \
  sub src/serve.ts "? \`\${vendorName}'s free tier is considered stable." "? \`\${vendorName} is stable."

run_mutation "the production answer rates a gated tier again" \
  sub src/serve.ts '${primaryGate ? "It" : "We rate it stable and it"}' '${"We rate it stable and it"}'

echo
echo "killed $killed, survived $survived"
