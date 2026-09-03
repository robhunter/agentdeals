#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/change-resolution.ts src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/change-resolution.test.ts test/change-lineup.test.ts"

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
  if ! npm run build > /tmp/mutate-1282p-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test $TESTS > /tmp/mutate-1282p-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1282p-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1282p-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_the_tag_is_appended_instead_of_prefixed() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("  const tagged = change.summary.startsWith(tag) ? change.summary : `${tag} ${change.summary}`;",
              "  const tagged = change.summary.endsWith(tag) ? change.summary : `${change.summary} ${tag}`;")
open(p, "w").write(s)
PY
}

m_no_tag_is_derived_at_all() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("  const tagged = change.summary.startsWith(tag) ? change.summary : `${tag} ${change.summary}`;",
              "  const tagged = change.summary;")
open(p, "w").write(s)
PY
}

m_the_tag_fires_only_when_no_detail_was_written() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("  const tagged = change.summary.startsWith(tag) ? change.summary : `${tag} ${change.summary}`;",
              "  const tagged = detail || change.summary.startsWith(tag) ? change.summary : `${tag} ${change.summary}`;")
open(p, "w").write(s)
PY
}

m_both_states_derive_the_same_tag() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('  retracted: (date) => `Retracted — this record was our error (${date}).`,',
              '  retracted: (date) => `No longer in force (${date}).`,')
open(p, "w").write(s)
PY
}

m_the_tag_does_not_name_its_date() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('  reversed: (date) => `No longer in force (${date}).`,\n  retracted: (date) => `Retracted — this record was our error (${date}).`,',
              '  reversed: () => "No longer in force.",\n  retracted: () => "Retracted.",')
open(p, "w").write(s)
PY
}

m_the_tag_is_prefixed_a_second_time_on_reload() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("  const tagged = change.summary.startsWith(tag) ? change.summary : `${tag} ${change.summary}`;",
              "  const tagged = `${tag} ${change.summary}`;")
open(p, "w").write(s)
PY
}

m_the_detail_is_prefixed_ahead_of_the_claim() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("  return `${tagged} ${detail}`;", "  return `${detail} ${tagged}`;")
open(p, "w").write(s)
PY
}

m_the_detail_is_dropped_now_that_a_tag_exists() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("  if (!detail || tagged.includes(detail)) return tagged;\n  return `${tagged} ${detail}`;",
              "  return tagged;")
open(p, "w").write(s)
PY
}

m_the_guard_reads_the_derived_tag_as_free_text() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("    ? [resolutionTag(change.resolution), change.resolution.detail ?? \"\"].filter(Boolean)",
              "    ? [change.resolution.detail ?? \"\"].filter(Boolean)")
open(p, "w").write(s)
PY
}

m_the_guard_reads_the_written_detail_as_free_text() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace("    ? [resolutionTag(change.resolution), change.resolution.detail ?? \"\"].filter(Boolean)",
              "    ? [resolutionTag(change.resolution)].filter(Boolean)")
open(p, "w").write(s)
PY
}

m_the_guard_strips_the_tag_from_a_record_that_has_no_resolution() {
  py <<'PY'
p = "src/change-resolution.ts"
s = open(p).read()
s = s.replace('''  const written = change.resolution
    ? [resolutionTag(change.resolution), change.resolution.detail ?? ""].filter(Boolean)
    : [];''',
              '''  const written = RESOLUTION_STATES.map((state) =>
    resolutionTag({ state, date: (change.resolution?.date ?? "2026-09-02") })
  ).concat(change.resolution?.detail ?? "").filter(Boolean);''')
open(p, "w").write(s)
PY
}

m_a_retracted_claim_is_typed_back_into_a_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('      hiddenCosts: "Credit-based pricing can pause sites on exhaustion.',
              '      hiddenCosts: "Every repo committer is now charged as a full Pro seat ($19/mo) when using CMS/Identity with private repos. Credit-based pricing can pause sites on exhaustion.')
open(p, "w").write(s)
PY
}

run_mutation "the tag is appended instead of prefixed" m_the_tag_is_appended_instead_of_prefixed
run_mutation "no tag is derived at all" m_no_tag_is_derived_at_all
run_mutation "the tag fires only when no detail was written" m_the_tag_fires_only_when_no_detail_was_written
run_mutation "both states derive the same tag" m_both_states_derive_the_same_tag
run_mutation "the tag does not name its date" m_the_tag_does_not_name_its_date
run_mutation "the tag is prefixed a second time on reload" m_the_tag_is_prefixed_a_second_time_on_reload
run_mutation "the detail is prefixed ahead of the claim" m_the_detail_is_prefixed_ahead_of_the_claim
run_mutation "the detail is dropped now that a tag exists" m_the_detail_is_dropped_now_that_a_tag_exists
run_mutation "the guard reads the derived tag as free text" m_the_guard_reads_the_derived_tag_as_free_text
run_mutation "the guard reads the written detail as free text" m_the_guard_reads_the_written_detail_as_free_text
run_mutation "the guard strips a tag no resolution wrote" m_the_guard_strips_the_tag_from_a_record_that_has_no_resolution
run_mutation "a retracted claim is typed back into a page" m_a_retracted_claim_is_typed_back_into_a_page

echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
