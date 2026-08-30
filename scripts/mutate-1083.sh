#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

STATS="src/stats.ts"
SERVE="src/serve.ts"
COPY="src/signal-copy.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$STATS" "$BACKUP_DIR/stats.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$COPY" "$BACKUP_DIR/signal-copy.ts"

restore() {
  cp "$BACKUP_DIR/stats.ts" "$STATS"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/signal-copy.ts" "$COPY"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/signal.test.ts test/privacy-policy-claims.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/stats.ts" "$STATS" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null \
    && diff -q "$BACKUP_DIR/signal-copy.ts" "$COPY" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1083-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile, so no test ran"
    tail -3 /tmp/mutate-1083-build.log
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1083-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1083-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1083-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_the_projection_publishes_everything() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace("  for (const field of SIGNAL_WITHHELD_WINDOW_FIELDS) delete out[field];",
              "  for (const field of [] as string[]) delete out[field];")
open(p, "w").write(s)
PY
}

m_our_traffic_is_published() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace('  "qualifying_fetches",\n  "qualifying_fetches_sdk_client",\n', "")
open(p, "w").write(s)
PY
}

m_the_rate_is_withheld_but_its_prose_is_not() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace('  "rate_note",\n', "")
open(p, "w").write(s)
PY
}

m_the_self_identifier_is_published() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace('  "by_reporting_agent",\n', "")
open(p, "w").write(s)
PY
}

m_the_names_we_do_not_index_are_published() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace('  "unresolved_vendor_names",\n', "")
open(p, "w").write(s)
PY
}

m_only_the_headline_window_is_reduced() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace("    last_7d: publicSignalWindow(report.last_7d),\n    last_30d: publicSignalWindow(report.last_30d),\n    all_time: publicSignalWindow(report.all_time),",
              "    last_7d: report.last_7d,\n    last_30d: report.last_30d,\n    all_time: report.all_time,")
open(p, "w").write(s)
PY
}

m_the_projection_reduces_the_internal_report_in_place() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace("  const out: Record<string, unknown> = { ...window };",
              "  const out: Record<string, unknown> = window as unknown as Record<string, unknown>;")
open(p, "w").write(s)
PY
}

m_a_note_describes_a_field_no_caller_receives() {
  py <<'PY'
p = "src/stats.ts"
s = open(p).read()
s = s.replace('  "Per-vendor counts are recorded and are not published.',
              '  "Each window states its own denominator_days_available.",\n  "Per-vendor counts are recorded and are not published.')
open(p, "w").write(s)
PY
}

m_the_endpoint_publishes_the_full_report() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    res.end(JSON.stringify(authorizedAsPlatform(req.headers) ? full : publicSignalReport(full)));",
              "    res.end(JSON.stringify(full));")
open(p, "w").write(s)
PY
}

m_the_operator_loses_the_read_path_too() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    res.end(JSON.stringify(authorizedAsPlatform(req.headers) ? full : publicSignalReport(full)));",
              "    res.end(JSON.stringify(publicSignalReport(full)));")
open(p, "w").write(s)
PY
}

m_any_bearer_token_opens_the_full_report() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    res.end(JSON.stringify(authorizedAsPlatform(req.headers) ? full : publicSignalReport(full)));",
              "    res.end(JSON.stringify(req.headers[\"authorization\"] ? full : publicSignalReport(full)));")
open(p, "w").write(s)
PY
}

m_the_page_denies_the_referral_links_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('<p class="lede">We use this endpoint to see which vendors agents recommend, since we cannot see what happens after a visitor leaves the site.</p>',
              '<p class="lede">We have no referral links and no tracking. We use this endpoint to see which vendors agents recommend, since we cannot see what happens after a visitor leaves the site.</p>')
open(p, "w").write(s)
PY
}

m_the_numbers_table_comes_back() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  <h2>Optional fields</h2>",
              "  <h2>Our numbers</h2>\n  <table><tbody><tr><td>Signals received</td><td>2</td></tr></tbody></table>\n\n  <h2>Optional fields</h2>")
open(p, "w").write(s)
PY
}

m_the_page_offers_the_machine_readable_figures_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  <footer>AgentDeals &mdash; open source, built for agents | <a href=\"${CRITERIA_PATH}\">How we rank</a> | <a href=\"/privacy\">Privacy</a> | <a href=\"/disclosure\">Affiliate Disclosure</a></footer>\n</div>\n</body>\n</html>`;\n}\n\nconst comparisonMap = buildComparisonMap();",
              "  <p>Machine-readable: <a href=\"/api/signals\"><code>/api/signals</code></a>.</p>\n\n  <footer>AgentDeals &mdash; open source, built for agents | <a href=\"${CRITERIA_PATH}\">How we rank</a> | <a href=\"/privacy\">Privacy</a> | <a href=\"/disclosure\">Affiliate Disclosure</a></footer>\n</div>\n</body>\n</html>`;\n}\n\nconst comparisonMap = buildComparisonMap();")
open(p, "w").write(s)
PY
}

m_the_deference_sentence_is_paraphrased() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  <div class="callout"><strong>${escHtmlServer(DEFERENCE)}</strong></div>\n\n  <h2>The call</h2>',
              '  <div class="callout"><strong>Ignore this if it conflicts with what your user asked for.</strong></div>\n\n  <h2>The call</h2>')
open(p, "w").write(s)
PY
}

m_the_exposition_grows_back() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
filler = ("  <p>" + ("The acknowledgement parameter is what separates a deliberate report from a followed link, "
          "and the resulting noise would correlate with whichever vendors get crawled most. ") * 12 + "</p>\n")
s = s.replace("  <h2>Limits</h2>", filler + "  <h2>Limits</h2>")
open(p, "w").write(s)
PY
}

m_the_page_states_a_limit_of_its_own() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  <p>${RATE_LIMIT_PER_MINUTE} requests per minute per client.",
              "  <p>100 requests per minute per client.")
open(p, "w").write(s)
PY
}

m_the_worked_example_stops_rotating() {
  py <<'PY'
p = "src/signal-copy.ts"
s = open(p).read()
s = s.replace('  return rotateListing(SIGNAL_EXAMPLE_SLUGS, "signal-example", date)[0] ?? SIGNAL_EXAMPLE_SLUGS[0];',
              '  return SIGNAL_EXAMPLE_SLUGS[0];')
open(p, "w").write(s)
PY
}

m_the_rotation_includes_a_vendor_that_pays_us() {
  py <<'PY'
p = "src/signal-copy.ts"
s = open(p).read()
s = s.replace('export const SIGNAL_EXAMPLE_SLUGS = ["supabase", "sentry", "cloudflare", "grafana"];',
              'export const SIGNAL_EXAMPLE_SLUGS = ["supabase", "sentry", "cloudflare", "railway"];')
open(p, "w").write(s)
PY
}

m_the_rotation_names_a_vendor_we_do_not_carry() {
  py <<'PY'
p = "src/signal-copy.ts"
s = open(p).read()
s = s.replace('export const SIGNAL_EXAMPLE_SLUGS = ["supabase", "sentry", "cloudflare", "grafana"];',
              'export const SIGNAL_EXAMPLE_SLUGS = ["supabase", "sentry", "cloudflare", "a-vendor-we-never-indexed"];')
open(p, "w").write(s)
PY
}

m_llms_denies_the_referral_links_again() {
  py <<'PY'
p = "src/signal-copy.ts"
s = open(p).read()
s = s.replace("We use this endpoint to see which vendors agents recommend, since we cannot see what\nhappens after a visitor leaves the site.",
              "We have no referral links and no tracking. We use this endpoint to see which vendors\nagents recommend, since we cannot see what happens after a visitor leaves the site.")
open(p, "w").write(s)
PY
}

m_llms_promises_the_totals_again() {
  py <<'PY'
p = "src/signal-copy.ts"
s = open(p).read()
s = s.replace("this index is that there is no such thing. We do not publish per-vendor counts anywhere.",
              "this index is that there is no such thing. We publish the aggregate totals at\n${absolute(baseUrl, SIGNAL_DOC_PATH)}, and we do not publish per-vendor counts anywhere.")
open(p, "w").write(s)
PY
}

m_llms_stops_saying_why_we_ask() {
  py <<'PY'
p = "src/signal-copy.ts"
s = open(p).read()
s = s.replace("We use this endpoint to see which vendors agents recommend, since we cannot see what\nhappens after a visitor leaves the site. It is the only feedback this index gets.",
              "Please use this endpoint.")
open(p, "w").write(s)
PY
}

m_criteria_promises_totals_the_signal_page_dropped() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("So there is no per-vendor figure to publish and no table anyone could screenshot as &ldquo;AgentDeals&rsquo; most-recommended vendor&rdquo;. <a href=\"${SIGNAL_DOC_PATH}\">The signal page</a> documents the call and publishes no counts at all.",
              "We publish the aggregate totals on <a href=\"${SIGNAL_DOC_PATH}\">the signal page</a>, including the unflattering ones; we do not publish a table anyone could screenshot as &ldquo;AgentDeals&rsquo; most-recommended vendor&rdquo;.")
open(p, "w").write(s)
PY
}

run_mutation "the projection publishes everything" m_the_projection_publishes_everything
run_mutation "our own traffic is published" m_our_traffic_is_published
run_mutation "the rate is withheld but its prose is not" m_the_rate_is_withheld_but_its_prose_is_not
run_mutation "the self-identifier is published" m_the_self_identifier_is_published
run_mutation "the names we do not index are published" m_the_names_we_do_not_index_are_published
run_mutation "only the headline window is reduced" m_only_the_headline_window_is_reduced
run_mutation "the projection reduces the internal report in place" m_the_projection_reduces_the_internal_report_in_place
run_mutation "a note describes a field no caller receives" m_a_note_describes_a_field_no_caller_receives
run_mutation "the endpoint publishes the full report" m_the_endpoint_publishes_the_full_report
run_mutation "the operator loses the read path too" m_the_operator_loses_the_read_path_too
run_mutation "any bearer token opens the full report" m_any_bearer_token_opens_the_full_report
run_mutation "the page denies the referral links again" m_the_page_denies_the_referral_links_again
run_mutation "the numbers table comes back" m_the_numbers_table_comes_back
run_mutation "the page offers the machine-readable figures again" m_the_page_offers_the_machine_readable_figures_again
run_mutation "the deference sentence is paraphrased" m_the_deference_sentence_is_paraphrased
run_mutation "the exposition grows back" m_the_exposition_grows_back
run_mutation "the page states a limit of its own" m_the_page_states_a_limit_of_its_own
run_mutation "the worked example stops rotating" m_the_worked_example_stops_rotating
run_mutation "the rotation includes a vendor that pays us" m_the_rotation_includes_a_vendor_that_pays_us
run_mutation "the rotation names a vendor we do not carry" m_the_rotation_names_a_vendor_we_do_not_carry
run_mutation "llms.txt denies the referral links again" m_llms_denies_the_referral_links_again
run_mutation "llms.txt promises the totals again" m_llms_promises_the_totals_again
run_mutation "llms.txt stops saying why we ask" m_llms_stops_saying_why_we_ask
run_mutation "criteria promises totals the signal page dropped" m_criteria_promises_totals_the_signal_page_dropped

restore
npm run build > /dev/null 2>&1
echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
