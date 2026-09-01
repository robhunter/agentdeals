#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
FILES=("$SERVE")
BACKUP_DIR="$(mktemp -d)"
for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "${FILES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
  npx tsc > /dev/null 2>&1
}
trap 'restore' EXIT

killed=0
survived=0
TESTS="test/alternatives-crawl-space.test.ts test/search-crawl-space.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "${FILES[@]}"; do
    if ! diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null; then
      return 0
    fi
  done
  return 1
}

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  for f in "${FILES[@]}"; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1209-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1209-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1209-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1209-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_no_page_ever_asks_to_be_left_out() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(r'${publishesSubstitutes ? "" : NOINDEX_FOLLOW_META + "\n"}<link rel="canonical" href="${BASE_URL}/alternative-to/${slug}">',
              r'<link rel="canonical" href="${BASE_URL}/alternative-to/${slug}">')
open(p, "w").write(s)
PY
}

m_every_page_asks_to_be_left_out() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(r'${publishesSubstitutes ? "" : NOINDEX_FOLLOW_META + "\n"}<link rel="canonical" href="${BASE_URL}/alternative-to/${slug}">',
              r'${NOINDEX_FOLLOW_META + "\n"}<link rel="canonical" href="${BASE_URL}/alternative-to/${slug}">')
open(p, "w").write(s)
PY
}

m_the_page_forbids_the_links_out_as_well() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('const NOINDEX_FOLLOW_META = \'<meta name="robots" content="noindex,follow">\';',
              'const NOINDEX_FOLLOW_META = \'<meta name="robots" content="noindex,nofollow">\';')
open(p, "w").write(s)
PY
}

m_the_sitemap_submits_every_address_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      if (!alternativesPagePublishesSubstitutes(s, sitemapChanges)) continue;\n", "")
open(p, "w").write(s)
PY
}

m_the_sitemap_submits_the_empty_pages_instead() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      if (!alternativesPagePublishesSubstitutes(s, sitemapChanges)) continue;",
              "      if (alternativesPagePublishesSubstitutes(s, sitemapChanges)) continue;")
open(p, "w").write(s)
PY
}

m_the_sitemap_reads_the_removals_not_the_list() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  return vendorSubstitutes(vendorName, vendorOffers, allChanges).membership.kept.length > 0;",
              "  return vendorSubstitutes(vendorName, vendorOffers, allChanges).membership.removed.length > 0;")
open(p, "w").write(s)
PY
}

m_the_empty_page_keeps_its_questions() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const altFaqItems = publishesSubstitutes\n    ? [", "  const altFaqItems = true\n    ? [")
open(p, "w").write(s)
PY
}

m_the_empty_page_keeps_promising_a_list() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  const title = publishesSubstitutes
    ? `Best ${vendorName} Alternatives with Free Tiers (${currentYear}) | AgentDeals`
    : `${heading} — none listed yet | AgentDeals`;""",
              "  const title = `Best ${vendorName} Alternatives with Free Tiers (${currentYear}) | AgentDeals`;")
open(p, "w").write(s)
PY
}

m_the_empty_heading_keeps_promising_a_list() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  <h1>${publishesSubstitutes ? `Best ${escHtmlServer(vendorName)} Alternatives with Free Tiers (${currentYear})` : escHtmlServer(heading)}</h1>",
              "  <h1>Best ${escHtmlServer(vendorName)} Alternatives with Free Tiers (${currentYear})</h1>")
open(p, "w").write(s)
PY
}

m_the_empty_page_sends_the_reader_nowhere() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('The <a href="/category/${toSlug(homeCategory)}">${escHtmlServer(homeCategory)}</a> category lists every offer we track alongside it.',
              'The ${escHtmlServer(homeCategory)} category lists every offer we track alongside it.')
open(p, "w").write(s)
PY
}

run_mutation "no page ever asks to be left out of the index" m_no_page_ever_asks_to_be_left_out
run_mutation "every alternatives page asks to be left out of the index" m_every_page_asks_to_be_left_out
run_mutation "the page forbids the links out as well" m_the_page_forbids_the_links_out_as_well
run_mutation "the sitemap submits every vendor address again" m_the_sitemap_submits_every_address_again
run_mutation "the sitemap submits the pages that name nothing" m_the_sitemap_submits_the_empty_pages_instead
run_mutation "the sitemap reads the removals rather than the list" m_the_sitemap_reads_the_removals_not_the_list
run_mutation "the page that names nothing keeps its questions" m_the_empty_page_keeps_its_questions
run_mutation "the page that names nothing keeps promising a list" m_the_empty_page_keeps_promising_a_list
run_mutation "the heading keeps promising a list" m_the_empty_heading_keeps_promising_a_list
run_mutation "the page that names nothing sends the reader nowhere" m_the_empty_page_sends_the_reader_nowhere

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
