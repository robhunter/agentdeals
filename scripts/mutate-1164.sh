#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

AUTH="src/platform-auth.ts"
LIMIT="src/rate-limit.ts"
SURFACES="src/referral-surfaces.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$AUTH" "$BACKUP_DIR/platform-auth.ts"
cp "$LIMIT" "$BACKUP_DIR/rate-limit.ts"
cp "$SURFACES" "$BACKUP_DIR/referral-surfaces.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/platform-auth.ts" "$AUTH"
  cp "$BACKUP_DIR/rate-limit.ts" "$LIMIT"
  cp "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/conversion-auth.test.ts test/platform-auth.test.ts test/rate-limit.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/platform-auth.ts" "$AUTH" > /dev/null \
    && diff -q "$BACKUP_DIR/rate-limit.ts" "$LIMIT" > /dev/null \
    && diff -q "$BACKUP_DIR/referral-surfaces.ts" "$SURFACES" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1164-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1164-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1164-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1164-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1164-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_an_unconfigured_secret_admits_every_caller() {
  py <<'PY'
p = "src/platform-auth.ts"
s = open(p).read()
s = s.replace("  if (!platformSecretConfigured(configured)) return false;",
              "  if (!platformSecretConfigured(configured)) return true;")
open(p, "w").write(s)
PY
}

m_the_credential_is_compared_by_length() {
  py <<'PY'
p = "src/platform-auth.ts"
s = open(p).read()
s = s.replace("  return timingSafeEqual(digestOf(presented), digestOf((configured as string).trim()));",
              "  return presented.length === (configured as string).trim().length;")
open(p, "w").write(s)
PY
}

m_a_prefix_of_the_credential_is_accepted() {
  py <<'PY'
p = "src/platform-auth.ts"
s = open(p).read()
s = s.replace("  return timingSafeEqual(digestOf(presented), digestOf((configured as string).trim()));",
              "  return timingSafeEqual(digestOf(presented.slice(0, 4)), digestOf((configured as string).trim().slice(0, 4)));")
open(p, "w").write(s)
PY
}

m_any_authorization_scheme_is_accepted() {
  py <<'PY'
p = "src/platform-auth.ts"
s = open(p).read()
s = s.replace("  if (!/^bearer /i.test(value)) return null;",
              "  if (value.length === 0) return null;")
open(p, "w").write(s)
PY
}

m_the_scheme_is_left_on_the_token() {
  py <<'PY'
p = "src/platform-auth.ts"
s = open(p).read()
s = s.replace("  const token = value.slice(7).trim();",
              "  const token = value.trim();")
open(p, "w").write(s)
PY
}

m_a_whitespace_secret_counts_as_configured() {
  py <<'PY'
p = "src/platform-auth.ts"
s = open(p).read()
s = s.replace("  return typeof configured === \"string\" && configured.trim().length > 0;",
              "  return typeof configured === \"string\" && configured.length > 0;")
open(p, "w").write(s)
PY
}

m_recording_a_conversion_needs_no_credential() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  } else if (url.pathname === "/api/conversions" && req.method === "POST") {
    if (!authorizedAsPlatform(req.headers)) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: PLATFORM_CREDENTIAL_REQUIRED }));
      return;
    }

""",
              """  } else if (url.pathname === "/api/conversions" && req.method === "POST") {
""")
open(p, "w").write(s)
PY
}

m_confirming_the_sweep_needs_no_credential() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    if (!authorizedAsPlatform(req.headers)) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: PLATFORM_CREDENTIAL_REQUIRED }));
      return;
    }

    try {
      const confirmed = confirmEligibleEntries();""",
              """    try {
      const confirmed = confirmEligibleEntries();""")
open(p, "w").write(s)
PY
}

m_clawing_back_needs_no_credential() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  } else if (url.pathname === "/api/conversions/clawback" && req.method === "POST") {
    if (!authorizedAsPlatform(req.headers)) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: PLATFORM_CREDENTIAL_REQUIRED }));
      return;
    }

""",
              """  } else if (url.pathname === "/api/conversions/clawback" && req.method === "POST") {
""")
open(p, "w").write(s)
PY
}

m_an_agent_can_assert_its_own_conversion() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  } else if (url.pathname === "/api/conversions" && req.method === "POST") {
    if (!authorizedAsPlatform(req.headers)) {""",
              """  } else if (url.pathname === "/api/conversions" && req.method === "POST") {
    if (!(await authenticateRequest(req as any))) {""")
open(p, "w").write(s)
PY
}

m_the_commission_has_no_upper_bound() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    if (parsed.commission_amount > MAX_COMMISSION_AMOUNT) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: `commission_amount exceeds the maximum recordable commission of $${MAX_COMMISSION_AMOUNT}` }));
      return;
    }
""", "")
open(p, "w").write(s)
PY
}

m_the_upper_bound_refuses_its_own_maximum() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    if (parsed.commission_amount > MAX_COMMISSION_AMOUNT) {",
              "    if (parsed.commission_amount >= MAX_COMMISSION_AMOUNT) {")
open(p, "w").write(s)
PY
}

m_an_infinite_commission_is_a_number() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    if (!Number.isFinite(parsed.commission_amount) || parsed.commission_amount <= 0) {",
              "    if (typeof parsed.commission_amount !== \"number\" || parsed.commission_amount <= 0) {")
open(p, "w").write(s)
PY
}

m_any_vendor_can_be_credited() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    if (!heldReferralLinkForVendor(offers, parsed.vendor)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: `No referral link of ours for vendor "${parsed.vendor}" — a commission cannot be attributed to a relationship we do not hold` }));
      return;
    }
""", "")
open(p, "w").write(s)
PY
}

m_a_vendor_running_its_own_program_counts_as_a_link_of_ours() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    if (!heldReferralLinkForVendor(offers, parsed.vendor)) {",
              "    if (!hasAnyReferralSurface(parsed.vendor, offers.find(o => toSlug(o.vendor) === toSlug(parsed.vendor)) ?? null)) {")
open(p, "w").write(s)
PY
}

m_the_held_vendor_must_be_named_exactly() {
  py <<'PY'
p = "src/referral-surfaces.ts"
s = open(p).read()
s = s.replace("  return allOurReferralLinks(offers).find(link => toSlug(link.vendor) === slug) ?? null;",
              "  return allOurReferralLinks(offers).find(link => link.vendor === vendorName) ?? null;")
open(p, "w").write(s)
PY
}

m_registration_is_counted_but_never_refused() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    if (!registration.allowed) {",
              "    if (registration.limit < 0) {")
open(p, "w").write(s)
PY
}

m_the_created_agent_carries_no_ratelimit_headers() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      res.writeHead(201, { \"Content-Type\": \"application/json\", \"Access-Control-Allow-Origin\": \"*\", ...registrationHeaders });",
              "      res.writeHead(201, { \"Content-Type\": \"application/json\", \"Access-Control-Allow-Origin\": \"*\" });")
open(p, "w").write(s)
PY
}

m_the_limiter_allows_one_fewer_than_its_limit() {
  py <<'PY'
p = "src/rate-limit.ts"
s = open(p).read()
s = s.replace("        allowed: window.count <= opts.limit,",
              "        allowed: window.count < opts.limit,")
open(p, "w").write(s)
PY
}

m_the_limiter_allows_one_more_than_its_limit() {
  py <<'PY'
p = "src/rate-limit.ts"
s = open(p).read()
s = s.replace("        allowed: window.count <= opts.limit,",
              "        allowed: window.count <= opts.limit + 1,")
open(p, "w").write(s)
PY
}

m_the_window_never_reopens() {
  py <<'PY'
p = "src/rate-limit.ts"
s = open(p).read()
s = s.replace("      if (!held || now - held.startedAt >= opts.windowMs) {",
              "      if (!held) {")
open(p, "w").write(s)
PY
}

m_the_key_map_grows_without_bound() {
  py <<'PY'
p = "src/rate-limit.ts"
s = open(p).read()
s = s.replace("""      while (windows.size > opts.maxKeys) {
        const oldest = windows.keys().next();
        if (oldest.done) break;
        windows.delete(oldest.value);
      }
""", "")
open(p, "w").write(s)
PY
}

m_the_remaining_allowance_goes_negative() {
  py <<'PY'
p = "src/rate-limit.ts"
s = open(p).read()
s = s.replace("        remaining: Math.max(0, opts.limit - window.count),",
              "        remaining: opts.limit - window.count,")
open(p, "w").write(s)
PY
}

m_a_configured_limit_of_zero_is_honoured() {
  py <<'PY'
p = "src/rate-limit.ts"
s = open(p).read()
s = s.replace("  return Number.isInteger(parsed) && parsed > 0 ? parsed : REGISTRATION_LIMIT_DEFAULT;",
              "  return Number.isInteger(parsed) ? parsed : REGISTRATION_LIMIT_DEFAULT;")
open(p, "w").write(s)
PY
}

m_the_api_page_states_a_limit_of_its_own() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("allows \" + registrationLimiter.limit + \" registrations per hour per client",
              "allows \" + 5 + \" registrations per hour per client")
open(p, "w").write(s)
PY
}

m_the_api_page_stops_mentioning_the_limits() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
start = s.index("    + \"    <p>Two write paths are limited.")
end = s.index("\n", start) + 1
s = s[:start] + s[end:]
open(p, "w").write(s)
PY
}

run_mutation "an unconfigured secret admits every caller" m_an_unconfigured_secret_admits_every_caller
run_mutation "the credential is compared by length" m_the_credential_is_compared_by_length
run_mutation "a prefix of the credential is accepted" m_a_prefix_of_the_credential_is_accepted
run_mutation "any authorization scheme is accepted" m_any_authorization_scheme_is_accepted
run_mutation "the scheme is left on the token" m_the_scheme_is_left_on_the_token
run_mutation "a whitespace secret counts as configured" m_a_whitespace_secret_counts_as_configured
run_mutation "recording a conversion needs no credential" m_recording_a_conversion_needs_no_credential
run_mutation "confirming the sweep needs no credential" m_confirming_the_sweep_needs_no_credential
run_mutation "clawing back needs no credential" m_clawing_back_needs_no_credential
run_mutation "an agent can assert its own conversion" m_an_agent_can_assert_its_own_conversion
run_mutation "the commission has no upper bound" m_the_commission_has_no_upper_bound
run_mutation "the upper bound refuses its own maximum" m_the_upper_bound_refuses_its_own_maximum
run_mutation "an infinite commission is a number" m_an_infinite_commission_is_a_number
run_mutation "any vendor can be credited" m_any_vendor_can_be_credited
run_mutation "a vendor running its own program counts as a link of ours" m_a_vendor_running_its_own_program_counts_as_a_link_of_ours
run_mutation "the held vendor must be named exactly" m_the_held_vendor_must_be_named_exactly
run_mutation "registration is counted but never refused" m_registration_is_counted_but_never_refused
run_mutation "the created agent carries no ratelimit headers" m_the_created_agent_carries_no_ratelimit_headers
run_mutation "the limiter allows one fewer than its limit" m_the_limiter_allows_one_fewer_than_its_limit
run_mutation "the limiter allows one more than its limit" m_the_limiter_allows_one_more_than_its_limit
run_mutation "the window never reopens" m_the_window_never_reopens
run_mutation "the key map grows without bound" m_the_key_map_grows_without_bound
run_mutation "the remaining allowance goes negative" m_the_remaining_allowance_goes_negative
run_mutation "a configured limit of zero is honoured" m_a_configured_limit_of_zero_is_honoured
run_mutation "the api page states a limit of its own" m_the_api_page_states_a_limit_of_its_own
run_mutation "the api page stops mentioning the limits" m_the_api_page_stops_mentioning_the_limits

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
