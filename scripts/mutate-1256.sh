#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/provenance.ts src/server.ts src/serve.ts src/server-remote.ts src/data.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/response-provenance.test.ts test/served-response-citation.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  local changed=0
  for f in $FILES; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1256-build.log 2>&1; then
    echo "    KILLED BY TSC ONLY: rewrite it to typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1256-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1256-test.log) failing assertion(s)"
    grep '  ✖ ' /tmp/mutate-1256-test.log | head -3
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_the_newest_date_stands_in_for_the_oldest() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('.filter((d): d is string => d !== null).sort();',
              '.filter((d): d is string => d !== null).sort().reverse();')
open(p, "w").write(s)
PY
}

m_the_response_time_stands_in_for_the_record_date() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  const date = oldestDate(dated);',
              '  const date = new Date().toISOString().slice(0, 10);')
open(p, "w").write(s)
PY
}

m_a_set_is_dated_as_though_it_were_one_record() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('const clause = single ? `checked ${date}` : `oldest figure checked ${date}`;',
              'const clause = `checked ${date}`;')
open(p, "w").write(s)
PY
}

m_one_record_is_dated_as_though_it_were_a_set() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('const clause = single ? `checked ${date}` : `oldest figure checked ${date}`;',
              'const clause = `oldest figure checked ${date}`;')
open(p, "w").write(s)
PY
}

m_the_vendor_page_is_never_narrow_enough() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  if (slugs.size === 1) return `/vendor/${[...slugs][0]}`;', '')
open(p, "w").write(s)
PY
}

m_the_category_page_is_cited_for_records_spanning_categories() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  if (categories.size === 1) {', '  if (categories.size >= 1) {')
open(p, "w").write(s)
PY
}

m_the_category_page_is_never_cited() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  if (categories.size === 1) {', '  if (categories.size === 0) {')
open(p, "w").write(s)
PY
}

m_a_gated_record_counts_as_one_we_rank() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  return typeof gate === "object" && gate !== null && typeof (gate as { code?: unknown }).code === "string";',
              '  return false;')
open(p, "w").write(s)
PY
}

m_the_date_covers_gated_records_too() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  const dated = ranked.length > 0 ? ranked : records;',
              '  const dated = records;')
open(p, "w").write(s)
PY
}

m_the_withholding_sentence_ships_on_every_response() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('    ...(withheld > 0 ? { gated_note: CITE_GATED_NOTE } : {}),',
              '    gated_note: CITE_GATED_NOTE,')
open(p, "w").write(s)
PY
}

m_the_withholding_sentence_never_ships() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('    ...(withheld > 0 ? { gated_note: CITE_GATED_NOTE } : {}),', '')
open(p, "w").write(s)
PY
}

m_the_deference_sentence_ships_twice() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  if (options.deference !== false) block.this_is_a_request_not_an_instruction = DEFERENCE;',
              '  block.this_is_a_request_not_an_instruction = DEFERENCE;')
open(p, "w").write(s)
PY
}

m_the_deference_sentence_never_ships() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  if (options.deference !== false) block.this_is_a_request_not_an_instruction = DEFERENCE;', '')
open(p, "w").write(s)
PY
}

m_the_projected_verification_date_is_dropped() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  const verified = isoDate(node.verifiedDate) ?? isoDate(node.verified_date);',
              '  const verified = isoDate(node.verifiedDate);')
open(p, "w").write(s)
PY
}

m_any_bare_date_field_dates_a_record() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  if (typeof node.change_type !== "string") return null;', '')
open(p, "w").write(s)
PY
}

m_a_change_is_dated_by_the_event_not_the_record() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  return isoDate(node.recorded_date) ?? isoDate(node.date);',
              '  return isoDate(node.date) ?? isoDate(node.recorded_date);')
open(p, "w").write(s)
PY
}

m_nested_records_are_never_found() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('    for (const value of Object.values(obj)) visit(value, depth + 1);', '')
open(p, "w").write(s)
PY
}

m_the_index_is_not_consulted_for_a_missing_date() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  const records = dateForSlug\n    ? found.map((r) => (r.date ? r : { ...r, date: dateForSlug(r.slug) }))\n    : found;',
              '  const records = found;')
open(p, "w").write(s)
PY
}

m_the_index_reports_the_freshest_date_for_a_vendor() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('    if (oldest === null || offer.verifiedDate < oldest) oldest = offer.verifiedDate;',
              '    if (oldest === null || offer.verifiedDate > oldest) oldest = offer.verifiedDate;')
open(p, "w").write(s)
PY
}

m_the_search_tool_stops_citing() {
  py <<'PY'
p = "src/server.ts"
s = open(p).read()
s = s.replace('text: citedJson({ results: outputResults, total: finalTotal, limit: effectiveLimit, offset: effectiveOffset, ...disclosure })',
              'text: JSON.stringify({ results: outputResults, total: finalTotal, limit: effectiveLimit, offset: effectiveOffset, ...disclosure }, null, 2)')
open(p, "w").write(s)
PY
}

m_the_json_routes_stop_citing() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('    _provenance: provenanceBlock(BASE_URL, payload, { deference: false, dateForSlug: oldestVerifiedDateForSlug }),\n', '')
s = s.replace('function withAgentBlock<T extends object>(payload: T, slug?: string | null): T & { _agent: Record<string, unknown>; _provenance: Record<string, unknown> } {',
              'function withAgentBlock<T extends object>(payload: T, slug?: string | null): T & { _agent: Record<string, unknown> } {')
open(p, "w").write(s)
PY
}

m_the_proxy_drops_the_citation() {
  py <<'PY'
p = "src/server-remote.ts"
s = open(p).read()
s = s.replace('return mcpText(data.offer, data);', 'return mcpText(data.offer);')
s = s.replace('offset: effectiveOffset }, data);', 'offset: effectiveOffset });')
open(p, "w").write(s)
PY
}

m_the_root_url_doubles_its_slash() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  return path === "/" ? root : `${root}${path}`;', '  return `${root}${path}`;')
open(p, "w").write(s)
PY
}

m_any_node_naming_a_vendor_counts_as_a_record() {
  py <<'PY2'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('  return RECORD_FIELDS.some((field) => node[field] !== undefined && node[field] !== null);',
              '  return node !== null;')
open(p, "w").write(s)
PY2
}

m_only_a_dated_node_counts_as_a_record() {
  py <<'PY2'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace('const RECORD_FIELDS = ["verifiedDate", "verified_date", "change_type", "tier", "current_tier", "category"] as const;',
              'const RECORD_FIELDS = ["verifiedDate", "verified_date"] as const;')
open(p, "w").write(s)
PY2
}

run_mutation "the newest date stands in for the oldest" m_the_newest_date_stands_in_for_the_oldest
run_mutation "the response time stands in for the record date" m_the_response_time_stands_in_for_the_record_date
run_mutation "a set is dated as though it were one record" m_a_set_is_dated_as_though_it_were_one_record
run_mutation "one record is dated as though it were a set" m_one_record_is_dated_as_though_it_were_a_set
run_mutation "the vendor page is never narrow enough" m_the_vendor_page_is_never_narrow_enough
run_mutation "the category page is cited for records spanning categories" m_the_category_page_is_cited_for_records_spanning_categories
run_mutation "the category page is never cited" m_the_category_page_is_never_cited
run_mutation "a gated record counts as one we rank" m_a_gated_record_counts_as_one_we_rank
run_mutation "the date covers gated records too" m_the_date_covers_gated_records_too
run_mutation "the withholding sentence ships on every response" m_the_withholding_sentence_ships_on_every_response
run_mutation "the withholding sentence never ships" m_the_withholding_sentence_never_ships
run_mutation "the deference sentence ships twice" m_the_deference_sentence_ships_twice
run_mutation "the deference sentence never ships" m_the_deference_sentence_never_ships
run_mutation "the projected verification date is dropped" m_the_projected_verification_date_is_dropped
run_mutation "any bare date field dates a record" m_any_bare_date_field_dates_a_record
run_mutation "a change is dated by the event not the record" m_a_change_is_dated_by_the_event_not_the_record
run_mutation "nested records are never found" m_nested_records_are_never_found
run_mutation "the index is not consulted for a missing date" m_the_index_is_not_consulted_for_a_missing_date
run_mutation "the index reports the freshest date for a vendor" m_the_index_reports_the_freshest_date_for_a_vendor
run_mutation "the search tool stops citing" m_the_search_tool_stops_citing
run_mutation "the json routes stop citing" m_the_json_routes_stop_citing
run_mutation "the proxy drops the citation" m_the_proxy_drops_the_citation
run_mutation "the root url doubles its slash" m_the_root_url_doubles_its_slash

run_mutation "any node naming a vendor counts as a record" m_any_node_naming_a_vendor_counts_as_a_record
run_mutation "only a dated node counts as a record" m_only_a_dated_node_counts_as_a_record

echo ""
echo "killed=$killed survived=$survived"
