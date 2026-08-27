#!/usr/bin/env bash
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/src/serve.ts"
BACKUP=$(mktemp)
cp "$SRC" "$BACKUP"
restore() { cp "$BACKUP" "$SRC"; (cd "$REPO" && npm run build >/dev/null 2>&1); }
trap restore EXIT

mutate() {
  FIND="$1" REPLACE="$2" python3 - "$SRC" <<'PY'
import os, sys
path = sys.argv[1]
find, replace = os.environ["FIND"], os.environ["REPLACE"]
text = open(path, encoding="utf-8").read()
if find not in text:
    sys.exit(2)
open(path, "w", encoding="utf-8").write(text.replace(find, replace, 1))
PY
}

run_case() {
  local name="$1"
  if ! cmp -s "$SRC" "$BACKUP"; then
    if (cd "$REPO" && npm run build > /tmp/mut-build.log 2>&1); then
      if (cd "$REPO" && node --test --test-concurrency 1 test/search-crawl-space.test.ts > /tmp/mut-test.log 2>&1); then
        echo "SURVIVED: $name"
      else
        echo "killed:   $name"
      fi
    else
      echo "SURVIVED (did not compile): $name"
    fi
  else
    echo "NOT APPLIED: $name"
  fi
  cp "$BACKUP" "$SRC"
}

case_run() { mutate "$2" "$3" || true; run_case "$1"; }

case_run "robots.txt drops the search disallow" \
  'User-agent: *\n${SEARCH_QUERY_DISALLOW}\nAllow: /' \
  'User-agent: *\nAllow: /'

case_run "robots.txt states the allow before the disallow" \
  'User-agent: *\n${SEARCH_QUERY_DISALLOW}\nAllow: /' \
  'User-agent: *\nAllow: /\n${SEARCH_QUERY_DISALLOW}'

case_run "the disallow names a path nothing serves" \
  'Disallow: /search?' \
  'Disallow: /nothing-we-serve'

case_run "the search page drops its robots meta" \
  "+ SEARCH_PAGE_ROBOTS_META + '\\n'
    " \
  "+ "

case_run "the search page asks to be indexed" \
  'content="noindex,follow"' \
  'content="index,follow"'

case_run "crawlRel never marks a link nofollow" \
  'return href.startsWith("/search?") ? NOFOLLOW_ATTR : "";' \
  'return "";'

case_run "crawlRel marks every link nofollow" \
  'return href.startsWith("/search?") ? NOFOLLOW_ATTR : "";' \
  'return NOFOLLOW_ATTR;'

case_run "crawlRel does not distinguish the query-bearing space" \
  'return href.startsWith("/search?")' \
  'return href.startsWith("/search")'

case_run "searchQueryAnchor drops the rel attribute" \
  "+ crawlRel(href) + attrs" \
  "+ attrs"

case_run "one hand-written search link loses its nofollow" \
  '<a href="/search?q=opentofu" rel="nofollow">' \
  '<a href="/search?q=opentofu">'

case_run "the sitemap submits the noindex search page" \
  "BASE_URL + '/stacks</loc>" \
  "BASE_URL + '/search</loc>"

case_run "the pagination link drops the page number" \
  'if (overrides.page) params.set("page", overrides.page);' \
  ''

case_run "the facet pills stop going through the anchor helper" \
  "return searchQueryAnchor(href, escHtmlServer(t.label), ' class=\"type-filter' + (isActive ? \" active\" : \"\") + '\"');" \
  "return '<a href=\"' + escHtmlServer(href) + '\" class=\"type-filter' + (isActive ? \" active\" : \"\") + '\">' + escHtmlServer(t.label) + '</a>';"
