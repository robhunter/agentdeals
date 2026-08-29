#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SURFACES="src/referral-surfaces.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$SURFACES" "$BACKUP_DIR/referral-surfaces.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/referral-disclosure-predicate.test.ts test/referral.test.ts test/referral-programs.test.ts test/ranked-surfaces.test.ts test/vendor-marketplace-solicitation.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1154-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1154-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1154-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1154-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1154-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_the_predicate_reads_the_offer_store_only() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  const platformCode = getPlatformCodeForVendor(vendorName);',
              '  const platformCode = getPlatformCodeForVendor("");')
open(p, "w").write(s)
PY
}

m_the_predicate_reads_the_platform_store_only() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  if (offerReferral && offer) {',
              '  if (offerReferral && offer && vendorName !== vendorName) {')
open(p, "w").write(s)
PY
}

m_a_documented_program_counts_as_a_link_of_ours() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  return ourReferralLinkFor(vendorName, offer) !== null;',
              '  return ourReferralLinkFor(vendorName, offer) !== null || offer?.referral_program?.available === true;')
open(p, "w").write(s)
PY
}

m_a_documented_program_is_not_a_referral_surface() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  return hasOurReferralLink(vendorName, offer) || documentsVendorReferralProgram(offer);',
              '  return hasOurReferralLink(vendorName, offer);')
open(p, "w").write(s)
PY
}

m_every_vendor_page_counts_as_already_holding_a_surface() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  return hasOurReferralLink(vendorName, offer) || documentsVendorReferralProgram(offer);',
              '  return vendorName !== "" || documentsVendorReferralProgram(offer);')
open(p, "w").write(s)
PY
}

m_the_listing_drops_the_platform_store() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  for (const code of getAllPlatformCodes()) {\n    const slug = toSlug(code.vendor);\n    if (slug && !vendorNameBySlug.has(slug)) vendorNameBySlug.set(slug, code.vendor);\n  }\n', '')
open(p, "w").write(s)
PY
}

m_the_listing_drops_the_offer_store() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('    if (!offer.referral) continue;\n    const slug = toSlug(offer.vendor);\n    if (slug && !vendorNameBySlug.has(slug)) vendorNameBySlug.set(slug, offer.vendor);',
              '    if (!offer.referral) continue;')
open(p, "w").write(s)
PY
}

m_the_platform_code_loses_the_program_terms_link() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('      termsUrl: offerReferral?.terms_url ?? null,\n      source: "platform_code",',
              '      termsUrl: null,\n      source: "platform_code",')
open(p, "w").write(s)
PY
}

m_a_single_partner_is_counted_in_the_plural() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace('  return count === 1\n    ? "only 1 currently has a referral link of ours"\n    : `only ${count} currently have a referral link of ours`;',
              '  return `only ${count} currently have a referral link of ours`;')
open(p, "w").write(s)
PY
}

m_the_disclosure_counts_the_offer_store() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const ourReferralLinks = allOurReferralLinks(offers);',
              '  const ourReferralLinks = offers.filter(o => o.referral).map(o => ({ vendor: o.vendor, url: o.referral!.url, refereeBenefit: o.referral!.referee_value, termsUrl: o.referral!.terms_url ?? null, source: "offer_referral" as const }));')
open(p, "w").write(s)
PY
}

m_the_disclosure_counts_the_vendors_own_programs_too() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  for (const link of ourReferralLinks) vendorsWithOwnProgram.delete(toSlug(link.vendor));', '')
open(p, "w").write(s)
PY
}

m_the_disclosure_describes_agent_codes_that_do_not_exist() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const agentSubmittedCodes = listAllReferralCodes({ source: "agent-submitted" });',
              '  const agentSubmittedCodes = listAllReferralCodes({ source: "platform" });')
open(p, "w").write(s)
PY
}

m_the_directory_splits_on_the_offer_store() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('        hasCode: ourLink !== null,', '        hasCode: !!o.referral,')
open(p, "w").write(s)
PY
}

m_the_directory_calls_every_program_unpaid() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('        hasCode: ourLink !== null,', '        hasCode: false,')
open(p, "w").write(s)
PY
}

m_the_directory_orders_its_inventory_by_who_pays_us() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const inventoryOrder = rotateListing([...programVendors], "referral-programs:inventory");',
              '  const inventoryOrder = [...paidSection, ...unpaidSection];')
open(p, "w").write(s)
PY
}

m_the_vendor_page_solicits_where_it_already_has_a_code() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const marketplaceSolicitationHtml = !hasAnyReferralSurface(vendorName, primary) ? `',
              '  const marketplaceSolicitationHtml = !(primary.referral_program?.available === true) ? `')
open(p, "w").write(s)
PY
}

run_mutation "the predicate reads the offer store only" m_the_predicate_reads_the_offer_store_only
run_mutation "the predicate reads the platform store only" m_the_predicate_reads_the_platform_store_only
run_mutation "a documented program counts as a link of ours" m_a_documented_program_counts_as_a_link_of_ours
run_mutation "a documented program is not a referral surface" m_a_documented_program_is_not_a_referral_surface
run_mutation "every vendor page counts as already holding a surface" m_every_vendor_page_counts_as_already_holding_a_surface
run_mutation "the listing drops the platform store" m_the_listing_drops_the_platform_store
run_mutation "the listing drops the offer store" m_the_listing_drops_the_offer_store
run_mutation "the platform code loses the program terms link" m_the_platform_code_loses_the_program_terms_link
run_mutation "a single partner is counted in the plural" m_a_single_partner_is_counted_in_the_plural
run_mutation "the disclosure counts the offer store" m_the_disclosure_counts_the_offer_store
run_mutation "the disclosure counts the vendors own programs too" m_the_disclosure_counts_the_vendors_own_programs_too
run_mutation "the disclosure describes agent codes that do not exist" m_the_disclosure_describes_agent_codes_that_do_not_exist
run_mutation "the directory splits on the offer store" m_the_directory_splits_on_the_offer_store
run_mutation "the directory calls every program unpaid" m_the_directory_calls_every_program_unpaid
run_mutation "the directory orders its inventory by who pays us" m_the_directory_orders_its_inventory_by_who_pays_us
run_mutation "the vendor page solicits where it already has a code" m_the_vendor_page_solicits_where_it_already_has_a_code

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
