#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

ANCHORS="src/referral-anchors.ts"
SURFACES="src/referral-surfaces.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$ANCHORS" "$BACKUP_DIR/referral-anchors.ts"
cp "$SURFACES" "$BACKUP_DIR/referral-surfaces.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/referral-anchors.ts" "$ANCHORS"
  cp "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/sponsored-link-targets.test.ts test/referral-record-terms.test.ts test/referral-disclosure-predicate.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/referral-anchors.ts" "$ANCHORS" > /dev/null \
    && diff -q "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1161-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1161-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1161-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1161-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1161-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_the_button_points_at_the_vendors_own_program_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""'    <p><a href="' + escHtmlServer(hostingReferral.url) + '\"""",
              """'    <p><a href="' + escHtmlServer(hostingReferral.termsUrl ?? hostingReferral.url) + '\"""")
open(p, "w").write(s)
PY
}

m_the_box_renders_whenever_the_vendor_runs_a_program() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const hostingReferral = ourReferralLinkFor("Railway", railwayOffer ?? null);',
              '  const hostingReferral = railwayOffer?.referral_program?.available ? (ourReferralLinkFor("Railway", railwayOffer) ?? { vendor: "Railway", url: railwayOffer.referral_program.program_url, refereeBenefit: "$20 in free credits", restrictions: [], compensation: null, termsUrl: null, source: "offer_referral" as const }) : null;')
open(p, "w").write(s)
PY
}

m_the_button_names_a_hardcoded_benefit() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""'" rel="noopener sponsored" target="_blank">Get ' + escHtmlServer(hostingReferral.refereeBenefit) + ' &rarr;</a>""",
              """'" rel="noopener sponsored" target="_blank">Get $20 in free credits &rarr;</a>""")
open(p, "w").write(s)
PY
}

m_the_heading_names_a_hardcoded_benefit() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    '    <h3>\\u{1F680} ' + escHtmlServer(hostingReferral.vendor) + ' \\u2014 ' + escHtmlServer(hostingReferral.refereeBenefit) + ' with our referral</h3>\\n' +""",
              """    '    <h3>\\u{1F680} Railway \\u2014 $20 in free credits with our referral</h3>\\n' +""")
open(p, "w").write(s)
PY
}

m_the_superlative_returns() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    '    <p><a href="' + escHtmlServer(hostingReferral.url)""",
              """    '    <p>Railway is our top pick for side projects and production apps alike. <a href="' + escHtmlServer(hostingReferral.url)""")
open(p, "w").write(s)
PY
}

m_the_unsourced_trial_comparison_returns() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    '    <p><a href="' + escHtmlServer(hostingReferral.url)""",
              """    '    <p>4x the standard $5 trial credit). <a href="' + escHtmlServer(hostingReferral.url)""")
open(p, "w").write(s)
PY
}

m_the_box_stops_saying_what_the_link_pays_us() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    '    <p class="referral-compensation">' + escHtmlServer(referrerDisclosureSentence(hostingReferral.compensation)) + '</p>\\n' +\n    '  </div>\\n'""",
              """    '  </div>\\n'""")
open(p, "w").write(s)
PY
}

m_the_box_publishes_a_commission_whatever_the_record_says() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""'    <p class="referral-compensation">' + escHtmlServer(referrerDisclosureSentence(hostingReferral.compensation)) + '</p>\\n'""",
              """'    <p class="referral-compensation">We may earn a commission if you sign up through this link.</p>\\n'""")
open(p, "w").write(s)
PY
}

m_the_conditions_are_never_rendered() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    (hostingReferral.restrictions.length > 0 ?\n", "    (hostingReferral.restrictions.length > 99 ?\n")
open(p, "w").write(s)
PY
}

m_the_conditions_are_stated_after_the_button() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
conditions = """    (hostingReferral.restrictions.length > 0 ?
    '    <div class="referral-conditions">\\n' +
    '      <div class="referral-conditions-heading">' + REFERRAL_CONDITIONS_HEADING + '</div>\\n' +
    '      <ul>' + hostingReferral.restrictions.map(r => '<li>' + escHtmlServer(r) + '</li>').join("") + '</ul>\\n' +
    '    </div>\\n'
    : '') +
"""
button = """    '    <p><a href="' + escHtmlServer(hostingReferral.url) + '" rel="noopener sponsored" target="_blank">Get ' + escHtmlServer(hostingReferral.refereeBenefit) + ' &rarr;</a> &middot; <a href="/disclosure" style="color:var(--text-dim);font-size:.8rem">Affiliate disclosure</a></p>\\n' +
"""
assert conditions in s and button in s
s = s.replace(conditions + button, button + conditions)
open(p, "w").write(s)
PY
}

m_the_conditions_lose_their_heading() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('export const REFERRAL_CONDITIONS_HEADING = "What you have to do to get it";',
              'export const REFERRAL_CONDITIONS_HEADING = "";')
open(p, "w").write(s)
PY
}

m_the_two_referral_surfaces_word_the_conditions_differently() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""'      <div class="referral-conditions-heading">' + REFERRAL_CONDITIONS_HEADING + '</div>\\n'""",
              """'      <div class="referral-conditions-heading">Terms</div>\\n'""")
open(p, "w").write(s)
PY
}

m_no_rel_is_read_as_sponsored() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("  return anchor.rel.includes(\"sponsored\");", "  return false;")
open(p, "w").write(s)
PY
}

m_a_rel_that_merely_contains_the_letters_is_read_as_sponsored() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("  return anchor.rel.includes(\"sponsored\");", "  return anchor.rel.join(\" \").includes(\"sponsored\");")
open(p, "w").write(s)
PY
}

m_the_anchor_label_is_never_read() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("      label: plainText(match[2]),", "      label: \"\",")
open(p, "w").write(s)
PY
}

m_the_href_is_never_read() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace('      href: attributeOf(match[1], "href"),', '      href: "",')
open(p, "w").write(s)
PY
}

m_nested_markup_swallows_the_label() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace('const ANCHOR_TAG = /<a\\s+([^>]*?)>([\\s\\S]*?)<\\/a>/gi;',
              'const ANCHOR_TAG = /<a\\s+([^>]*?)>([^<]*)<\\/a>/gi;')
open(p, "w").write(s)
PY
}

m_no_label_is_read_as_an_offer() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("  return BENEFIT_VERB.test(text) || BENEFIT_AMOUNT.test(text);", "  return false;")
open(p, "w").write(s)
PY
}

m_every_label_is_read_as_an_offer() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("  return BENEFIT_VERB.test(text) || BENEFIT_AMOUNT.test(text);", "  return text.length > 0;")
open(p, "w").write(s)
PY
}

m_a_stated_amount_is_not_read_as_an_offer() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("  return BENEFIT_VERB.test(text) || BENEFIT_AMOUNT.test(text);", "  return BENEFIT_VERB.test(text);")
open(p, "w").write(s)
PY
}

m_only_a_label_that_is_nothing_but_a_verb_is_read_as_an_offer() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("const BENEFIT_VERB = /^(claim|get|redeem|save|unlock|grab|sign\\s?up|start)\\b/i;",
              "const BENEFIT_VERB = /^(claim|get|redeem|save|unlock|grab|sign\\s?up|start)$/i;")
open(p, "w").write(s)
PY
}

m_a_verb_anywhere_in_the_label_is_read_as_an_offer() {
  py <<'PY'
p = "src/referral-anchors.ts"
s = open(p).read()
s = s.replace("const BENEFIT_VERB = /^(claim|get|redeem|save|unlock|grab|sign\\s?up|start)\\b/i;",
              "const BENEFIT_VERB = /(claim|get|redeem|save|unlock|grab|sign\\s?up|start)\\b/i;")
open(p, "w").write(s)
PY
}

run_mutation "the button points at the vendor's own program page" m_the_button_points_at_the_vendors_own_program_page
run_mutation "the box renders whenever the vendor runs a program" m_the_box_renders_whenever_the_vendor_runs_a_program
run_mutation "the button names a hardcoded benefit" m_the_button_names_a_hardcoded_benefit
run_mutation "the heading names a hardcoded benefit" m_the_heading_names_a_hardcoded_benefit
run_mutation "the superlative returns" m_the_superlative_returns
run_mutation "the unsourced trial comparison returns" m_the_unsourced_trial_comparison_returns
run_mutation "the box stops saying what the link pays us" m_the_box_stops_saying_what_the_link_pays_us
run_mutation "the box publishes a commission whatever the record says" m_the_box_publishes_a_commission_whatever_the_record_says
run_mutation "the conditions are never rendered" m_the_conditions_are_never_rendered
run_mutation "the conditions are stated after the button" m_the_conditions_are_stated_after_the_button
run_mutation "the conditions lose their heading" m_the_conditions_lose_their_heading
run_mutation "the two referral surfaces word the conditions differently" m_the_two_referral_surfaces_word_the_conditions_differently
run_mutation "no rel is read as sponsored" m_no_rel_is_read_as_sponsored
run_mutation "a rel that merely contains the letters is read as sponsored" m_a_rel_that_merely_contains_the_letters_is_read_as_sponsored
run_mutation "the anchor label is never read" m_the_anchor_label_is_never_read
run_mutation "the href is never read" m_the_href_is_never_read
run_mutation "nested markup swallows the label" m_nested_markup_swallows_the_label
run_mutation "no label is read as an offer" m_no_label_is_read_as_an_offer
run_mutation "every label is read as an offer" m_every_label_is_read_as_an_offer
run_mutation "a stated amount is not read as an offer" m_a_stated_amount_is_not_read_as_an_offer
run_mutation "only a label that is nothing but a verb is read as an offer" m_only_a_label_that_is_nothing_but_a_verb_is_read_as_an_offer
run_mutation "a verb anywhere in the label is read as an offer" m_a_verb_anywhere_in_the_label_is_read_as_an_offer

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
