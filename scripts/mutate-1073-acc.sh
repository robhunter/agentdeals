#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
PROV="test/page-data-provenance.test.ts"

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="${5:-$PROV}"
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

  if ! npm run build > /tmp/mut-acc-build.log 2>&1; then
    echo "SKIP  $name (build failed)"
    mv "$file.bak" "$file"
    npm run build > /dev/null 2>&1
    FAIL=$((FAIL + 1))
    return
  fi

  node --test $tests > /tmp/mut-acc.log 2>&1
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

run_mutation "every page may cite the index" src/page-reviews.ts \
  'if (record.reads_index) return indexCitation(indexSize);' \
  'if (record.reads_index || record.published >= "") return indexCitation(indexSize);'

run_mutation "no page states when it was compiled" src/page-reviews.ts \
  'return compiledNotice(record.published, reviewStatus(record, today).reviewed_at);' \
  'return "";'

run_mutation "the compiled notice carries today instead of the compilation date" src/page-reviews.ts \
  'return compiledNotice(record.published, reviewStatus(record, today).reviewed_at);' \
  'return compiledNotice(today, reviewStatus(record, today).reviewed_at);'

run_mutation "a missing register entry defaults to reading the index" src/page-reviews.ts \
  'reads_index: raw.reads_index === true,' \
  'reads_index: raw.reads_index !== false,' \
  "$PROV test/page-freshness.test.ts"

run_mutation "the catalogue path cannot be pointed elsewhere" src/data.ts \
  'process.env.AGENTDEALS_INDEX_PATH || path.join(__dirname, "..", "data", "index.json")' \
  'path.join(__dirname, "..", "data", "index.json")'

echo
echo "killed $PASS, survived/skipped $FAIL"
[ "$FAIL" -eq 0 ]
