#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/badge-withholding.test.ts
  test/vendor-verdict.test.ts
)

SOURCES=(src/serve.ts src/vendor-verdict.ts src/badge-staleness.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1389"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1389" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1389-out.txt 2>&1; then
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

run_mutation "the badge stops asking whether the page withholds" \
  sub src/serve.ts '  if (verdict.kind === "none") {
    return { status: "withheld", label: withheldBadgeLabel(verdict.because), verifiedDate: null };
  }' \
                   '  if (verdict.kind === "none" && verdict.because.reason === "no_source") {
    return { status: "withheld", label: withheldBadgeLabel(verdict.because), verifiedDate: null };
  }'

run_mutation "the badge ignores the ranker's gate" \
  sub src/serve.ts '    gate: gateFor(primary, servedOn)?.code ?? null,
    linkUnreachable: Boolean(linkUnreachable),
  });' \
                   '    gate: null,
    linkUnreachable: Boolean(linkUnreachable),
  });'

run_mutation "the badge reads a reading it cannot attribute" \
  sub src/serve.ts '    levelWithheld: levelWithheldReason(primary, linkUnreachable),
    unconfirmableSince: "",' \
                   '    levelWithheld: null,
    unconfirmableSince: "",'

run_mutation "the badge forgets the offer has ended" \
  sub src/serve.ts '    offerEnded: offerEnded(primary),
    gate:' \
                   '    offerEnded: false,
    gate:'

run_mutation "every withheld badge gives the same reason" \
  sub src/serve.ts 'function withheldBadgeLabel(because: BadgeWithholding): string {
  return because.reason === "gated"
    ? GATED_BADGE_LABELS[because.gate]
    : WITHHELD_BADGE_LABELS[because.reason];' \
                   'function withheldBadgeLabel(because: BadgeWithholding): string {
  return because.reason === "gated"
    ? GATED_BADGE_LABELS[because.gate]
    : WITHHELD_BADGE_LABELS.no_source;'

run_mutation "a page we could not reach is blamed on a missing source" \
  sub src/serve.ts '  link_unreachable: "unrated \u2014 page unreachable",' \
                   '  link_unreachable: "unrated \u2014 no source",'

run_mutation "the screen reader gets something other than the title" \
  sub src/serve.ts 'aria-label="${escXml(leftText)}: ${escXml(rightText)}">
  <title>' \
                   'aria-label="${escXml(leftText)}">
  <title>'

run_mutation "stale wears the vendor's warning colour again" \
  sub src/serve.ts '  "stale": "#58a6ff",' \
                   '  "stale": "#d29922",'

run_mutation "a retired offer wears the colour of a state about us" \
  sub src/serve.ts '  "retired": "#f85149",' \
                   '  "retired": "#8b949e",'

run_mutation "the staleness threshold goes back inside the loop" \
  sub src/serve.ts 'if (readingIsBehindTheLoop(latestVerified, badgeStaleAfterDays(), Date.now())) {' \
                   'if (readingIsBehindTheLoop(latestVerified, 30, Date.now())) {'

run_mutation "the re-verification interval is read as the median age itself" \
  sub src/badge-staleness.ts 'return Math.max(1, 2 * medianVerificationAgeDays(verifiedDates, nowMs));' \
                             'return Math.max(1, medianVerificationAgeDays(verifiedDates, nowMs));'

run_mutation "the interval collapses to zero on a catalogue read today" \
  sub src/badge-staleness.ts 'return Math.max(1, 2 * medianVerificationAgeDays(verifiedDates, nowMs));' \
                             'return 2 * medianVerificationAgeDays(verifiedDates, nowMs);'

run_mutation "the interval is measured from the youngest reading" \
  sub src/badge-staleness.ts '  const mid = Math.floor(ages.length / 2);' \
                             '  const mid = 0;'

run_mutation "a reading exactly at the interval is called stale" \
  sub src/badge-staleness.ts 'return verificationAgeDays(verifiedDate, nowMs) > intervalDays;' \
                             'return verificationAgeDays(verifiedDate, nowMs) >= intervalDays;'

run_mutation "the gate outranks the reading in the reason the badge gives" \
  sub src/vendor-verdict.ts '  if (withholdingDecides(input)) {
    return { reason: input.levelWithheld ?? "no_source" };
  }
  if (input.gate) return { reason: "gated", gate: input.gate };' \
                            '  if (input.gate) return { reason: "gated", gate: input.gate };
  if (withholdingDecides(input)) {
    return { reason: input.levelWithheld ?? "no_source" };
  }'

run_mutation "an unreachable link no longer withholds a stable rating" \
  sub src/vendor-verdict.ts '  if (input.linkUnreachable && publishedVendorLevel(input.level, input.cause) === "stable") {
    return { reason: "link_unreachable" };
  }' \
                            '  if (false) {
    return { reason: "link_unreachable" };
  }'

run_mutation "a null level is rated stable rather than withheld" \
  sub src/vendor-verdict.ts '  if (input.level === null) return { reason: input.levelWithheld ?? "no_source" };' \
                            '  if (false) return { reason: input.levelWithheld ?? "no_source" };'

run_mutation "the stack grade hides how much of the stack it rated" \
  sub src/serve.ts 'const coverage = totalFound < vendorNames.length ? ` · ${totalFound} of ${vendorNames.length} rated` : "";' \
                   'const coverage = "";'

run_mutation "the stack grade counts a vendor it cannot rate" \
  sub src/serve.ts '    if (status === "unknown" || status === "withheld") continue;' \
                   '    if (status === "unknown") continue;'

run_mutation "the at-risk tile absorbs the stale badges again" \
  sub src/serve.ts '<div class="stat-num yellow">${statusCounts["at-risk"]}</div><div class="stat-label">At Risk</div>' \
                   '<div class="stat-num yellow">${statusCounts["at-risk"] + statusCounts.stale}</div><div class="stat-label">At Risk</div>'

run_mutation "the unrated tile counts the badges that publish" \
  sub src/serve.ts '<div class="stat-num grey">${statusCounts.withheld}</div><div class="stat-label">Unrated</div>' \
                   '<div class="stat-num grey">${statusCounts.withheld + statusCounts.active}</div><div class="stat-label">Unrated</div>'

run_mutation "the badge reads the first offer of a different vendor" \
  sub src/serve.ts '  const vendorOffers = offers.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return UNKNOWN_BADGE;

  const primary = vendorOffers[0];' \
                   '  const vendorOffers = offers.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return UNKNOWN_BADGE;

  const primary = offers[0];'

echo
echo "killed=$killed survived=$survived"
