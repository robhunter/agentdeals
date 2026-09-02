#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/data.ts src/slug.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/vendor-match-boundaries.test.ts test/audit-stack.test.ts test/vendor-risk.test.ts test/vendor-slug.test.ts"

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
  if ! npm run build > /tmp/mutate-1269-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1269-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1269-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1269-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_back_to_raw_substring() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  const namedWithQualifiers = offers.filter((o) => isSubSlug(toSlug(o.vendor), asked));",
  "  const namedWithQualifiers = offers.filter((o) => name.toLowerCase().includes(o.vendor.toLowerCase()));")
open(p, "w").write(s)
PY
}

m_confident_match_uses_the_other_direction() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  const namedWithQualifiers = offers.filter((o) => isSubSlug(toSlug(o.vendor), asked));",
  "  const namedWithQualifiers = offers.filter((o) => isSubSlug(asked, toSlug(o.vendor)));")
open(p, "w").write(s)
PY
}

m_first_of_several_matches_wins() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  if (namedWithQualifiers.length === 1) return { type: \"inferred\", offer: namedWithQualifiers[0] };",
  "  if (namedWithQualifiers.length >= 1) return { type: \"inferred\", offer: namedWithQualifiers[0] };")
open(p, "w").write(s)
PY
}

m_suggestions_repeat_a_vendor() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  const suggestions = [...new Set([...namedWithQualifiers, ...longerNamesContainingIt].map((o) => o.vendor))];",
  "  const suggestions = [...namedWithQualifiers, ...longerNamesContainingIt].map((o) => o.vendor);")
open(p, "w").write(s)
PY
}

m_no_suggestions_for_a_word_inside_a_longer_name() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  const longerNamesContainingIt = offers.filter((o) => isSubSlug(asked, toSlug(o.vendor)));",
  "  const longerNamesContainingIt: Offer[] = [];")
open(p, "w").write(s)
PY
}

m_empty_input_falls_through_to_matching() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  const asked = toSlug(name);\n  if (!asked) return { type: \"none\", suggestions: [] };",
  "  const asked = toSlug(name);")
open(p, "w").write(s)
PY
}

m_every_match_reports_itself_as_exact() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  return { requested, matched: match.offer.vendor, type: match.type };",
  "  return { requested, matched: match.offer.vendor, type: \"exact\" };")
open(p, "w").write(s)
PY
}

m_the_summary_stops_naming_the_other_record() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "  if (matchNotice.type === \"inferred\") {\n    summary = `${answeredAboutAnotherNameSentence(matchNotice)} ${summary}`;\n  }",
  "")
open(p, "w").write(s)
PY
}

m_audit_treats_an_inferred_match_as_found() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "    if (match.type !== \"exact\") {",
  "    if (match.type === \"none\") {")
open(p, "w").write(s)
PY
}

m_audit_drops_the_suggestion_it_matched() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace(
  "      const suggestions = match.type === \"inferred\" ? [match.offer.vendor] : match.suggestions;",
  "      const suggestions = match.type === \"inferred\" ? [] : match.suggestions;")
open(p, "w").write(s)
PY
}

m_boundary_prefix_matches_mid_word() {
  py <<'PY'
p = "src/slug.ts"
s = open(p).read()
s = s.replace('  if (haystack.startsWith(needle + "-")) return true;', "  if (haystack.startsWith(needle)) return true;")
open(p, "w").write(s)
PY
}

m_boundary_suffix_matches_mid_word() {
  py <<'PY'
p = "src/slug.ts"
s = open(p).read()
s = s.replace('  if (haystack.endsWith("-" + needle)) return true;', "  if (haystack.endsWith(needle)) return true;")
open(p, "w").write(s)
PY
}

run_mutation "the matcher goes back to a raw substring test" m_back_to_raw_substring
run_mutation "a fragment of a longer vendor name becomes a confident match" m_confident_match_uses_the_other_direction
run_mutation "a query naming several vendors answers as the first" m_first_of_several_matches_wins
run_mutation "suggestions repeat a vendor once per record" m_suggestions_repeat_a_vendor
run_mutation "a word inside a longer vendor name is offered no suggestion" m_no_suggestions_for_a_word_inside_a_longer_name
run_mutation "input that slugs to nothing is matched rather than refused" m_empty_input_falls_through_to_matching
run_mutation "every match reports itself as exact" m_every_match_reports_itself_as_exact
run_mutation "the summary stops naming the record it answered about" m_the_summary_stops_naming_the_other_record
run_mutation "an audit treats an inferred match as a service it analysed" m_audit_treats_an_inferred_match_as_found
run_mutation "an audit drops the suggestion it inferred" m_audit_drops_the_suggestion_it_matched
run_mutation "the boundary prefix test matches mid-word" m_boundary_prefix_matches_mid_word
run_mutation "the boundary suffix test matches mid-word" m_boundary_suffix_matches_mid_word

restore
echo ""
echo "killed:   $killed"
echo "survived: $survived"
