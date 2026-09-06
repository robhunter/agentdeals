#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/superseded-terms-listings.test.ts
  test/superseded-terms.test.ts
)

SOURCES=(src/serve.ts src/data.ts src/provenance.ts src/superseded-description.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1395"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1395" "$f"; done; }

backup
trap 'restore; npm run build >/dev/null 2>&1' EXIT

killed=0
survived=0

run_mutation() {
  local name="$1"; shift
  restore
  if ! "$@"; then
    echo "NOT APPLIED                $name"
    return
  fi
  if ! npm run build >/dev/null 2>&1; then
    echo "KILLED (does not compile)  $name"
    killed=$((killed + 1))
    return
  fi
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1395-out.txt 2>&1; then
    echo "SURVIVED                   $name"
    survived=$((survived + 1))
  else
    echo "KILLED                     $name"
    killed=$((killed + 1))
  fi
}

sub() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if old not in text:
    sys.exit("mutation target not found in " + path)
open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
PY
}

run_mutation "a listing cell publishes the stored terms again" \
  sub src/serve.ts '  return superseded
    ? supersededTermsListingHtml(offer.vendor, superseded)
    : escHtmlServer(offer.description);' \
                   '  return escHtmlServer(offer.description);'

run_mutation "structured data publishes the stored terms again" \
  sub src/serve.ts '  return superseded ? supersededTermsNotice(offer.vendor, superseded) : offer.description;' \
                   '  return offer.description;'

run_mutation "a short slot truncates the stored terms instead of withholding them" \
  sub src/serve.ts '  if (superseded) return supersededTermsMetaSentence(offer.vendor, superseded);
  return offer.description.length > cap ? `${offer.description.slice(0, cap)}...` : offer.description;' \
                   '  return offer.description.length > cap ? `${offer.description.slice(0, cap)}...` : offer.description;'

run_mutation "an opening sentence comes from the stored terms again" \
  sub src/serve.ts '  if (superseded) return supersededTermsMetaSentence(offer.vendor, superseded);
  const opening = offer.description.split(". ").slice(0, sentences).join(". ");' \
                   '  const opening = offer.description.split(". ").slice(0, sentences).join(". ");'

run_mutation "the vendor FAQ answers from the stored terms again" \
  sub src/serve.ts '  if (superseded) return supersededTermsVerdictSentence(offer.vendor, superseded);
  return `${offer.description.slice(0, 200)}${offer.description.length > 200 ? "..." : ""}`;' \
                   '  return `${offer.description.slice(0, 200)}${offer.description.length > 200 ? "..." : ""}`;'

run_mutation "the change index answers for no vendor" \
  sub src/serve.ts '  return changesByVendorName.get(vendorName.toLowerCase()) ?? [];' \
                   '  return [];'

run_mutation "the offer listing stops marking the superseded record" \
  sub src/data.ts '    const terms_superseded = supersededTermsRecordFor(offer, vendorAllChangesList.get(key) ?? []);' \
                   '    const terms_superseded = null;'

run_mutation "the single-vendor endpoint returns the raw stored record again" \
  sub src/data.ts '      ...enrichOffers([match])[0],' \
                   '      ...withLinkHealth(match), gate: gateForOffer(match), recent_change: null, expires_soon: null, risk_level: null, risk_cause: null, rating_withheld: null, stability: null, days_since_verified: 0, terms_superseded: null,'

run_mutation "the alternatives beside a vendor go back to the raw stored record" \
  sub src/data.ts '      result.alternatives = enrichOffers(sameCategoryOffers).map(o => stripReferrerValue(o));' \
                   '      result.alternatives = sameCategoryOffers.map(o => stripReferrerValue({ ...withLinkHealth(o), gate: gateForOffer(o) })) as unknown as EnrichedOffer[];'

run_mutation "the citation counts only gated records as withheld" \
  sub src/provenance.ts '  return isGated(node) || termsAreWithheld(node) || levelIsWithheld(node);' \
                   '  return isGated(node);'

run_mutation "the citation ignores a withheld set of terms" \
  sub src/provenance.ts '  return isGated(node) || termsAreWithheld(node) || levelIsWithheld(node);' \
                   '  return isGated(node) || levelIsWithheld(node);'

run_mutation "the citation ignores a withheld level" \
  sub src/provenance.ts '  return isGated(node) || termsAreWithheld(node) || levelIsWithheld(node);' \
                   '  return isGated(node) || termsAreWithheld(node);'

run_mutation "the citation reads a withheld level only from the rating field" \
  sub src/provenance.ts '  if (node.rating_withheld !== undefined && node.rating_withheld !== null) return true;
  return "risk_level" in node && node.risk_level === null;' \
                   '  return node.rating_withheld !== undefined && node.rating_withheld !== null;'

run_mutation "the marked record drops the reading behind the change" \
  sub src/superseded-description.ts '    reading: readingBehindTheChange(change),' \
                   '    reading: null,'

run_mutation "the marked record drops the sentence the vendor page prints" \
  sub src/superseded-description.ts '    notice: supersededTermsNotice(vendor, change),' \
                   '    notice: "",'

run_mutation "the category row keeps its lede figure from a superseded record" \
  sub src/serve.ts '  const topVendor = catOffers.find((o, i) => catGates[i] === null && !supersedingChangeFor(o));' \
                   '  const topVendor = catOffers.find((_, i) => catGates[i] === null);'

echo
echo "killed=$killed survived=$survived"
