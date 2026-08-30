#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
DATES="src/change-dates.ts"
SUITE="test/offer-price-validity.test.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$DATES" "$BACKUP_DIR/change-dates.ts"
cp "$SUITE" "$BACKUP_DIR/suite.ts"

restore() {
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/change-dates.ts" "$DATES"
  cp "$BACKUP_DIR/suite.ts" "$SUITE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/offer-price-validity.test.ts"

py() { python3 - "$@"; }

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/change-dates.ts" "$DATES" > /dev/null \
    && diff -q "$BACKUP_DIR/suite.ts" "$SUITE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1180-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1180-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1180-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1180-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1180-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_field_goes_back_to_the_last_change_date() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("...(offerExpiry ? { priceValidUntil: offerExpiry } : {}),",
              "priceValidUntil: lastPricingChange ?? primary.verifiedDate,")
open(p, "w").write(s)
PY
}

m_the_field_falls_back_to_the_verified_date() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("...(offerExpiry ? { priceValidUntil: offerExpiry } : {}),",
              "priceValidUntil: offerExpiry ?? primary.verifiedDate,")
open(p, "w").write(s)
PY
}

m_the_expiry_is_computed_against_the_epoch() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const offerExpiry = offerExpiryAfter(vendorChanges, servedOn);",
              'const offerExpiry = offerExpiryAfter(vendorChanges, "1970-01-01");')
open(p, "w").write(s)
PY
}

m_the_boundary_admits_a_change_dated_today() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("if (!c.date || c.date <= onDate) continue;",
              "if (!c.date || c.date < onDate) continue;")
open(p, "w").write(s)
PY
}

m_the_boundary_is_inverted() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("if (!c.date || c.date <= onDate) continue;",
              "if (!c.date || c.date >= onDate) continue;")
open(p, "w").write(s)
PY
}

m_the_latest_future_change_wins() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("if (earliest === null || c.date < earliest) earliest = c.date;",
              "if (earliest === null || c.date > earliest) earliest = c.date;")
open(p, "w").write(s)
PY
}

m_a_discovery_date_can_end_the_offer() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("    if (!isEventDated(c)) continue;\n    if (!endsTheListedOffer(c)) continue;",
              "    if (!endsTheListedOffer(c)) continue;")
open(p, "w").write(s)
PY
}

m_a_deprecation_of_another_product_ends_the_offer() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("    if (!isEventDated(c)) continue;\n    if (!endsTheListedOffer(c)) continue;",
              "    if (!isEventDated(c)) continue;")
open(p, "w").write(s)
PY
}

m_only_a_deprecation_can_end_the_offer() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("  if (change.change_type !== PRODUCT_DEPRECATED) return true;",
              "  if (change.change_type !== PRODUCT_DEPRECATED) return false;")
open(p, "w").write(s)
PY
}

m_a_deprecation_naming_the_vendor_alone_is_excluded() {
  py <<'PY'
p = "src/change-dates.ts"
s = open(p).read()
s = s.replace("  return deprecationEndsTheListedProduct(change);",
              "  return !deprecationEndsTheListedProduct(change);")
open(p, "w").write(s)
PY
}

m_the_expiry_is_read_from_every_vendors_changes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const offerExpiry = offerExpiryAfter(vendorChanges, servedOn);",
              "const offerExpiry = offerExpiryAfter(allChanges, servedOn);")
open(p, "w").write(s)
PY
}

run_mutation_scoped() {
  local name="$1"
  local pattern="$2"
  shift 2
  echo "=== $name"
  echo "    scoped to: $pattern"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/change-dates.ts" "$DATES" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1180-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1180-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 --test-name-pattern "$pattern" $TESTS > /tmp/mutate-1180-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1180-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1180-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_source_ratchet_accepts_any_count() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("        ...(offerExpiry ? { priceValidUntil: offerExpiry } : {}),",
              "        ...(offerExpiry ? { priceValidUntil: offerExpiry } : {}),\n        ...(offerExpiry ? { priceValidUntil: offerExpiry } : {}),")
open(p, "w").write(s)
PY
}

run_mutation "the field goes back to the date the price last changed" m_the_field_goes_back_to_the_last_change_date
run_mutation "an absent expiry falls back to the date we last checked" m_the_field_falls_back_to_the_verified_date
run_mutation "the expiry is computed against the epoch rather than the day of service" m_the_expiry_is_computed_against_the_epoch
run_mutation "a change taking effect today is treated as still upcoming" m_the_boundary_admits_a_change_dated_today
run_mutation "the boundary is inverted so only past changes can end the offer" m_the_boundary_is_inverted
run_mutation "the last future change wins rather than the first" m_the_latest_future_change_wins
run_mutation "a change dated by when we read the page can end the offer" m_a_discovery_date_can_end_the_offer
run_mutation "a deprecation of a separately named product can end the offer" m_a_deprecation_of_another_product_ends_the_offer
run_mutation "only a deprecation can end the offer" m_only_a_deprecation_can_end_the_offer
run_mutation "a deprecation naming the vendor alone is the one kind excluded" m_a_deprecation_naming_the_vendor_alone_is_excluded
run_mutation "the expiry is read from every vendor's changes rather than this one's" m_the_expiry_is_read_from_every_vendors_changes
run_mutation_scoped "the field goes back to the date the price last changed, judged by the catalog sweep alone" "no vendor page publishes a price expiry that has already passed" m_the_field_goes_back_to_the_last_change_date
run_mutation_scoped "an absent expiry falls back to the date we last checked, judged by the catalog sweep alone" "no vendor page publishes a price expiry that has already passed" m_the_field_falls_back_to_the_verified_date
run_mutation "the field is emitted twice from the render source" m_the_source_ratchet_accepts_any_count

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
