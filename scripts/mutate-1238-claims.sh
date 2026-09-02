#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/gated-vendor-answers.test.ts
  test/vendor-verdict.test.ts
  test/eligibility-disclosure.test.ts
  test/offer-price-validity.test.ts
  test/retired-vendor-page.test.ts
  test/vendor-risk.test.ts
)

SOURCES=(src/serve.ts src/vendor-verdict.ts src/vendor-history.ts src/data.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").orig"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").orig" "$f"; done; }

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
  if node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-out.txt 2>&1; then
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

run_mutation "hasFree ignores the gate" \
  sub src/serve.ts 'const hasFree = !retiredSentence && !productionGate' 'const hasFree = !retiredSentence'

run_mutation "verdict opens on the free tier again" \
  sub src/serve.ts 'const verdictSubject = primaryGate ? primaryGate.reason : retiredSentence;' 'const verdictSubject = retiredSentence;'

run_mutation "verdict input never reports the gate" \
  sub src/serve.ts 'gated: primaryGate !== null,' 'gated: false,'

run_mutation "verdict sentence drops its gated branch" \
  sub src/vendor-verdict.ts 'if (input.gated) return vendorHistorySentence(input.vendor, level, input.cause);' ''

run_mutation "stable history sentence loses its subject" \
  sub src/vendor-history.ts 'has a stable pricing history.' 'free tier is stable.'

run_mutation "caution history sentence loses its subject" \
  sub src/vendor-history.ts 'warrants caution' "'s free tier warrants caution"

run_mutation "risky history sentence loses its subject" \
  sub src/vendor-history.ts 'is high risk' "'s free tier is high risk"

run_mutation "reliability answer drops its gated branch" \
  sub src/serve.ts '    : primaryGate
    ? `${primaryGate.reason} ${vendorHistorySentence(vendorName, riskLevel, riskCause)}${riskLevel === "stable" && vendorChanges.length > 0 ? ` ${narrowingSentence(vendorChanges)} See the pricing history below.` : ""}`' ''

run_mutation "outgrow question asked on a gated page" \
  sub src/serve.ts '...(primaryGate ? [] : [{ q: ' '...(false ? [] : [{ q: '

run_mutation "growth section rendered on a gated page" \
  sub src/serve.ts 'growthBullets.length > 0 && !discontinuedOn && !primaryGate' 'growthBullets.length > 0 && !discontinuedOn'

run_mutation "structured data publishes a zero price again" \
  sub src/serve.ts '...(primaryGate
        ? {}
        : {' '...(false
        ? {}
        : {'

run_mutation "comparison cell states no gate code" \
  sub src/serve.ts '">${escHtmlServer(gate.code)}</span>' '"></span>'

run_mutation "comparison cell is never told the gate" \
  sub src/serve.ts 'stabilityCellHtml(enriched.risk_level, riskCause, linkUnreachable, primary, primaryGate)' 'stabilityCellHtml(enriched.risk_level, riskCause, linkUnreachable, primary)'

run_mutation "production answer states no pricing history" \
  sub src/serve.ts 'is usable for prototyping and development. ${vendorHistorySentence(vendorName, riskLevel, riskCause)}' 'is usable for prototyping and development.'

run_mutation "empty history reads as a good sign again" \
  sub src/serve.ts '    : primaryGate
    ? `<p class="no-changes">No recorded pricing changes for ${escHtmlServer(vendorName)}.</p>`' ''

run_mutation "changed answer reads as a positive signal again" \
  sub src/serve.ts '    : primaryGate
    ? `No, ${vendorName} has had no recorded pricing changes.`' ''

run_mutation "verdict recommends a gated record for a workload" \
  sub src/serve.ts 'alternatives.length > 0 && !levelWithheld && !primaryGate' 'alternatives.length > 0 && !levelWithheld'

run_mutation "vendor-risk summary hardcodes the stable form" \
  sub src/data.ts 'vendorHistorySentence(offer.vendor, riskLevel, cause)' 'vendorHistorySentence(offer.vendor, "stable", cause)'

echo
echo "killed $killed, survived $survived"
