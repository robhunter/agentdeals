#!/bin/bash
set -u
cd "$(dirname "$0")/.."
FILES="src/serve.ts data/vendor_merges.json test/rendered-vendor-links-resolve.test.ts"
SNAP=$(mktemp -d)
for f in $FILES; do cp "$f" "$SNAP/$(basename $f)"; done
restore() { for f in $FILES; do cp "$SNAP/$(basename $f)" "$f"; done; }
trap 'restore; rm -rf "$SNAP"; git status --short' EXIT

arm() {
  local name="$1"; shift
  restore
  "$@"
  if ! npm run build >/tmp/arm-1679-build.log 2>&1; then
    echo "BUILD-FAIL  $name"
    return
  fi
  if node --test test/rendered-vendor-links-resolve.test.ts >/tmp/arm-1679-test.log 2>&1; then
    echo "STILL GREEN $name"
  else
    echo "RED         $name  ($(grep -c '^  ✖' /tmp/arm-1679-test.log) failing)"
  fi
}

arm "a hand-written page links a slug the catalogue does not answer" \
  perl -0pi -e 's{\$\{handwrittenVendorLinkHtml\("census", "Census"\)\}}{<a href="/vendor/census">Census</a>}' src/serve.ts

arm "the merge registry stops declaring the slug a hand-written page types" \
  perl -0pi -e 's{    \{ "retired": "AnonAddy", "survivor": "addy.io" \},\n}{}' data/vendor_merges.json

arm "the shutdown card links a vendor profile whatever the slug resolves to" \
  python3 scripts/mutate-1679.py shutdown-link

arm "a comparison table derives its vendor path from the display name again" \
  python3 scripts/mutate-1679.py display-name-slugify

arm "the merge registry and the display-name slugify are both reverted" \
  python3 scripts/mutate-1679.py display-name-slugify merge-anthropic

arm "the sweep reads the rendered script source as though it were a link" \
  python3 scripts/mutate-1679.py read-script-source

arm "the sweep skips the routes it could not read" \
  python3 scripts/mutate-1679.py skip-routes
