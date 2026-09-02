#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/api-gate-field.test.ts
)

SOURCES=(src/data.ts src/serve.ts src/server.ts src/gate-disclosure.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").gorig"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").gorig" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-out.txt 2>&1; then
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

run_mutation "the per-offer gate is always null" \
  sub src/data.ts 'gate: gateFor(offer, servedOn) };' 'gate: null };'

run_mutation "the per-offer gate reads one gate code out of five, as the surfaces did before" \
  sub src/data.ts 'gate: gateFor(offer, servedOn) };' \
                  'gate: gateFor(offer, servedOn)?.code === "eligibility_restricted" ? gateFor(offer, servedOn) : null };'

run_mutation "the vendor detail carries no gate" \
  sub src/data.ts 'gate: gateForOffer(match),' 'gate: null,'

run_mutation "the alternatives on a vendor detail always report no gate" \
  sub src/data.ts 'stripReferrerValue({ ...withLinkHealth(o), gate: gateForOffer(o) })' 'stripReferrerValue({ ...withLinkHealth(o), gate: null })'

run_mutation "vendor-risk rates a gated offer again" \
  sub src/data.ts 'risk_level: gate || (cannotVouchForLevel(offer, linkUnreachable) && riskLevel === "stable") ? null : riskLevel,' \
                  'risk_level: cannotVouchForLevel(offer, linkUnreachable) && riskLevel === "stable" ? null : riskLevel,'

run_mutation "vendor-risk reassures about a gated offer again" \
  sub src/data.ts 'summary = `${gateRiskSummary(gate)}${unreadCitation}`;' \
                  'summary = `${vendorHistorySentence(offer.vendor, "stable", cause)} Free tier verified for ${longevityDays} days.`;'

run_mutation "a gated summary drops the citation we could not read" \
  sub src/data.ts 'summary = `${gateRiskSummary(gate)}${unreadCitation}`;' 'summary = gateRiskSummary(gate);'

run_mutation "a gated alternative on vendor-risk keeps its rating" \
  sub src/data.ts 'risk_level: altGate || (cannotVouchForLevel(e.offer, unreachable) && a.level === "stable") ? null : a.level,' \
                  'risk_level: cannotVouchForLevel(e.offer, unreachable) && a.level === "stable" ? null : a.level,'

run_mutation "vendor-risk counts free-tier days for an offer with no free tier" \
  sub src/data.ts 'free_tier_longevity_days: gate && GATES_WITHOUT_A_LONGEVITY_REFERENT.has(gate.code) ? null : longevityDays,' \
                  'free_tier_longevity_days: longevityDays,'

run_mutation "vendor-risk withholds the day count from every gated code, not the two with no referent" \
  sub src/data.ts 'gate && GATES_WITHOUT_A_LONGEVITY_REFERENT.has(gate.code) ? null : longevityDays' \
                  'gate ? null : longevityDays'

run_mutation "a retired offer gets the generic decline instead of its own sentence" \
  sub src/data.ts '  if (gate.code === "offer_retired") return endedVerdictSentence();
' ''

run_mutation "/api/offers counts the returned page instead of the whole match" \
  sub src/serve.ts 'gateDisclosureFor("offer", results.map(o => gateForOffer(o)))' \
                   'gateDisclosureFor("offer", paged.map(o => gateForOffer(o)))'

run_mutation "/api/offers publishes no response-level count" \
  sub src/serve.ts ', ...offersDisclosure })));' ' })));'

run_mutation "search_deals publishes no response-level count" \
  sub src/server.ts ', offset: effectiveOffset, ...disclosure }' ', offset: effectiveOffset }'

run_mutation "concise mode drops the gate" \
  sub src/server.ts 'url: offer.url, gate: gateForOffer(offer),' 'url: offer.url,'

run_mutation "the disclosure never uses the all-gated form" \
  sub src/gate-disclosure.ts 'if (gated >= total && total > 1) return `None of ${subject} are on our ranked list — ${clauses}.`;
' ''

run_mutation "the disclosure never uses the singular form" \
  sub src/gate-disclosure.ts 'if (gated === 1) return `One of ${subject} is not on our ranked list — ${clauses}.`;
' ''

run_mutation "the clause list ignores plural agreement" \
  sub src/gate-disclosure.ts 'clauses.push(n === 1 ? clause.one : clause.many(n));' 'clauses.push(clause.many(n));'

run_mutation "the clause list reports only the first gate code it finds" \
  sub src/gate-disclosure.ts '    clauses.push(n === 1 ? clause.one : clause.many(n));' \
                             '    clauses.push(n === 1 ? clause.one : clause.many(n));
    break;'

run_mutation "the clause order follows the gate table rather than the criteria" \
  sub src/gate-disclosure.ts 'for (const clause of GATE_CLAUSES) {' 'for (const clause of [...GATE_CLAUSES].reverse()) {'

run_mutation "the subject is always plural" \
  sub src/gate-disclosure.ts '${total === 1 ? "" : "s"}' 's'

echo
echo "killed $killed, survived $survived"
