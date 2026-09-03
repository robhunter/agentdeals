#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/provenance.ts src/server-remote.ts"
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
  if ! npm run build > /tmp/mutate-1308-build.log 2>&1; then
    echo "    KILLED BY TSC ONLY: rewrite it to typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1308-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1308-test.log) failing assertion(s)"
    grep '  ✖ ' /tmp/mutate-1308-test.log | head -3
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_the_page_stays_inside_the_sentence() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("""  return {
    source: CITE_NAME,
    url,""", """  return {
    source: CITE_NAME,
    url: undefined as unknown as string,""")
open(p, "w").write(s)
PY
}

m_we_are_named_only_inside_the_sentence() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("""    source: CITE_NAME,
    url,""", """    source: undefined as unknown as string,
    url,""")
open(p, "w").write(s)
PY
}

m_the_check_date_stays_inside_the_sentence() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("    ...(date ? { checked: date } : {}),\n", "")
open(p, "w").write(s)
PY
}

m_an_undated_response_carries_an_empty_check_date() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("    ...(date ? { checked: date } : {}),", "    checked: date ?? \"\",")
open(p, "w").write(s)
PY
}

m_the_field_names_the_site_root_and_the_sentence_names_the_page() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("""  const url = absolute(baseUrl, path);
  const clause""", """  const url = absolute(baseUrl, "/");
  const clause""")
s = s.replace("cite_as: clause ? `Source: ${CITE_NAME} (${url}, ${clause})` : `Source: ${CITE_NAME} (${url})`,",
              "cite_as: clause ? `Source: ${CITE_NAME} (${absolute(baseUrl, path)}, ${clause})` : `Source: ${CITE_NAME} (${absolute(baseUrl, path)})`,")
open(p, "w").write(s)
PY
}

m_the_field_names_a_page_we_do_not_serve() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("""  const url = absolute(baseUrl, path);
  const clause""", """  const url = `${absolute(baseUrl, path)}/pricing`;
  const clause""")
open(p, "w").write(s)
PY
}

m_the_field_dates_the_response_differently_from_the_sentence() {
  py <<'PY'
p = "src/provenance.ts"
s = open(p).read()
s = s.replace("    ...(date ? { checked: date } : {}),", "    ...(date ? { checked: new Date().toISOString().slice(0, 10) } : {}),")
open(p, "w").write(s)
PY
}

m_the_proxy_forwards_only_the_sentence() {
  py <<'PY'
p = "src/server-remote.ts"
s = open(p).read()
s = s.replace("  return (source as Record<string, unknown>)._provenance;",
              "  const block = (source as Record<string, unknown>)._provenance as Record<string, unknown> | undefined;\n  return block ? { cite_as: block.cite_as, note: block.note } : block;")
open(p, "w").write(s)
PY
}

run_mutation "the page is published only inside the sentence" m_the_page_stays_inside_the_sentence
run_mutation "our name is published only inside the sentence" m_we_are_named_only_inside_the_sentence
run_mutation "the check date is published only inside the sentence" m_the_check_date_stays_inside_the_sentence
run_mutation "an undated response carries an empty check date" m_an_undated_response_carries_an_empty_check_date
run_mutation "the field names the site root while the sentence names the page" m_the_field_names_the_site_root_and_the_sentence_names_the_page
run_mutation "the field names a page we do not serve" m_the_field_names_a_page_we_do_not_serve
run_mutation "the field dates the response from the clock" m_the_field_dates_the_response_differently_from_the_sentence
run_mutation "the proxy forwards the sentence and drops the fields" m_the_proxy_forwards_only_the_sentence

echo ""
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
