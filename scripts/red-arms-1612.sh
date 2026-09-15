#!/bin/bash
# Proves each arm of the #1612 change goes red when the code it covers is reverted.
# Restores from a cp snapshot taken at the top — never from the index.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
SNAP="$(mktemp -d)"
TARGET="test/comparison-source-citation.test.ts"

for f in src/source-citation.ts src/page-reviews.ts src/serve.ts; do
  mkdir -p "$SNAP/$(dirname "$f")"
  cp "$f" "$SNAP/$f"
done

restore() {
  for f in src/source-citation.ts src/page-reviews.ts src/serve.ts; do cp "$SNAP/$f" "$f"; done
}

arm() {
  local name="$1"
  echo "=== $name ==="
  npm run build >/dev/null 2>&1 || { echo "  BUILD FAILED"; restore; return; }
  node --test "$TARGET" 2>&1 | grep -E "^  (✔|✖)" | grep "✖" | sed 's/^/  RED: /'
  node --test "$TARGET" 2>&1 | grep -cE "^  ✖" | sed 's/^/  red arms: /'
  restore
}

echo "--- baseline ---"
npm run build >/dev/null 2>&1
node --test "$TARGET" 2>&1 | grep -E "^ℹ (pass|fail)"

python3 - <<'PY'
import re, pathlib
p = pathlib.Path("src/source-citation.ts")
s = p.read_text()
s = s.replace(
    "export function missingSourceLabel(missing: SourceMissing): string {\n  return MISSING_SOURCE_LABELS[missing.kind];\n}",
    "export function missingSourceLabel(missing: SourceMissing): string {\n  return missing.kind === missing.kind ? \"Unsourced\" : \"Unsourced\";\n}",
)
p.write_text(s)
PY
arm "one word for every case (missingSourceLabel collapsed)"

python3 - <<'PY'
import pathlib
p = pathlib.Path("src/source-citation.ts")
s = p.read_text()
s = s.replace(
    'if (offerRetired(offer)) return { cited: false, kind: "ended", clause: ENDED_OFFER_CLAUSE };',
    'if (offerRetired(offer)) return { cited: false, kind: "unconfirmed", clause: ENDED_OFFER_CLAUSE };',
)
p.write_text(s)
PY
arm "an ended offer graded as one we could not confirm"

python3 - <<'PY'
import pathlib
p = pathlib.Path("src/serve.ts")
s = p.read_text()
s = s.replace(
    "out += html.slice(cursor, slot.cellEnd) + serviceSourceMarkerHtml(service, escHtmlServer);",
    "out += html.slice(cursor, slot.cellEnd) + (service.source.cited\n      ? citedSourceLinkHtml(service.source, escHtmlServer)\n      : uncitedSourceTagHtml(service.source, escHtmlServer));",
)
s = s.replace(
    'import { CHECK_ESTABLISHES, CHECK_SCOPE_CLASS, NO_CATALOGUE_RECORD_SOURCE, citedSourcesListHtml,',
    'import { CHECK_ESTABLISHES, CHECK_SCOPE_CLASS, NO_CATALOGUE_RECORD_SOURCE, citedSourceLinkHtml, citedSourcesListHtml,',
)
p.write_text(s)
PY
arm "a tabulated row's marker carrying the clause only in an attribute"

python3 - <<'PY'
import pathlib
p = pathlib.Path("src/serve.ts")
s = p.read_text()
s = s.replace(
    "for (const slot of tabulatedVendorSlots(staticHtml, namedVendorSlug)) {",
    "for (const slot of tabulatedSubjectSlots(staticHtml, namedVendorSlug)) {",
)
s = s.replace("tabulatedVendorSlots, tabulatedVendors,", "tabulatedSubjectSlots, tabulatedVendorSlots, tabulatedVendors,")
p.write_text(s)
PY
arm "the marking pass reading only rows that state a figure"

python3 - <<'PY'
import pathlib
p = pathlib.Path("src/page-reviews.ts")
s = p.read_text()
s = s.replace(
    "    .filter(row => row.statesAFigure || row.linksToItsVendorPage)\n    .map(asSubjectSlot);",
    "    .filter(row => row.statesAFigure)\n    .map(asSubjectSlot);",
)
p.write_text(s)
PY
arm "a row stating its terms in words left out of the widened rule"

restore
npm run build >/dev/null 2>&1
echo "--- restored ---"
git status --short -- src/
node --test "$TARGET" 2>&1 | grep -E "^ℹ (pass|fail)"
rm -rf "$SNAP"
