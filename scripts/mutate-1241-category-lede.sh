#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/category-gate-lede.test.ts
  test/eligibility-disclosure.test.ts
)

SOURCES=(src/serve.ts src/eligibility.ts src/gate-disclosure.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").ledeorig"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").ledeorig" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-lede-out.txt 2>&1; then
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

run_mutation "the lede counts eligibility alone again" \
  sub src/serve.ts 'const catGates = catOffers.map((o) => gateFor(o, catServedOn));' \
                   'const catGates = catOffers.map((o) => eligibilityGate(o));'

run_mutation "the lede counts every record as gated" \
  sub src/serve.ts 'const catGates = catOffers.map((o) => gateFor(o, catServedOn));' \
                   'const catGates = catOffers.map((o) => gateFor(o, catServedOn) ?? { code: "not_a_free_offer" as const, reason: "x" });'

run_mutation "the lede states no gate at all" \
  sub src/eligibility.ts 'const codes = gatedCodes(gates);
  if (codes.length === 0) return `${counted}.`;' \
                         'const codes: GateCode[] = [];
  if (codes.length === 0) return `${counted}.`;'

run_mutation "the retired clause is dropped from the list" \
  sub src/gate-disclosure.ts '    code: "offer_retired",
    one: "1 has ended",
    many: (n) => `${n} have ended`,' \
                             '    code: "offer_retired",
    one: "",
    many: () => "",'

run_mutation "the not-free clause is dropped from the list" \
  sub src/gate-disclosure.ts '    code: "not_a_free_offer",
    one: "1 is not a free offer",
    many: (n) => `${n} are not free offers`,' \
                             '    code: "not_a_free_offer",
    one: "",
    many: () => "",'

run_mutation "the eligibility clause loses its wording" \
  sub src/gate-disclosure.ts 'one: "1 requires an application or qualification",' \
                             'one: "1 is not on our ranked list",'

run_mutation "the clause list drops every code but the first" \
  sub src/gate-disclosure.ts 'return clauses.join(", ");' \
                             'return clauses.slice(0, 1).join(", ");'

run_mutation "the count names the first gate code rather than the whole set" \
  sub src/eligibility.ts 'return `${counted}. ${gateDisclosureSentence("them", total, codes)}`;' \
                         'return `${counted}. ${gateDisclosureSentence("them", total, codes.slice(0, 1))}`;'

run_mutation "the entirely gated form is applied to any gated category" \
  sub src/eligibility.ts 'return codes.length >= total && codes.every((code) => code === "eligibility_restricted");' \
                         'return codes.every((code) => code === "eligibility_restricted");'

run_mutation "the entirely gated pages lose their published wording" \
  sub src/eligibility.ts 'return `${counted}, none of them generally available — each requires an application or qualification.`;' \
                         'return `${counted}. ${gateDisclosureSentence("them", total, codes)}`;'

run_mutation "the search snippet counts eligibility alone again" \
  sub src/eligibility.ts 'export function gatedShareDescriptionClause(total: number, gates: (Gate | null)[]): string {
  const codes = gatedCodes(gates);' \
                         'export function gatedShareDescriptionClause(total: number, gates: (Gate | null)[]): string {
  const codes = gatedCodes(gates).filter((code) => code === "eligibility_restricted");'

run_mutation "the search snippet drops the clause entirely" \
  sub src/serve.ts 'const catGatedClause = gatedShareDescriptionClause(catCount, catGates);' \
                   'const catGatedClause = "";'

run_mutation "the snippet clause follows the vendor list" \
  sub src/serve.ts 'free tiers, and developer deals.${catGatedClause ? ` ${catGatedClause}` : ""} Verified pricing for ${catOffers.slice(0, 5).map(o => o.vendor).join(", ")}${catCount > 5 ? " and more" : ""}.`;' \
                   'free tiers, and developer deals. Verified pricing for ${catOffers.slice(0, 5).map(o => o.vendor).join(", ")}${catCount > 5 ? " and more" : ""}.${catGatedClause ? ` ${catGatedClause}` : ""}`;'

run_mutation "the record put forward is the first one again" \
  sub src/serve.ts 'const topVendor = catOffers.find((_, i) => catGates[i] === null);' \
                   'const topVendor = catOffers[0];'

run_mutation "the record put forward skips only eligibility" \
  sub src/serve.ts 'const topVendor = catOffers.find((_, i) => catGates[i] === null);' \
                   'const topVendor = catOffers.find((o) => !eligibilityGate(o));'

run_mutation "the record put forward is the last one" \
  sub src/serve.ts 'const topVendor = catOffers.find((_, i) => catGates[i] === null);' \
                   'const topVendor = catOffers[catOffers.length - 1];'

run_mutation "the claim is dropped on every category" \
  sub src/serve.ts 'const topVendor = catOffers.find((_, i) => catGates[i] === null);' \
                   'const topVendor = undefined as typeof catOffers[number] | undefined;'

run_mutation "the singular form is used for every count" \
  sub src/gate-disclosure.ts 'if (gated === 1) return `One of ${subject} is not on our ranked list — ${clauses}.`;' \
                             'if (gated >= 1) return `One of ${subject} is not on our ranked list — ${clauses}.`;'

run_mutation "the plural clause is used for a single record" \
  sub src/gate-disclosure.ts 'clauses.push(n === 1 ? clause.one : clause.many(n));' \
                             'clauses.push(clause.many(n));'

run_mutation "the best-service answer keeps the first record while the intro moves" \
  sub src/serve.ts '${topVendor ? ` ${escHtmlServer(topVendor.vendor)} offers ${escHtmlServer(keyLimit)} on their ${escHtmlServer(topVendor.tier)} plan.` : ""}' \
                   '${catOffers[0] ? ` ${escHtmlServer(catOffers[0].vendor)} offers ${escHtmlServer(keyLimit)} on their ${escHtmlServer(catOffers[0].tier)} plan.` : ""}'

run_mutation "the best-service answer leaves a gap where the claim was" \
  sub src/serve.ts 'services include ${topAlts}.${topVendor ? ` ${escHtmlServer(topVendor.vendor)}' \
                   'services include ${topAlts}. ${topVendor ? `${escHtmlServer(topVendor.vendor)}'

run_mutation "the gate date is fixed before every expiry" \
  sub src/serve.ts 'const catServedOn = utcDate();' \
                   'const catServedOn = "2000-01-01";'

echo
echo "killed:   $killed"
echo "survived: $survived"
