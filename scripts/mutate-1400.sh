#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/stack-page-verdicts.test.ts
)

SOURCES=(src/serve.ts src/stack-claim.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1400"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1400" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1400-out.txt 2>&1; then
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

run_mutation "a removed free tier is recommendable again" \
  sub src/stack-claim.ts 'export function mayRecommendAsFree(status: StackBadgeStatus): boolean {
  return !freeTierHasEnded(status);
}' \
                         'export function mayRecommendAsFree(_status: StackBadgeStatus): boolean {
  return true;
}'

run_mutation "a retired offer counts as recommendable" \
  sub src/stack-claim.ts '  return status === "removed" || status === "retired";' \
                         '  return status === "removed";'

run_mutation "the chip states our rating rather than what the badge publishes" \
  sub src/serve.ts '    verdict: badge.label,' \
                   '    verdict: publishedVendorLevel(context.enriched.risk_level ?? null, context.enriched.risk_cause),'

run_mutation "the chip always reads active" \
  sub src/serve.ts '    verdict: badge.label,' \
                   '    verdict: "active",'

run_mutation "the table row states no verdict" \
  sub src/serve.ts '    verdict: stackVerdictChipHtml(reading),
  };' \
                   '    verdict: "",
  };'

run_mutation "the pick card states no verdict" \
  sub src/serve.ts '          ${stackVerdictChipHtml(reading, { compact: true })}
        </div>
        <p class="pick-why">${escHtmlServer(reading.recommendable ? why : reading.why)}</p>
        <p class="pick-limits">${stackKeyLimitHtml(reading, 220)}</p>' \
                   '        </div>
        <p class="pick-why">${escHtmlServer(reading.recommendable ? why : reading.why)}</p>
        <p class="pick-limits">${stackKeyLimitHtml(reading, 220)}</p>'

run_mutation "the also-consider chips keep a pick whose free tier has ended" \
  sub src/serve.ts '  const kept = readings.filter(r => r.reading === null || r.reading.recommendable);' \
                   '  const kept = readings;'

run_mutation "the limit column publishes the superseded stored terms again" \
  sub src/serve.ts '  const superseded = supersedingChangeFor(offer);
  if (!superseded) return limitCellText(offer.description, cap);
  const reading = readingBehindTheChange(superseded);
  return reading ? limitCellText(reading.terms, cap) : null;' \
                   '  return limitCellText(offer.description, cap);'

run_mutation "the limit column publishes the withholding notice instead of withholding a figure" \
  sub src/serve.ts '  return reading ? limitCellText(reading.terms, cap) : null;' \
                   '  return reading ? limitCellText(reading.terms, cap) : supersededTermsMetaSentence(offer.vendor, superseded);'

run_mutation "the limit cell truncates on a sentence boundary again" \
  sub src/serve.ts '  if (!superseded) return limitCellText(offer.description, cap);' \
                   '  if (!superseded) return openingOfTerms(offer.description, cap);'

run_mutation "the limit cell clips terms with no mark that it clipped them" \
  sub src/stack-claim.ts '  return `${kept.replace(/[,;:.]$/, "")}…`;' \
                         '  return kept.replace(/[,;:.]$/, "");'

run_mutation "the freshness statement reports only the newest reading" \
  sub src/stack-claim.ts '  return oldest === newest
    ? `${subject} read from vendor pricing pages on ${newest}.`
    : `${subject} read from vendor pricing pages between ${oldest} and ${newest}.`;' \
                         '  return `${subject} read from vendor pricing pages on ${newest}.`;'

run_mutation "the freshness statement says nothing" \
  sub src/serve.ts 'function stackFreshnessNote(readings: readonly StackPickReading[]): string {
  return escHtmlServer(stackFreshnessStatement(readings.map(r => r.verifiedDate)));
}' \
                   'function stackFreshnessNote(_readings: readonly StackPickReading[]): string {
  return "";
}'

run_mutation "the \$0 headline carries no caveat" \
  sub src/stack-claim.ts '  const unconfirmed = picks.filter(p => !p.readsActive);' \
                         '  const unconfirmed: CostHeadlinePick[] = [];'

run_mutation "the caveat counts a pick our badge will not call active as covered" \
  sub src/serve.ts '    readsActive: readsActive(r.status),' \
                   '    readsActive: r.status !== "removed",'

run_mutation "the prose keeps the sentence selling a dropped pick" \
  sub src/stack-claim.ts '  return prose
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => !names.some(name => sentence.includes(name)))
    .join(" ");' \
                         '  return prose;'

run_mutation "the confidence scale reads an ended offer as unrated" \
  sub src/stack-claim.ts '  if (holds(text, ENDED_PHRASES)) return 0;' \
                         '  if (holds(text, ENDED_PHRASES)) return 1;'

run_mutation "the confidence scale ranks a withheld rating as confident" \
  sub src/stack-claim.ts '  if (holds(text, WITHHELD_PHRASES)) return 1;' \
                         '  if (holds(text, WITHHELD_PHRASES)) return 3;'

run_mutation "the comparison accepts a page more confident than the badge" \
  sub src/stack-claim.ts '    if (pageConfidence > badgeConfidence) over.push({ ...pick, badgeConfidence, pageConfidence });' \
                         '    if (pageConfidence > badgeConfidence + 3) over.push({ ...pick, badgeConfidence, pageConfidence });'

run_mutation "an unrankable verdict passes silently" \
  sub src/stack-claim.ts '    if (verdictConfidence(pick.badgeVerdict) === null) unreadable.push({ ...pick, side: "badge" });
    else if (verdictConfidence(pick.pageVerdict) === null) unreadable.push({ ...pick, side: "page" });' \
                         '    if (false) unreadable.push({ ...pick, side: "badge" });'

run_mutation "a slot stating no verdict goes unreported" \
  sub src/stack-claim.ts '    if (/class="[^"]*\bstack-verdict\b/.test(slot)) continue;
    missing.push(link[1]);' \
                         '    continue;'

run_mutation "the older stability cell stops counting as a published verdict" \
  sub src/stack-claim.ts '|class="stability-dot"[^>]*><\/span>\s*(?:<span[^>]*>)?([A-Za-z][A-Za-z ]*)/g;' \
                         '/g;'

run_mutation "a verdict is read against the wrong vendor" \
  sub src/stack-claim.ts '    if (verdict !== "") published.push({ slug: subject, verdict });' \
                         '    if (verdict !== "") published.push({ slug: "neon", verdict });'

run_mutation "a limit is read against the vendor named in the row before it" \
  sub src/stack-claim.ts '    if (m[1] !== undefined) {
      subject = null;
      continue;
    }
    if (m[2] !== undefined) {' \
                         '    if (m[1] !== undefined) {
      continue;
    }
    if (m[2] !== undefined) {'

run_mutation "a named pick states hard-coded limits beside a record that says otherwise" \
  sub src/serve.ts '        <p class="pick-why">${escHtmlServer(reading.recommendable ? why : reading.why)}</p>
        <p class="pick-limits">${stackKeyLimitHtml(reading, 220)}</p>
      </div>`;
}

function stackAltPicksHtml' \
                   '        <p class="pick-why">${escHtmlServer(reading.recommendable ? why : reading.why)}</p>${limitsLine}
      </div>`;
}

function stackAltPicksHtml'

run_mutation "the stacks template reads its verdict from the name instead of the linked slug" \
  sub src/serve.ts '    const reading = stackReadingForSlug(s.slug);
    if (reading) templateReadings.set(s.slug, reading);' \
                   '    const reading = stackPickReading(s.vendor);
    if (reading) templateReadings.set(s.slug, reading);'

run_mutation "the stacks template states its own stability word again" \
  sub src/serve.ts '    return reading ? stackVerdictChipHtml(reading) : `<span style="color:var(--text-dim)">&mdash;</span>`;
  };
  const serviceLimitHtml' \
                   '    return `<span class="stability-dot" style="background:#3fb950" title="Stable"></span> Stable${reading ? "" : ""}`;
  };
  const serviceLimitHtml'

run_mutation "the agent stack drops its verdict column" \
  sub src/serve.ts '      const verdict = reading ? stackVerdictChipHtml(reading) : `<span style="color:var(--text-dim)">&mdash;</span>`;' \
                   '      const verdict = "";'

run_mutation "the agent stack keeps a pick whose free tier has ended" \
  sub src/serve.ts '    const recommended = readings.filter(r => r.reading === null || r.reading.recommendable);' \
                   '    const recommended = readings;'

run_mutation "the limit cell states a superseded reading with no citation" \
  sub src/serve.ts '  return `<span class="stack-limit-read" title="${escHtmlServer(`Our stored ${reading.vendor} terms are superseded. This is what ${source.label} read on ${source.date}.`)}">${escHtmlServer(limit)}</span>` +
    ` <a href="/vendor/${reading.slug}#changes" class="stack-limit-source" style="font-size:.7rem;color:var(--text-dim)">read ${escHtmlServer(source.date)}</a>`;' \
                   '  return escHtmlServer(limit);'

run_mutation "the citation link is read as part of the limit claim" \
  sub src/stack-claim.ts '    .replace(CITATION_LINK, "")
    .replace(/<[^>]*>/g, "")' \
                         '    .replace(/<[^>]*>/g, "")'

echo
echo "killed=$killed survived=$survived"
