#!/bin/bash
set -u
cd "$(dirname "$0")/.." || exit 1

TESTS="test/tier-vocabulary.test.ts test/ranking.test.ts"

run_case() {
  local name="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mut-backup
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
n = s.count(old)
if n != 1:
    print(f"PATTERN-MISS ({n})")
    sys.exit(3)
open(path, "w").write(s.replace(old, new))
PY
  if [ $? -eq 3 ]; then cp /tmp/mut-backup "$file"; echo "SKIP    $name (pattern not found exactly once)"; return; fi
  if ! npm run build > /tmp/mut-build.log 2>&1; then
    cp /tmp/mut-backup "$file"
    echo "KILLED  $name (build)"
    return
  fi
  node --test $TESTS > /tmp/mut-test.log 2>&1
  local code=$?
  cp /tmp/mut-backup "$file"
  if [ $code -ne 0 ]; then
    echo "KILLED  $name  <- $(grep -m1 '✖ ' /tmp/mut-test.log | sed 's/^ *//')"
  else
    echo "SURVIVED $name"
  fi
}

run_case "a record carries a tier string nobody has decided about" data/index.json \
  '"tier": "Little Lemur"' \
  '"tier": "Sprinting Salamander"'

run_case "the fixture stops listing a string the data still carries" test/tier-vocabulary.json \
  '  "Always Free",' \
  ''

run_case "the fixture lists a string no record carries" test/tier-vocabulary.json \
  '  "Basic",' \
  '  "Basic",
  "Basic Plus",'

run_case "the fixture is written unsorted" test/tier-vocabulary.json \
  '[
  "API-FREE",
  "Always Free",' \
  '[
  "Always Free",
  "API-FREE",'

run_case "the free class stops being the fall-through default" src/ranking.ts \
  '  return { class: "free", note: "an ongoing free tier" };' \
  '  return { class: "not_free", note: "an ongoing free tier" };'

run_case "the time-limited rules stop being consulted" src/ranking.ts \
  '  for (const rule of TIME_LIMITED_TIER_RULES) {' \
  '  for (const rule of [] as typeof TIME_LIMITED_TIER_RULES) {'
