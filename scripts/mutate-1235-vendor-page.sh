#!/bin/bash
set -u
cd "$(dirname "$0")/.." || exit 1

TESTS="test/retired-vendor-page.test.ts test/retired-ranking.test.ts test/vendor-verdict.test.ts test/tier-vocabulary.test.ts test/ranking.test.ts"

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
  TZ=UTC node --test $TESTS > /tmp/mut-test.log 2>&1
  local code=$?
  cp /tmp/mut-backup "$file"
  if [ $code -ne 0 ]; then
    echo "KILLED   $name  <- $(grep -m1 '✖ ' /tmp/mut-test.log | sed 's/^ *//')"
  else
    echo "SURVIVED $name"
  fi
}

run_case "the quick verdict stops reading the ending" src/vendor-verdict.ts \
  '  if (input.offerEnded) return endedVerdictSentence();' \
  '  if (false) return endedVerdictSentence();'

run_case "the quick verdict reads withholding first" src/vendor-verdict.ts \
  '  if (input.offerEnded) return endedVerdictSentence();
  if (withholdingDecides(input)) {' \
  '  if (withholdingDecides(input)) {
    if (input.offerEnded) return endedVerdictSentence();'

run_case "the verdict word still rates an ended offer" src/vendor-verdict.ts \
  '  if (input.offerEnded) return null;
  if (withholdingDecides(input)) return null;' \
  '  if (withholdingDecides(input)) return null;'

run_case "the history block stops reading the ending" src/serve.ts \
  '  }).join("\n") : offerHasEnded
    ? `<p class="no-changes">${escHtmlServer(endedHistorySentence(vendorName))}</p>`
    : levelWithheld' \
  '  }).join("\n") : levelWithheld'

run_case "the history block reads withholding first" src/serve.ts \
  '  }).join("\n") : offerHasEnded
    ? `<p class="no-changes">${escHtmlServer(endedHistorySentence(vendorName))}</p>`
    : levelWithheld' \
  '  }).join("\n") : levelWithheld
    ? `<p class="no-changes">No recorded pricing changes for ${escHtmlServer(vendorName)} — but ${escHtmlServer(withheldClause)}, so nothing we have read describes these terms. Treat the empty history as a statement about our records, not about this vendor'"'"'s pricing.</p>`
    : offerHasEnded'

run_case "the reliability answer stops reading the ending" src/serve.ts \
  '  const faqReliableAnswer = offerHasEnded
    ? endedReliabilitySentence(vendorName)
    : levelWithheld' \
  '  const faqReliableAnswer = levelWithheld'

run_case "the reliability answer reads withholding first" src/serve.ts \
  '  const faqReliableAnswer = offerHasEnded
    ? endedReliabilitySentence(vendorName)
    : levelWithheld
    ? `We cannot say.' \
  '  const faqReliableAnswer = levelWithheld
    ? `We cannot say.'

run_case "the change answer stops reading the ending" src/serve.ts \
  '    : offerHasEnded
    ? endedEmptyChangeHistorySentence(vendorName)
    : levelWithheld' \
  '    : levelWithheld'

run_case "the change answer drops the ending after recorded changes" src/serve.ts \
  '${offerHasEnded ? ` ${ENDED_SINCE_CHANGES_SENTENCE}` : ""}' \
  ''

run_case "the heading keeps the free-tier form" src/serve.ts \
  '  <h1>${offerHasEnded ? escHtmlServer(endedHeadline(vendorName)) : `${escHtmlServer(vendorName)} Free Tier ${currentYear}`}${h1RiskBadge}</h1>' \
  '  <h1>${escHtmlServer(vendorName)} Free Tier ${currentYear}${h1RiskBadge}</h1>'

run_case "the badge keeps the risk word" src/serve.ts \
  '  const h1RiskBadge = offerHasEnded
    ? ` <span class="risk-badge" style="background:${retiredBadgeColor}20;color:${retiredBadgeColor};border:1px solid ${retiredBadgeColor}40">${ENDED_BADGE_LABEL}</span>`
    : enriched.risk_level === null' \
  '  const h1RiskBadge = enriched.risk_level === null'

run_case "the page reads the loose retirement predicate, not the ended vocabulary" src/serve.ts \
  '  const offerHasEnded = offerEnded(primary);' \
  '  const offerHasEnded = offerRetired(primary);'

run_case "the closed legacy tier is matched loosely" src/ranking.ts \
  '{ pattern: /^legacy free$/i, note: "a free tier closed to new accounts" }' \
  '{ pattern: /legacy free/i, note: "a free tier closed to new accounts" }'

run_case "the closed legacy tier has no rule" src/ranking.ts \
  '  { pattern: /^legacy free$/i, note: "a free tier closed to new accounts" },
' \
  ''

run_case "the verdict sentence loses its second half" src/retirement.ts \
  'return "This offer has ended — we keep the page for the record and no longer rate it.";' \
  'return "This offer has ended.";'

run_case "the history sentence stops denying stability" src/retirement.ts \
  ' An empty history is not evidence of stability here.`;' \
  '`;'

run_case "the reliability sentence stops saying why we keep the page" src/retirement.ts \
  ' We keep the page so the question has an answer, but a stability judgement only applies to an offer you can still get.`;' \
  '`;'

run_case "the empty-history answer reads as a stable one" src/retirement.ts \
  ', not a stable one.`;' \
  '.`;'

run_case "the shared clause changes under every form that embeds it" src/retirement.ts \
  'export const ENDED_OFFER_CLAUSE = "the offer has ended";' \
  'export const ENDED_OFFER_CLAUSE = "the offer is ended";'

run_case "the heading loses the retirement word" src/retirement.ts \
  'return `${vendorName} — free tier retired`;' \
  'return `${vendorName} — free tier`;'
