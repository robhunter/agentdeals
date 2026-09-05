#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/superseded-terms.test.ts"
KILLED=0
SURVIVED=0

run_mutation() {
  local label="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mutate-1103-backup
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
    cp /tmp/mutate-1103-backup "$file"
    printf '  %-58s NOT APPLIED\n' "$label"
    return
  fi
  ./node_modules/.bin/tsc > /tmp/mutate-1103-tsc 2>&1
  if [ $? -ne 0 ]; then
    printf '  %-58s killed (does not compile)\n' "$label"
    KILLED=$((KILLED + 1))
  else
    node --test --test-concurrency 1 $TESTS > /tmp/mutate-1103-out 2>&1
    if [ $? -ne 0 ]; then
      printf '  %-58s killed by %s\n' "$label" "$(grep -oE '^  ✖ .*\(' /tmp/mutate-1103-out | head -1 | sed 's/^  ✖ //; s/ ($//')"
      KILLED=$((KILLED + 1))
    else
      printf '  %-58s SURVIVED\n' "$label"
      SURVIVED=$((SURVIVED + 1))
    fi
  fi
  cp /tmp/mutate-1103-backup "$file"
  ./node_modules/.bin/tsc > /dev/null 2>&1
}

echo "── mutations of the predicate ──"

run_mutation "a change with no previous state quotes the terms" src/superseded-description.ts \
  'return quoted !== "" && quoted === comparableTerms(description);' \
  'return quoted === comparableTerms(description);'

run_mutation "the comparison stops reflowing whitespace" src/superseded-description.ts \
  'return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();' \
  'return (text ?? "").trim().toLowerCase();'

run_mutation "the comparison starts reading case" src/superseded-description.ts \
  'return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();' \
  'return (text ?? "").replace(/\s+/g, " ").trim();'

run_mutation "a resolved change still supersedes the terms" src/superseded-description.ts \
  '    if (isNoLongerInForce(change)) continue;' \
  '    if (false) continue;'

run_mutation "the oldest quoting change wins" src/superseded-description.ts \
  '    if (!newest || change.date > newest.date) newest = change;' \
  '    if (!newest || change.date < newest.date) newest = change;'

run_mutation "the terms match a substring rather than the whole" src/superseded-description.ts \
  'return quoted !== "" && quoted === comparableTerms(description);' \
  'return quoted !== "" && comparableTerms(description).includes(quoted);'

echo "── mutations of the vendor page ──"

run_mutation "the page keeps publishing the superseded terms" src/serve.ts \
  '  const publishableTerms = termsSuperseded ? "" : primary.description;' \
  '  const publishableTerms = primary.description;'

run_mutation "the description block prints them anyway" src/serve.ts \
  '      : `<p class="desc-text">${escHtmlServer(primary.description)}</p>`}' \
  '      : ``}${`<p class="desc-text">${escHtmlServer(primary.description)}</p>`}'

run_mutation "the structured description keeps the stored terms" src/serve.ts \
  '      description: termsSuperseded ? supersededTermsNotice(vendorName, termsSuperseded) : primary.description,' \
  '      description: primary.description,'

run_mutation "a zero-price Offer is published over withheld terms" src/serve.ts \
  '      ...(primaryGate || termsSuperseded' \
  '      ...(primaryGate'

run_mutation "the free-tier answer opens with yes again" src/serve.ts \
  '  const faqFreeAnswer = termsSuperseded
    ? `${gateSentencesBeforeTheTerms}${supersededTermsAnswer(vendorName, termsSuperseded)}`
    : retiredSentence' \
  '  const faqFreeAnswer = retiredSentence'

run_mutation "the tier answer restates the figures" src/serve.ts \
  '  const faqTierAnswer = termsSuperseded
    ? `${eligibilityGateSentence}${vendorName}'"'"'s free tier is called "${primary.tier}". ${supersededTermsNotice(vendorName, termsSuperseded)}`
    : retiredSentence' \
  '  const faqTierAnswer = retiredSentence'

run_mutation "the meta description reverts to the stored limits" src/serve.ts \
  '  const metaDesc = eligibilityGateSentence + (termsSuperseded
    ? `${supersededTermsMetaSentence(vendorName, termsSuperseded)} See the recorded change history${alternatives.length > 0 ? ` and ${alternatives.length} alternatives in ${primary.category}` : ""}.`
    : hasFree' \
  '  const metaDesc = eligibilityGateSentence + (hasFree'

echo
echo "killed ${KILLED}, survived ${SURVIVED}"
