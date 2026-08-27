#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="$5"
  cp "$file" "$file.bak"
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(old) != 1:
    print(f"SKIP: pattern found {s.count(old)} times", file=sys.stderr)
    sys.exit(3)
p.write_text(s.replace(old, new))
PY
  then
    echo "SKIP  $name (pattern stale)"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi

  node --test $tests > /tmp/mut-ac13.log 2>&1
  local status=$?
  mv "$file.bak" "$file"

  if [ $status -ne 0 ]; then
    echo "KILLED  $name"
    PASS=$((PASS + 1))
  else
    echo "SURVIVED  $name  <-- $tests did not notice"
    FAIL=$((FAIL + 1))
  fi
}

run_built_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="$5"
  cp "$file" "$file.bak"
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(old) != 1:
    print(f"SKIP: pattern found {s.count(old)} times", file=sys.stderr)
    sys.exit(3)
p.write_text(s.replace(old, new))
PY
  then
    echo "SKIP  $name (pattern stale)"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi

  if ! npm run build > /tmp/mut-ac13-build.log 2>&1; then
    echo "SKIP  $name (build failed)"
    mv "$file.bak" "$file"
    npm run build > /dev/null 2>&1
    FAIL=$((FAIL + 1))
    return
  fi

  node --test $tests > /tmp/mut-ac13.log 2>&1
  local status=$?
  mv "$file.bak" "$file"
  npm run build > /dev/null 2>&1

  if [ $status -ne 0 ]; then
    echo "KILLED  $name"
    PASS=$((PASS + 1))
  else
    echo "SURVIVED  $name  <-- $tests did not notice"
    FAIL=$((FAIL + 1))
  fi
}

DETECTOR="scripts/check-change-log-staleness.js"
WRITER="test/change-log-writer.test.ts"
STRUCT="test/change-structured-data.test.ts"
PROV="test/change-date-provenance.test.ts"

run_mutation "single-quoted token keeps its quotes" "$DETECTOR" \
  'add(raw, { word: raw.slice(1, end === -1 ? undefined : -1) });' \
  'add(raw);' "$WRITER"

run_mutation "double-quoted token keeps its quotes" "$DETECTOR" \
  'add(closed ? `"${inner}"` : `"${inner}`, { expands, word: inner });' \
  'add(closed ? `"${inner}"` : `"${inner}`, { expands });' "$WRITER"

run_mutation "flag comparison reads the raw text again" "$DETECTOR" \
  '!token.expands && token.word === AI_FLAG' \
  'token.text === AI_FLAG' "$WRITER"

run_mutation "option name compared before quote stripping" "$DETECTOR" \
  'DETECTOR_CLI_OPTIONS.takesValue.includes(token.word)' \
  'DETECTOR_CLI_OPTIONS.takesValue.includes(token.text)' "$WRITER"

run_mutation "bare shell expansion cannot word-split" "$DETECTOR" \
  'add(ch, { expands: true, splittable: true });' \
  'add(ch, { expands: true });' "$WRITER"

run_mutation "workflow expression cannot word-split" "$DETECTOR" \
  'add(raw, { expands: true, splittable: true });' \
  'add(raw, { expands: true });' "$WRITER"

run_mutation "value position swallows a splittable token" "$DETECTOR" \
  'if (token.expands && !token.splittable) continue;' \
  'continue;' "$WRITER"

run_mutation "value position swallows a literal flag" "$DETECTOR" \
  'if (token.expands && !token.splittable) continue;' \
  'if (!token.splittable) continue;' "$WRITER"

run_built_mutation "expiring counts a section it never lists" src/serve.ts \
  'itemListElement: capListSections([upcoming, recent, recentlyDiscovered], 50)' \
  'itemListElement: [...upcoming, ...recentlyDiscovered].slice(0, 50)' "$STRUCT"

run_built_mutation "no section is reserved a slot under the cap" src/change-dates.ts \
  'allotted[i] = 1;' \
  'allotted[i] = 0;' "$PROV"

run_built_mutation "reserved slots are handed out to the earliest section instead" src/change-dates.ts \
  'const take = Math.min(budget, sections[i].length - allotted[i]);' \
  'const take = Math.min(budget, sections[i].length);' "$PROV"

echo
echo "killed $PASS, survived/skipped $FAIL"
[ "$FAIL" -eq 0 ]
