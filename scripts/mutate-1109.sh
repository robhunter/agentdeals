#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

NAMING="scripts/vendor-naming.js"
GATE="scripts/change-gate.js"
ROLLING="scripts/reverify-rolling.js"
SOURCE="src/source-check.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$NAMING" "$BACKUP_DIR/vendor-naming.js"
cp "$GATE" "$BACKUP_DIR/change-gate.js"
cp "$ROLLING" "$BACKUP_DIR/reverify-rolling.js"
cp "$SOURCE" "$BACKUP_DIR/source-check.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/vendor-naming.js" "$NAMING"
  cp "$BACKUP_DIR/change-gate.js" "$GATE"
  cp "$BACKUP_DIR/reverify-rolling.js" "$ROLLING"
  cp "$BACKUP_DIR/source-check.ts" "$SOURCE"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  npx tsc > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/vendor-naming.test.ts test/change-gate.test.ts test/change-log-writer.test.ts test/source-check.test.ts test/source-check-pages.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  local changed=0
  for f in "$NAMING" "$GATE" "$ROLLING" "$SOURCE" "$SERVE"; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1109-build.log 2>&1; then
    echo "    KILLED: does not compile"
    killed=$((killed + 1))
    return
  fi
  if timeout 600 node --test $TESTS > /tmp/mutate-1109-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1109-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1109-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_naming_rule_removed() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (!naming.named) {", "    if (false) {")
open(p, "w").write(s)
PY
}

m_naming_rule_always_fires() {
  py <<'PY'
p = "scripts/change-gate.js"
s = open(p).read()
s = s.replace("    if (!naming.named) {", "    if (true) {")
open(p, "w").write(s)
PY
}

m_text_match_ignores_boundaries() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("if (haystack.includes(` ${form} `))", "if (haystack.includes(form))")
open(p, "w").write(s)
PY
}

m_url_evidence_removed() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("  for (const form of vendorUrlForms(vendor, aliases)) {", "  for (const form of []) {")
open(p, "w").write(s)
PY
}

m_host_evidence_removed() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("  for (const label of labels) {", "  for (const label of []) {")
open(p, "w").write(s)
PY
}

m_host_prefix_removed() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace(
  "      if (label.length >= MIN_HOST_PREFIX && form.startsWith(label)) return result(true, \"host\", form);",
  "")
open(p, "w").write(s)
PY
}

m_host_keeps_public_suffix() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("const labels = hostLabels(url).slice(0, -1);", "const labels = hostLabels(url);")
open(p, "w").write(s)
PY
}

m_camel_split_removed() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("    add(camelSplit(raw));", "")
open(p, "w").write(s)
PY
}

m_tld_strip_removed() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("    add(stripTld(raw.trim().toLowerCase()));", "")
open(p, "w").write(s)
PY
}

m_distinctive_word_floor_removed() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("const MIN_DISTINCTIVE_WORD = 7;", "const MIN_DISTINCTIVE_WORD = 3;")
open(p, "w").write(s)
PY
}

m_distinctive_word_never_admitted() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("const MIN_DISTINCTIVE_WORD = 7;", "const MIN_DISTINCTIVE_WORD = 99;")
open(p, "w").write(s)
PY
}

m_qualifiers_kept_as_forms() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("const NAME_QUALIFIERS = new Set([", "const NAME_QUALIFIERS = new Set([].concat([")
s = s.replace('  "the", "and", "for", "com", "io", "dev", "co", "net", "org", "sh", "run",\n]);',
              '  "the", "and", "for", "com", "io", "dev", "co", "net", "org", "sh", "run",\n].slice(0, 0)));')
open(p, "w").write(s)
PY
}

m_fetch_failure_reads_as_not_named() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("  if (!page || !page.ok) {", "  if (false) {")
open(p, "w").write(s)
PY
}

m_thin_page_reads_as_ok() {
  py <<'PY'
p = "scripts/vendor-naming.js"
s = open(p).read()
s = s.replace("  if (!(priceSignalCount > 0)) {", "  if (false) {")
open(p, "w").write(s)
PY
}

m_verified_date_advances_anyway() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("    const sourceOk = check.outcome === SOURCE_CHECK_OK;", "    const sourceOk = true;")
open(p, "w").write(s)
PY
}

m_marker_not_written() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("  if (!dryRun) data.offers[index].source_check = check;", "")
open(p, "w").write(s)
PY
}

m_ai_mode_ignores_the_check() {
  py <<'PY'
p = "scripts/reverify-rolling.js"
s = open(p).read()
s = s.replace("      if (!sourceOk) {", "      if (false) {")
open(p, "w").write(s)
PY
}

m_empty_history_reads_as_good_news() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  }).join("\\n") : levelWithheld', '  }).join("\\n") : false')
open(p, "w").write(s)
PY
}

m_hero_keeps_its_verdict() {
  py <<'PY2'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const verdictLine2 = levelWithheld", "  const verdictLine2 = false")
open(p, "w").write(s)
PY2
}

m_table_keeps_its_value() {
  py <<'PY2'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const withheld = offer ? levelWithheldReason(offer, null) : null;", "  const withheld = null;")
open(p, "w").write(s)
PY2
}

m_faq_keeps_its_answer() {
  py <<'PY2'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const faqReliableAnswer = levelWithheld", "  const faqReliableAnswer = false")
open(p, "w").write(s)
PY2
}

m_level_published_anyway() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace("  return levelWithheldReason(offer, linkUnreachable) !== null;", "  return Boolean(linkUnreachable);")
open(p, "w").write(s)
PY
}

m_thin_page_also_withholds_the_level() {
  py <<'PY'
p = "src/source-check.ts"
s = open(p).read()
s = s.replace('  return offer.source_check?.outcome === "does_not_name_vendor";',
              '  return offer.source_check ? offer.source_check.outcome !== "ok" : false;')
open(p, "w").write(s)
PY
}

run_mutation "the naming rule never fires" m_naming_rule_removed
run_mutation "the naming rule always fires" m_naming_rule_always_fires
run_mutation "a name matches anywhere inside a longer word" m_text_match_ignores_boundaries
run_mutation "the URL is not read as evidence" m_url_evidence_removed
run_mutation "the host is not read as evidence" m_host_evidence_removed
run_mutation "a host label that opens the name no longer counts" m_host_prefix_removed
run_mutation "the public suffix counts as a host label" m_host_keeps_public_suffix
run_mutation "a camelCase brand is not split" m_camel_split_removed
run_mutation "a name written as a domain keeps its TLD" m_tld_strip_removed
run_mutation "any word of a multi-word name is distinctive" m_distinctive_word_floor_removed
run_mutation "no word of a multi-word name is distinctive" m_distinctive_word_never_admitted
run_mutation "product qualifiers count as names" m_qualifiers_kept_as_forms
run_mutation "a failed fetch is reported as an unnamed page" m_fetch_failure_reads_as_not_named
run_mutation "a page stating no terms is reported as verified" m_thin_page_reads_as_ok
run_mutation "verifiedDate advances whatever the page said" m_verified_date_advances_anyway
run_mutation "the outcome is never written to the record" m_marker_not_written
run_mutation "AI mode stamps a date the check refused" m_ai_mode_ignores_the_check
run_mutation "the page still calls an empty history good news" m_empty_history_reads_as_good_news
run_mutation "the hero still opens with a stability verdict" m_hero_keeps_its_verdict
run_mutation "the comparison table still prints a stability value" m_table_keeps_its_value
run_mutation "the reliability answer still calls it stable" m_faq_keeps_its_answer
run_mutation "a withheld level is published anyway" m_level_published_anyway
run_mutation "a thin page also withholds the level" m_thin_page_also_withholds_the_level

echo ""
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
