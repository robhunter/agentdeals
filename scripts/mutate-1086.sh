#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
PROV="test/faq-provenance.test.ts"
UNIT="test/page-freshness.test.ts"
BOTH="$PROV $UNIT"

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="${5:-$BOTH}"
  cp "$file" "$file.bak"
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(old) != 1:
    print(f"SKIP: pattern found {s.count(old)} times", file=sys.stderr)
    sys.exit(3)
p.write_text(s.replace(old, new))
PY
  then
    echo "SKIP  $name (pattern stale)"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi

  if ! npm run build > /tmp/mut-1086-build.log 2>&1; then
    echo "SKIP  $name (build failed)"
    mv "$file.bak" "$file"
    npm run build > /dev/null 2>&1
    FAIL=$((FAIL + 1))
    return
  fi

  node --test --experimental-strip-types $tests > /tmp/mut-1086.log 2>&1
  local status=$?
  mv "$file.bak" "$file"
  npm run build > /dev/null 2>&1

  if [ $status -ne 0 ]; then
    echo "KILLED  $name"
    PASS=$((PASS + 1))
  else
    echo "SURVIVED  $name  <-- $tests did not notice"
    FAIL=$((FAIL + 1))
  fi
}

run_mutation "a review that found defects advances the structured date" src/page-reviews.ts \
  '  if (status.review_outcome === "fail") return record.published;
  return status.reviewed_at ?? record.published;' \
  '  return status.reviewed_at ?? record.published;'

run_mutation "a clean review holds the structured date back too" src/page-reviews.ts \
  '  if (status.review_outcome === "fail") return record.published;
  return status.reviewed_at ?? record.published;' \
  '  return record.published;'

run_mutation "the clause never says corrections are outstanding" src/faq-provenance.ts \
  'return status.review_outcome === "fail" ? `${notice}; corrections outstanding.` : `${notice}.`;' \
  'return `${notice}.`;'

run_mutation "every clause says corrections are outstanding" src/faq-provenance.ts \
  'return status.review_outcome === "fail" ? `${notice}; corrections outstanding.` : `${notice}.`;' \
  'return `${notice}; corrections outstanding.`;'

run_mutation "the clause forgets the date of the last check" src/faq-provenance.ts \
  'const notice = compiledNotice(record.published, status.reviewed_at);' \
  'const notice = compiledNotice(record.published, null);'

run_mutation "no answer carries a clause" src/faq-provenance.ts \
  'if (!clause || !statesVendorFigure(text)) return text;' \
  'return text;'

run_mutation "every answer carries a clause" src/faq-provenance.ts \
  'if (!clause || !statesVendorFigure(text)) return text;' \
  'if (!clause) return text;'

run_mutation "a page off the register still gets a clause" src/faq-provenance.ts \
  '  if (!record) return "";
  const status = reviewStatus(record, today);' \
  '  if (!record) return "Figures compiled 2026-01-01, not re-checked since.";
  const status = reviewStatus(record, today);'

run_mutation "the clause is built from a page path nobody passed" src/faq-provenance.ts \
  'const clause = pageFaqProvenanceClause(pagePath, today);' \
  'const clause = pageFaqProvenanceClause("/", today);'

run_mutation "a currency amount is not a figure" src/faq-provenance.ts \
  'if (CURRENCY_AMOUNT.test(answer) || statesQuota(answer)) return true;' \
  'if (statesQuota(answer)) return true;'

run_mutation "a quota is not a figure" src/faq-provenance.ts \
  'if (CURRENCY_AMOUNT.test(answer) || statesQuota(answer)) return true;' \
  'if (CURRENCY_AMOUNT.test(answer)) return true;'

run_mutation "a percentage we state about ourselves counts as a vendor figure" src/faq-provenance.ts \
  'return PERCENTAGE.test(answer) && !FIRST_PERSON.test(answer);' \
  'return PERCENTAGE.test(answer);'

run_mutation "a percentage never counts as a figure" src/faq-provenance.ts \
  'return PERCENTAGE.test(answer) && !FIRST_PERSON.test(answer);' \
  'return false;'

run_mutation "a count we state about ourselves counts as a vendor figure" src/faq-provenance.ts \
  'if (!FIRST_PERSON.test(answer.slice(Math.max(0, m.index - OWN_COUNT_WINDOW), m.index))) return true;' \
  'return true;'

run_mutation "a number inside a product name counts as a figure" src/faq-provenance.ts \
  '`(?<![\\w-])\\d[\\d,.]*' \
  '`\\b\\d[\\d,.]*'

run_mutation "markup reaches the structured copy" src/faq-provenance.ts \
  'return answer.replace(HTML_TAG, "").replace(/\s+/g, " ").trim();' \
  'return answer.trim();'

run_mutation "the comparison pages recommend a vendor on its stability share" src/serve.ts \
  '    {
      q: `How do ${catName.toLowerCase()} free tiers compare on limits?`,' \
  '    {
      q: `Are free ${catName.toLowerCase()} services reliable enough for production?`,
      a: `Most of the ${catName.toLowerCase()} services we track have stable pricing histories. For production use, prioritize providers rated "stable" in our analysis.`,
    },
    {
      q: `How do ${catName.toLowerCase()} free tiers compare on limits?`,'

echo
echo "killed: $PASS   survived: $FAIL"
[ "$FAIL" -eq 0 ]
