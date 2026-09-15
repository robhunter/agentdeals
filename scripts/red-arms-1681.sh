#!/bin/bash
set -u
cd "$(dirname "$0")/.."
SNAP=$(mktemp -d)
for f in src/data.ts src/change-resolution.ts src/serve.ts src/openapi.ts; do
  cp "$f" "$SNAP/$(basename $f)"
done
restore() {
  for f in src/data.ts src/change-resolution.ts src/serve.ts src/openapi.ts; do
    cp "$SNAP/$(basename $f)" "$f"
  done
}
trap 'restore; rm -rf "$SNAP"' EXIT

arm() {
  local name="$1"; shift
  restore
  "$@"
  if ! npm run build >/tmp/arm-build.log 2>&1; then
    echo "BUILD-FAIL  $name"
    return
  fi
  if node --test test/retracted-records-withheld.test.ts >/tmp/arm-test.log 2>&1; then
    echo "STILL GREEN $name"
  else
    echo "RED         $name  ($(grep -c '^  ✖' /tmp/arm-test.log) failing)"
  fi
}

arm "serve retracted by default" \
  perl -0pi -e 's/const served = audience\.includeRetracted \? results : recordsWeStandBehind\(results\);/const served = results;/' src/data.ts

arm "declare no standing on the published record" \
  perl -0pi -e 's/return \{ \.\.\.change, impact: publishedImpactOf\(change\), standing: standingOf\(change\) \};/return { ...change, impact: publishedImpactOf(change) } as PublishedDealChange;/' src/change-resolution.ts

arm "publish the stored impact of a withdrawn record" \
  perl -0pi -e 's/return theEventNeverHappened\(change\) \? WITHDRAWN_RECORDS_CARRY_NO_IMPACT : change\.impact;/return change.impact;/' src/change-resolution.ts

arm "withhold every resolved record, not only the withdrawn ones" \
  perl -0pi -e 's/const served = audience\.includeRetracted \? results : recordsWeStandBehind\(results\);/const served = audience.includeRetracted ? results : recordsStillInForce(results);/' src/data.ts

arm "report nothing withheld" \
  perl -0pi -e 's/retracted_excluded: results\.length - served\.length,/retracted_excluded: 0,/' src/data.ts

arm "accept any spelling of the parameter" \
  perl -0pi -e 's/if \(retractedParam !== null && retractedParam !== "true" && retractedParam !== "false"\) \{/if (false) {/' src/serve.ts

arm "let a withdrawn record be offered as worth knowing, defeating both guards on it" \
  bash -c 'perl -0pi -e "s/  const allResult = getDealChanges\\(since, changeType\\);/  const allResult = getDealChanges(since, changeType, undefined, undefined, undefined, { includeRetracted: true });/" src/data.ts; perl -0pi -e "s/return theEventNeverHappened\\(change\\) \\? WITHDRAWN_RECORDS_CARRY_NO_IMPACT : change\\.impact;/return change.impact;/" src/change-resolution.ts'

arm "leave the standing optional in the spec" \
  perl -0pi -e 's/            required: \["standing"\]/            required: []/' src/openapi.ts

restore
npm run build >/dev/null 2>&1
echo "--- restored ---"
git status --short
