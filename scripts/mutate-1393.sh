#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/compare-free-tier-claim.test.ts
  test/comparison-verdict.test.ts
  test/badge-withholding.test.ts
)

SOURCES=(src/serve.ts src/vendor-verdict.ts src/comparison-verdict.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1393"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1393" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1393-out.txt 2>&1; then
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

run_mutation "the comparison decides the free tier by searching the description again" \
  sub src/serve.ts '  const freeSideA = freeTierSideOf(a.vendor, a.tier, contextA);
  const freeSideB = freeTierSideOf(b.vendor, b.tier, contextB);' \
                   '  const freeSideA: FreeTierSide = { vendor: a.vendor, free: a.tier.toLowerCase() !== "none" && !a.description.toLowerCase().includes("no free tier") ? { states: "offered", tier: a.tier } : { states: "ended" } };
  const freeSideB: FreeTierSide = { vendor: b.vendor, free: b.tier.toLowerCase() !== "none" && !b.description.toLowerCase().includes("no free tier") ? { states: "offered", tier: b.tier } : { states: "ended" } };'

run_mutation "a withheld verdict is read as a free tier" \
  sub src/vendor-verdict.ts '  if (badge.kind === "none") return { states: "unconfirmed", because: badge.because };' \
                            '  if (badge.kind === "none") return { states: "offered", level: "stable" };'

run_mutation "a recorded removal no longer ends the free tier" \
  sub src/vendor-verdict.ts '  if (badge.word === "risky" && input.cause) return { states: "ended", how: "removed", cause: input.cause };' \
                            '  if (false && input.cause) return { states: "ended", how: "removed", cause: input.cause };'

run_mutation "an ended offer is read as a rated one" \
  sub src/vendor-verdict.ts '  if (badge.kind === "ended") return { states: "ended", how: "retired" };' \
                            '  if (false) return { states: "ended", how: "retired" };'

run_mutation "an at-risk rating stops counting as a free tier" \
  sub src/vendor-verdict.ts '  return { states: "offered", level: badge.word };' \
                            '  return badge.word === "caution" ? { states: "ended", how: "retired" } : { states: "offered", level: badge.word };'

run_mutation "the comparison publishes terms our own record supersedes" \
  sub src/serve.ts '  const descBlockHtml = (vendor: string, description: string, superseded: typeof supersededA) =>
    superseded' \
                   '  const descBlockHtml = (vendor: string, description: string, superseded: typeof supersededA) =>
    false && superseded'

run_mutation "the structured data keeps the superseded description" \
  sub src/serve.ts '          description: superseded ? supersededTermsNotice(v.vendor, superseded) : v.description,' \
                   '          description: v.description,'

run_mutation "every side gets a zero-priced Offer again" \
  sub src/serve.ts '          ...(free.states === "offered" && !superseded
            ? { offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: v.tier } }
            : {}),' \
                   '          offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: v.tier },'

run_mutation "no side gets an Offer at all" \
  sub src/serve.ts '          ...(free.states === "offered" && !superseded
            ? { offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: v.tier } }
            : {}),' \
                   '          ...({}),'

run_mutation "a superseded side still publishes a zero price" \
  sub src/serve.ts '          ...(free.states === "offered" && !superseded' \
                   '          ...(free.states === "offered"'

run_mutation "the FAQ takes its provenance from the bare slug again" \
  sub src/serve.ts '  const faqJsonLd = faqPageJsonLd("/compare/" + slug, faqItems);' \
                   '  const faqJsonLd = faqPageJsonLd("/" + slug, faqItems);'

run_mutation "a side we do not rate is announced as offering a free tier" \
  sub src/comparison-verdict.ts '      `We are not publishing a free-tier verdict for ${unsettled.vendor}.`,' \
                                '      `${unsettled.vendor} offers a free tier ("Free").`,'

run_mutation "the withheld side is named but its reason is dropped" \
  sub src/comparison-verdict.ts '      settledSideOpening(settled),
      `We are not publishing a free-tier verdict for ${unsettled.vendor}.`,
      whyUnconfirmed(unsettled),' \
                                '      settledSideOpening(settled),
      `We are not publishing a free-tier verdict for ${unsettled.vendor}.`,
      "",'

run_mutation "the sentence names the ended side as the one offering a free tier" \
  sub src/comparison-verdict.ts '  if (a.free.states === "offered") return [oneOffersSentence(a, b, forFaq)];
  if (b.free.states === "offered") return [oneOffersSentence(b, a, forFaq)];' \
                                '  if (a.free.states === "offered") return [oneOffersSentence(b, a, forFaq)];
  if (b.free.states === "offered") return [oneOffersSentence(a, b, forFaq)];'

run_mutation "two ended sides are announced as offering free tiers" \
  sub src/comparison-verdict.ts '  return [neitherOffersSentence(a, b, forFaq)];' \
                                '  return [bothOfferSentence(a, b, forFaq)];'

run_mutation "a reason both clauses reach is printed twice" \
  sub src/comparison-verdict.ts '    if (sentence === "" || said.has(sentence)) continue;' \
                                '    if (sentence === "") continue;'

run_mutation "the gate stops explaining itself" \
  sub src/serve.ts '  if (because.reason === "gated") return context.gate?.reason ?? "";' \
                   '  if (because.reason === "gated") return "";'

run_mutation "the comparison reads the first offer of a different vendor" \
  sub src/serve.ts '  const vendorOffers = offers.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return null;

  const primary = vendorOffers[0];' \
                   '  const vendorOffers = offers.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return null;

  const primary = offers[0];'

echo
echo "killed=$killed survived=$survived"
