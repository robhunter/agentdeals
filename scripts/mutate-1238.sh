#!/bin/bash
set -u
cd "$(dirname "$0")/.." || exit 1

TESTS="test/gated-vendor-answers.test.ts test/eligibility-disclosure.test.ts test/retired-records.test.ts test/retired-vendor-page.test.ts"

run_case() {
  local name="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mut-backup
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
n = s.count(old)
if n != 1:
    print(f"PATTERN-MISS ({n})")
    sys.exit(3)
open(path, "w").write(s.replace(old, new))
PY
  if [ $? -eq 3 ]; then cp /tmp/mut-backup "$file"; echo "SKIP     $name (pattern not found exactly once)"; return; fi
  if ! npm run build > /tmp/mut-build.log 2>&1; then
    cp /tmp/mut-backup "$file"
    echo "KILLED   $name (build)"
    return
  fi
  TZ=UTC node --test --test-concurrency 1 $TESTS > /tmp/mut-test.log 2>&1
  local code=$?
  cp /tmp/mut-backup "$file"
  if [ $code -ne 0 ]; then
    echo "KILLED   $name  <- $(grep -m1 '✖ ' /tmp/mut-test.log | sed 's/^ *//')"
  else
    echo "SURVIVED $name"
  fi
}

run_case "the free-tier answer stops reading the gate" src/serve.ts \
  '    : primaryGateBeyondEligibility
    ? `${primaryGateBeyondEligibility.reason} ${levelWithheld ? `${unconfirmedTermsPreamble}${withUnconfirmedTermsCaveat(storedTerms)}` : storedTerms}`
    : levelWithheld
    ? `${eligibilityGateSentence}${unconfirmedTermsPreamble}Our stored record says' \
  '    : levelWithheld
    ? `${eligibilityGateSentence}${unconfirmedTermsPreamble}Our stored record says'

run_case "the free-tier answer reads only the tier rule" src/serve.ts \
  '  const primaryGateBeyondEligibility = primaryGate && primaryGate.code !== "eligibility_restricted" ? primaryGate : null;' \
  '  const primaryGateBeyondEligibility = primaryGate && primaryGate.code === "not_a_free_offer" ? primaryGate : null;'

run_case "the free-tier answer is tested after the withheld level" src/serve.ts \
  '    : primaryGateBeyondEligibility
    ? `${primaryGateBeyondEligibility.reason} ${levelWithheld ? `${unconfirmedTermsPreamble}${withUnconfirmedTermsCaveat(storedTerms)}` : storedTerms}`
    : levelWithheld' \
  '    : levelWithheld && false
    ? `${primaryGateBeyondEligibility!.reason} ${levelWithheld ? `${unconfirmedTermsPreamble}${withUnconfirmedTermsCaveat(storedTerms)}` : storedTerms}`
    : levelWithheld'

run_case "the gated free-tier answer drops the stored terms" src/serve.ts \
  '? `${primaryGateBeyondEligibility.reason} ${levelWithheld ? `${unconfirmedTermsPreamble}${withUnconfirmedTermsCaveat(storedTerms)}` : storedTerms}`' \
  '? `${primaryGateBeyondEligibility.reason}`'

run_case "the gated free-tier answer drops the unverified caveat" src/serve.ts \
  '? `${primaryGateBeyondEligibility.reason} ${levelWithheld ? `${unconfirmedTermsPreamble}${withUnconfirmedTermsCaveat(storedTerms)}` : storedTerms}`' \
  '? `${primaryGateBeyondEligibility.reason} ${storedTerms}`'

run_case "the tier answer stops reading the gate" src/serve.ts \
  '    : primaryGateBeyondEligibility
    ? `${primaryGateBeyondEligibility.reason} ${levelWithheld ? `${unconfirmedTermsPreamble}${withUnconfirmedTermsCaveat(primary.description)}` : primary.description}`
    : eligibilityGateSentence + (levelWithheld' \
  '    : eligibilityGateSentence + (levelWithheld'

run_case "the production answer stops reading the gate" src/serve.ts \
  '  const faqProductionAnswer = productionGate
    ? `${productionGate.reason} ${NO_FREE_TIER_FOR_PRODUCTION}`
    : eligibilityGateSentence' \
  '  const faqProductionAnswer = eligibilityGateSentence'

run_case "the production answer takes the expiry gate only" src/serve.ts \
  'const GATES_LEAVING_NO_FREE_TIER: readonly string[] = ["not_a_free_offer", "offer_expired"];' \
  'const GATES_LEAVING_NO_FREE_TIER: readonly string[] = ["offer_expired"];'

run_case "the production answer takes the tier gate only" src/serve.ts \
  'const GATES_LEAVING_NO_FREE_TIER: readonly string[] = ["not_a_free_offer", "offer_expired"];' \
  'const GATES_LEAVING_NO_FREE_TIER: readonly string[] = ["not_a_free_offer"];'

run_case "the production answer widens to every gate" src/serve.ts \
  '  const productionGate = primaryGate && GATES_LEAVING_NO_FREE_TIER.includes(primaryGate.code) ? primaryGate : null;' \
  '  const productionGate = primaryGate;'

run_case "the production sentence changes" src/serve.ts \
  'const NO_FREE_TIER_FOR_PRODUCTION = "There is no free tier here to run in production.";' \
  'const NO_FREE_TIER_FOR_PRODUCTION = "This offer is not free.";'

run_case "the stability rating returns to a gated record" src/serve.ts \
  "\${primaryGate ? \"It\" : \"We rate it stable and it\"} offers" \
  '${"We rate it stable and it"} offers'

run_case "the stability rating leaves every record" src/serve.ts \
  "\${primaryGate ? \"It\" : \"We rate it stable and it\"} offers" \
  '${"It"} offers'

run_case "the heading stops reading the title predicate" src/serve.ts \
  '  const headline = offerHasEnded ? endedHeadline(vendorName) : hasFree ? freeTierHeadline : pricingHeadline;' \
  '  const headline = offerHasEnded ? endedHeadline(vendorName) : freeTierHeadline;'

run_case "the heading takes the pricing form everywhere" src/serve.ts \
  '  const headline = offerHasEnded ? endedHeadline(vendorName) : hasFree ? freeTierHeadline : pricingHeadline;' \
  '  const headline = offerHasEnded ? endedHeadline(vendorName) : pricingHeadline;'

run_case "the gate line reads eligibility only" src/serve.ts \
  '  const linedGate = primaryGate && primaryGate.code !== "offer_retired" ? primaryGate : null;' \
  '  const linedGate = primaryEligibilityGate;'

run_case "the gate line renders on every gated page" src/serve.ts \
  '  const linedGate = primaryGate && primaryGate.code !== "offer_retired" ? primaryGate : null;' \
  '  const linedGate = primaryGate;'

run_case "the gate line drops the reason" src/serve.ts \
  '<strong style="color:#d29922;font-family:var(--mono)">${escHtmlServer(linedGate.code)}</strong> ${escHtmlServer(linedGate.reason)} <a href="${CRITERIA_PATH}#gates">' \
  '<strong style="color:#d29922;font-family:var(--mono)">${escHtmlServer(linedGate.code)}</strong> <a href="${CRITERIA_PATH}#gates">'

run_case "the gate reads a fixed date rather than the served one" src/serve.ts \
  '  const primaryGate = gateFor(primary, servedOn);' \
  '  const primaryGate = gateFor(primary, "2020-01-01");'

npm run build > /tmp/mut-build.log 2>&1 && echo "rebuilt from restored source"
