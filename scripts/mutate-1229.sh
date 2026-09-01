#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

RETIREMENT="src/retirement.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$RETIREMENT" "$BACKUP_DIR/retirement.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/retirement.ts" "$RETIREMENT"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  npx tsc > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/retired-records.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$RETIREMENT" "$SERVE"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1229-build.log 2>&1; then
    echo "    KILLED: does not compile"
    killed=$((killed + 1))
    return
  fi
  if timeout 600 node --test $TESTS > /tmp/mutate-1229-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1229-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1229-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_nothing_is_retired() {
  py <<'PY'
p = "src/retirement.ts"
s = open(p).read()
s = s.replace("  return RETIRED_TIER.test(offer?.tier ?? \"\");", "  return false;")
open(p, "w").write(s)
PY
}

m_everything_free_is_retired() {
  py <<'PY'
p = "src/retirement.ts"
s = open(p).read()
s = s.replace(
  "const RETIRED_TIER = /\\b(?:retired|deprecated|discontinued|sunset|withdrawn)\\b/i;",
  "const RETIRED_TIER = /\\b(?:retired|deprecated|discontinued|sunset|withdrawn|free)\\b/i;")
open(p, "w").write(s)
PY
}

m_sentence_reads_the_description() {
  py <<'PY'
p = "src/retirement.ts"
s = open(p).read()
s = s.replace(
  "  return `${vendorName}'s offer is recorded as ${tier}.`;",
  "  return `${vendorName}'s offer is recorded.`;")
open(p, "w").write(s)
PY
}

m_listing_rows_keep_the_link() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  if (offerRetired(offer)) return \"\";\n", "")
open(p, "w").write(s)
PY
}

m_vendor_page_keeps_its_pricing_card() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${offerRetired(primary) ? \"\" : `<div class=\"detail-card\">", "${false ? \"\" : `<div class=\"detail-card\">")
open(p, "w").write(s)
PY
}

m_alternatives_page_keeps_its_pricing_row() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    if (!offerRetired(primary)) {\n      parts.push(`<div class=\"risk-row\"><span class=\"risk-label\">Pricing Page:",
              "    if (true) {\n      parts.push(`<div class=\"risk-row\"><span class=\"risk-label\">Pricing Page:")
open(p, "w").write(s)
PY
}

m_structured_data_keeps_the_url() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("...(offerRetired(primary) ? {} : { url: primary.url }),", "url: primary.url,")
open(p, "w").write(s)
PY
}

m_free_question_falls_through_to_yes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const faqFreeAnswer = retiredSentence\n    ? `${retiredSentence} ${storedTerms}`\n    : levelWithheld",
              "  const faqFreeAnswer = levelWithheld")
open(p, "w").write(s)
PY
}

m_tier_question_falls_through() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const faqTierAnswer = retiredSentence\n    ? `${retiredSentence} ${primary.description}`\n    : levelWithheld",
              "  const faqTierAnswer = levelWithheld")
open(p, "w").write(s)
PY
}

run_mutation "nothing is retired" m_nothing_is_retired
run_mutation "every free tier reads as retired" m_everything_free_is_retired
run_mutation "the sentence drops the tier it reports" m_sentence_reads_the_description
run_mutation "listing rows keep the outbound link" m_listing_rows_keep_the_link
run_mutation "the vendor page keeps its pricing card" m_vendor_page_keeps_its_pricing_card
run_mutation "the alternatives page keeps its pricing row" m_alternatives_page_keeps_its_pricing_row
run_mutation "structured data keeps the application URL" m_structured_data_keeps_the_url
run_mutation "the free-tier question falls through to yes" m_free_question_falls_through_to_yes
run_mutation "the tier question falls through" m_tier_question_falls_through

echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
