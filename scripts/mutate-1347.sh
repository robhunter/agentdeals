#!/usr/bin/env bash
set -u
WT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$WT" || exit 1

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="$5"
  cp "$file" /tmp/mut-orig.$$ || return 1
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if frm not in s:
    print("PATTERN NOT FOUND", file=sys.stderr); sys.exit(2)
p.write_text(s.replace(frm, to, 1))
PY
  then
    echo "BROKEN MUTATION: $name"
    cp /tmp/mut-orig.$$ "$file"
    return 1
  fi
  if ! npm run build >/dev/null 2>&1; then
    echo "COMPILE-KILLED: $name"
    cp /tmp/mut-orig.$$ "$file"; npm run build >/dev/null 2>&1
    return 0
  fi
  if node --test --test-concurrency 1 $tests >/tmp/mut-out.$$ 2>&1; then
    echo "SURVIVED: $name"
  else
    echo "KILLED: $name"
  fi
  cp /tmp/mut-orig.$$ "$file"
  npm run build >/dev/null 2>&1
}

T="test/conditional-request.test.ts test/page-lastmod.test.ts test/not-found-accounting.test.ts test/vendor-series.test.ts"

run_mutation "the handler ignores the conditional request" src/serve.ts \
    'if (status === 200 && isNotModified(revalidation, revalidationDayHeader(url.pathname, url.search))) {' \
    'if (false && isNotModified(revalidation, revalidationDayHeader(url.pathname, url.search))) {' "$T"

run_mutation "a day taken from a record validates a revalidation too" src/serve.ts \
    'function revalidationDayHeader(pathname: string, search: string): string | null {
  const dated = datedUrl(pathname, search);
  if (!dated) return null;
  const day = renderedBodyDay(dated);' \
    'function revalidationDayHeader(pathname: string, search: string): string | null {
  const dated = datedUrl(pathname, search);
  if (!dated) return null;
  const day = sitemapDayFor(dated);' "$T"

run_mutation "a copy taken on the page's own day is treated as out of date" src/conditional-request.ts \
    'return served <= asked;' \
    'return served < asked;' "$T"

run_mutation "every revalidation is answered not-modified" src/conditional-request.ts \
    'return served <= asked;' \
    'return true;' "$T"

run_mutation "a request naming no date revalidates anyway" src/conditional-request.ts \
    'return parseHttpDate(request.ifModifiedSince) !== null;' \
    'return true;' "$T"

run_mutation "a write method revalidates too" src/conditional-request.ts \
    'if (request.method !== "GET" && request.method !== "HEAD") return false;' \
    'if (request.method === "TRACE") return false;' "$T"

run_mutation "an entity tag no longer defers the decision" src/conditional-request.ts \
    'if (request.ifNoneMatch !== undefined) return false;' \
    'if (request.ifNoneMatch === "never") return false;' "$T"

run_mutation "any date-shaped string is read as an HTTP date" src/conditional-request.ts \
    '  if (IMF_FIXDATE.test(trimmed)) {
    const at = Date.parse(trimmed);
    return Number.isNaN(at) ? null : at;
  }' \
    '  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;' "$T"

run_mutation "an asctime date is read in the zone the server happens to run in" src/conditional-request.ts \
    '  const at = Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(at) ? null : at;' \
    '  const at = new Date(Number(year), MONTHS.indexOf(month!), Number(day), Number(hour), Number(minute), Number(second)).getTime();
  return Number.isNaN(at) ? null : at;' "$T"

run_mutation "a query string is dated as if it were the page" src/conditional-request.ts \
    '  if (search) return null;' \
    '  if (search === "?never") return null;' "$T"

run_mutation "the not-modified response describes a body it does not send" src/conditional-request.ts \
    'if (/^content-(type|length)$/i.test(name)) continue;' \
    'if (/^content-(length)$/i.test(name)) continue;' "$T"

run_mutation "a vendor page is dated from no sitemap entry at all" src/serve.ts \
    '  if (pagePath.startsWith("/vendor/")) {
    const slug = pagePath.slice("/vendor/".length);
    return vendorSlugMap.has(slug) ? vendorPageDay(slug, utcToday()) : null;
  }' \
    '  if (pagePath.startsWith("/vendor/")) {
    return null;
  }' "$T"

run_mutation "a category page is dated from no sitemap entry at all" src/serve.ts \
    '  if (pagePath.startsWith("/category/")) {
    const slug = pagePath.slice("/category/".length);
    return categorySlugMap.has(slug) ? categoryPageDay(slug, utcToday()) : null;
  }' \
    '  if (pagePath.startsWith("/category/")) {
    return null;
  }' "$T"

run_mutation "a vendor page takes the day the build shipped instead of its own" src/serve.ts \
    'return vendorSlugMap.has(slug) ? vendorPageDay(slug, utcToday()) : null;' \
    'return vendorSlugMap.has(slug) ? UNREAD_PAGE_DAY : null;' "$T"

run_mutation "the homepage is dated from the newest record rather than its own body" src/serve.ts \
    "+ '  <url>\\n    <loc>' + BASE_URL + '/</loc>\\n    <lastmod>' + pageLastmod(\"/\") + '</lastmod>" \
    "+ '  <url>\\n    <loc>' + BASE_URL + '/</loc>\\n    <lastmod>' + latestVerified + '</lastmod>" "$T"

run_mutation "the homepage tells no cache how long to hold it" src/serve.ts \
    'res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(landingPageHtml);' \
    'res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(landingPageHtml);' "$T"

run_mutation "a page answered as unchanged is counted as a redirect elsewhere" src/stats.ts \
    '  if (statusCode === NOT_MODIFIED) return "served";' \
    '  if (statusCode === 999) return "served";' "$T"

run_mutation "a vendor's series drops the clients that revalidated" src/vendor-series.ts \
    'if (requestOutcome(input.status) !== "served") return;' \
    'if (!(input.status >= 200 && input.status < 300)) return;' "$T"
