#!/bin/bash
set -u
cd "$(dirname "$0")/.." || exit 1

TESTS="test/retired-ranking.test.ts test/retired-records.test.ts test/ranking.test.ts test/tier-vocabulary.test.ts test/eligibility-disclosure.test.ts"

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
  if [ $? -eq 3 ]; then cp /tmp/mut-backup "$file"; echo "SKIP    $name (pattern not found exactly once)"; return; fi
  if ! npm run build > /tmp/mut-build.log 2>&1; then
    cp /tmp/mut-backup "$file"
    echo "KILLED  $name (build)"
    return
  fi
  node --test $TESTS > /tmp/mut-test.log 2>&1
  local code=$?
  cp /tmp/mut-backup "$file"
  if [ $code -ne 0 ]; then
    echo "KILLED  $name  <- $(grep -m1 '✖ ' /tmp/mut-test.log | sed 's/^ *//')"
  else
    echo "SURVIVED $name"
  fi
}

run_case "the ranker stops consulting the retirement gate" src/ranking.ts \
  '  const retired = retiredGateFor(offer);
  if (retired) return retired;' \
  '  const retired = null as ReturnType<typeof retiredGateFor>;
  if (retired) return retired;'

run_case "the gate predicate widens to the one the vendor page uses" src/ranking.ts \
  'export function retiredGateFor(offer: Pick<Offer, "tier" | "vendor">): Gate | null {
  if (!offerEnded(offer)) return null;' \
  'export function retiredGateFor(offer: Pick<Offer, "tier" | "vendor">): Gate | null {
  if (!/retired|deprecated|discontinued|sunset|withdrawn/i.test(offer.tier)) return null;'

run_case "the retirement gate is ordered behind the eligibility gate" src/ranking.ts \
  '  const retired = retiredGateFor(offer);
  if (retired) return retired;
  const restricted = eligibilityGateFor(offer);
  if (restricted) return restricted;' \
  '  const restricted = eligibilityGateFor(offer);
  if (restricted) return restricted;
  const retired = retiredGateFor(offer);
  if (retired) return retired;'

run_case "the ended vocabulary loses the value the data uses" src/retirement.ts \
  'export const ENDED_TIERS = ["Retired", "Discontinued", "Sunset", "Withdrawn"] as const;' \
  'export const ENDED_TIERS = ["Discontinued", "Sunset", "Withdrawn"] as const;'

run_case "an ended tier falls through to the free class again" src/ranking.ts \
  '  if (offerEnded({ tier })) return { class: "retired", note: RETIRED_TIER_NOTE };' \
  '  if (false) return { class: "retired", note: RETIRED_TIER_NOTE };'

run_case "the ended tier is matched loosely instead of exactly" src/retirement.ts \
  '  return ENDED_TIER_SET.has((offer?.tier ?? "").trim().toLowerCase());' \
  '  return [...ENDED_TIER_SET].some(t => (offer?.tier ?? "").toLowerCase().includes(t));'

run_case "the new gate code is left undocumented on the criteria page" src/ranking.ts \
  '  {
    code: "offer_retired",
    description:
      "The tier we hold records the offer as ended. The vendor page stays up, because it answers the question the reader arrived with, but a withdrawn offer is not ranked at any position.",
  },' \
  ''

run_case "the best-of lede counts the ranked set instead of the picks it renders" src/serve.ts \
  '  const pickCount = qualified.length;' \
  '  const pickCount = ranking.ranked.length;'

run_case "the gate reason drops the tier it is reporting" src/retirement.ts \
  '  return `${vendorName}'"'"'s offer is recorded as ${tier}.`;' \
  '  return `${vendorName}'"'"'s offer is recorded.`;'
