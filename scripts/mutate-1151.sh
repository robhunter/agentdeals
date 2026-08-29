#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

CODES="src/platform-codes.ts"
SURFACES="src/referral-surfaces.ts"
SERVE="src/serve.ts"
DATA="data/platform_codes.json"
BACKUP_DIR="$(mktemp -d)"
cp "$CODES" "$BACKUP_DIR/platform-codes.ts"
cp "$SURFACES" "$BACKUP_DIR/referral-surfaces.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$DATA" "$BACKUP_DIR/platform_codes.json"

restore() {
  cp "$BACKUP_DIR/platform-codes.ts" "$CODES"
  cp "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/platform_codes.json" "$DATA"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/referral-record-terms.test.ts test/platform-codes.test.ts test/referral-disclosure-predicate.test.ts test/referral-codes-listing.test.ts test/referral-code-enrichment.test.ts test/referral.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/platform-codes.ts" "$CODES" > /dev/null \
    && diff -q "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/platform_codes.json" "$DATA" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1151-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1151-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1151-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1151-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1151-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_every_arrangement_is_published_as_a_commission() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('''  if (compensation === "credit") return "We are paid in vendor credit, not cash, if you sign up through this link.";
  if (compensation === "none") return "We are paid nothing if you sign up through this link.";
  return "This is a referral link of ours. We have not recorded what it pays us.";''',
              '  return "We may earn a commission if you sign up through this link.";')
open(p, "w").write(s)
PY
}

m_a_credit_arrangement_is_published_as_a_commission() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  if (compensation === "credit") return "We are paid in vendor credit, not cash, if you sign up through this link.";',
              '  if (compensation === "credit") return "We may earn a commission if you sign up through this link.";')
open(p, "w").write(s)
PY
}

m_an_unstated_arrangement_is_published_as_a_commission() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  return "This is a referral link of ours. We have not recorded what it pays us.";',
              '  return "We may earn a commission if you sign up through this link.";')
open(p, "w").write(s)
PY
}

m_an_arrangement_paying_us_nothing_is_published_as_a_commission() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  if (compensation === "none") return "We are paid nothing if you sign up through this link.";',
              '  if (compensation === "none") return "We may earn a commission if you sign up through this link.";')
open(p, "w").write(s)
PY
}

m_the_cta_ignores_the_recorded_arrangement() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('${escHtmlServer(referrerDisclosureSentence(ourLink.compensation))} See our <a href="/disclosure">affiliate disclosure</a>.',
              'We may earn a commission if you sign up through this link. See our <a href="/disclosure">affiliate disclosure</a>.')
open(p, "w").write(s)
PY
}

m_any_string_is_accepted_as_an_arrangement() {
  py <<'PY'
p = "src/platform-codes.ts"
s = open(p).read()
s = s.replace('  return REFERRER_COMPENSATIONS.includes(stated as ReferrerCompensation) ? (stated as ReferrerCompensation) : null;',
              '  return typeof stated === "string" ? (stated as ReferrerCompensation) : null;')
open(p, "w").write(s)
PY
}

m_the_arrangement_is_read_off_the_benefit_wording() {
  py <<'PY'
p = "src/platform-codes.ts"
s = open(p).read()
s = s.replace('  const stated = (record as { referrer_compensation?: unknown } | null | undefined)?.referrer_compensation;',
              '  const benefit = (record as { referrer_benefit?: unknown } | null | undefined)?.referrer_benefit;\n  const stated = typeof benefit === "string" && benefit.includes("commission") ? "commission" : (record as { referrer_compensation?: unknown } | null | undefined)?.referrer_compensation;')
open(p, "w").write(s)
PY
}

m_no_record_ever_carries_a_condition() {
  py <<'PY'
p = "src/platform-codes.ts"
s = open(p).read()
s = s.replace('  if (!Array.isArray(stated)) return [];',
              '  if (!Array.isArray(stated) || stated.length >= 0) return [];')
open(p, "w").write(s)
PY
}

m_a_blank_condition_is_published_as_a_condition() {
  py <<'PY'
p = "src/platform-codes.ts"
s = open(p).read()
s = s.replace('  return stated.filter((r): r is string => typeof r === "string" && r.trim().length > 0);',
              '  return stated as string[];')
open(p, "w").write(s)
PY
}

m_the_cta_drops_the_conditions() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('      </div>${ourLink.restrictions.length > 0 ? `\n      <div class="referral-conditions"',
              '      </div>${ourLink.restrictions.length > 99 ? `\n      <div class="referral-conditions"')
open(p, "w").write(s)
PY
}

m_the_conditions_come_after_the_button() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
block_start = s.index('      </div>${ourLink.restrictions.length > 0 ? `\n      <div class="referral-conditions"')
block_end = s.index('` : ""}\n      <a href="${escHtmlServer(ourLink.url)}"', block_start)
block = s[block_start + len('      </div>'):block_end + len('` : ""}')]
s = s[:block_start] + '      </div>' + s[block_end + len('` : ""}'):]
anchor = '</a>\n      <p style="margin-top:.75rem;font-size:.75rem;color:var(--text-dim)">${escHtmlServer(referrerDisclosureSentence('
s = s.replace(anchor, '</a>' + block + '\n      <p style="margin-top:.75rem;font-size:.75rem;color:var(--text-dim)">${escHtmlServer(referrerDisclosureSentence(')
open(p, "w").write(s)
PY
}

m_the_disclosure_page_drops_the_conditions() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('${l.restrictions.length > 0 ? `<ul class="referral-conditions">',
              '${false ? `<ul class="referral-conditions">')
open(p, "w").write(s)
PY
}

m_the_code_endpoint_drops_the_conditions() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('        restrictions: best.restrictions,\n', '')
open(p, "w").write(s)
PY
}

m_the_best_code_reports_no_conditions() {
  py <<'PY'
p = "src/platform-codes.ts"
s = open(p).read()
s = s.replace('      referee_benefit: platformCode.referee_benefit,\n      restrictions: restrictionsOf(platformCode),',
              '      referee_benefit: platformCode.referee_benefit,\n      restrictions: [],')
open(p, "w").write(s)
PY
}

m_the_listing_reports_no_conditions() {
  py <<'PY'
p = "src/platform-codes.ts"
s = open(p).read()
s = s.replace('        referee_benefit: c.referee_benefit,\n        restrictions: restrictionsOf(c),',
              '        referee_benefit: c.referee_benefit,\n        restrictions: [],')
open(p, "w").write(s)
PY
}

m_a_removed_code_comes_back() {
  py <<'PY'
import json
p = "data/platform_codes.json"
d = json.load(open(p))
d["platform_codes"].append({
    "vendor": "Proton Mail",
    "code": "60QXGJSB",
    "referral_url": "https://pr.tn/ref/60QXGJSB",
    "referrer_benefit": "$20 credit",
    "referrer_compensation": "credit",
    "referee_benefit": "$20 credit",
    "restrictions": [],
    "source": "platform",
    "active": True,
    "added_at": "2026-04-21",
})
json.dump(d, open(p, "w"), indent=2)
PY
}

m_a_published_code_states_no_arrangement() {
  py <<'PY'
import json
p = "data/platform_codes.json"
d = json.load(open(p))
for c in d["platform_codes"]:
    c.pop("referrer_compensation", None)
json.dump(d, open(p, "w"), indent=2)
PY
}

m_a_published_code_states_no_conditions_field() {
  py <<'PY'
import json
p = "data/platform_codes.json"
d = json.load(open(p))
for c in d["platform_codes"]:
    c.pop("restrictions", None)
json.dump(d, open(p, "w"), indent=2)
PY
}

m_railways_arrangement_is_restated_as_credit() {
  py <<'PY'
import json
p = "data/platform_codes.json"
d = json.load(open(p))
for c in d["platform_codes"]:
    if c["vendor"] == "Railway":
        c["referrer_compensation"] = "credit"
json.dump(d, open(p, "w"), indent=2)
PY
}

m_the_cta_falls_back_to_the_platform_store_alone() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const ourLink = ourReferralLinkFor(vendorName, primary);',
              '  const ourLink = ourReferralLinkFor(vendorName, null);')
open(p, "w").write(s)
PY
}

run_mutation "every arrangement is published as a commission" m_every_arrangement_is_published_as_a_commission
run_mutation "a credit arrangement is published as a commission" m_a_credit_arrangement_is_published_as_a_commission
run_mutation "an unstated arrangement is published as a commission" m_an_unstated_arrangement_is_published_as_a_commission
run_mutation "an arrangement paying us nothing is published as a commission" m_an_arrangement_paying_us_nothing_is_published_as_a_commission
run_mutation "the CTA ignores the recorded arrangement" m_the_cta_ignores_the_recorded_arrangement
run_mutation "any string is accepted as an arrangement" m_any_string_is_accepted_as_an_arrangement
run_mutation "the arrangement is read off the benefit wording" m_the_arrangement_is_read_off_the_benefit_wording
run_mutation "no record ever carries a condition" m_no_record_ever_carries_a_condition
run_mutation "a blank condition is published as a condition" m_a_blank_condition_is_published_as_a_condition
run_mutation "the CTA drops the conditions" m_the_cta_drops_the_conditions
run_mutation "the conditions come after the button" m_the_conditions_come_after_the_button
run_mutation "the disclosure page drops the conditions" m_the_disclosure_page_drops_the_conditions
run_mutation "the code endpoint drops the conditions" m_the_code_endpoint_drops_the_conditions
run_mutation "the best code reports no conditions" m_the_best_code_reports_no_conditions
run_mutation "the listing reports no conditions" m_the_listing_reports_no_conditions
run_mutation "a removed code comes back" m_a_removed_code_comes_back
run_mutation "a published code states no arrangement" m_a_published_code_states_no_arrangement
run_mutation "a published code states no conditions field" m_a_published_code_states_no_conditions_field
run_mutation "Railway's arrangement is restated as credit" m_railways_arrangement_is_restated_as_credit
run_mutation "the CTA falls back to the platform store alone" m_the_cta_falls_back_to_the_platform_store_alone

restore
npm run build > /dev/null 2>&1
echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
