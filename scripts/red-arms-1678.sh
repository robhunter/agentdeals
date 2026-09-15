#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

SNAP=$(mktemp -d)
cp src/stats.ts "$SNAP/stats.ts"
cp src/serve.ts "$SNAP/serve.ts"
cp test/search-query-sanitization.test.ts "$SNAP/test.ts"

restore() {
  cp "$SNAP/stats.ts" src/stats.ts
  cp "$SNAP/serve.ts" src/serve.ts
  cp "$SNAP/test.ts" test/search-query-sanitization.test.ts
  npm run build >/dev/null 2>&1
}
trap 'restore; rm -rf "$SNAP"; echo; echo "--- git status at exit ---"; git status --short' EXIT

arm() {
  local name="$1"
  shift
  "$@"
  if ! npm run build >/dev/null 2>&1; then
    echo "BUILD-FAIL  $name"
    restore
    return
  fi
  local out
  out=$(timeout 300 node --test --test-concurrency 1 test/search-query-sanitization.test.ts 2>&1)
  local failed
  failed=$(echo "$out" | grep -E "^. fail " | head -1 | tr -dc '0-9')
  if [ "${failed:-0}" -gt 0 ]; then
    echo "RED   ($failed failing)  $name"
    echo "$out" | grep -E "^\s+✖|not ok" | head -3 | sed 's/^/        /'
  else
    echo "STILL GREEN               $name"
  fi
  restore
}

echo "=== red arms for the search-query sanitization guard ==="

arm "recordSearchQuery keeps the caller's raw string" \
  perl -0pi -e 's/const normalized = recordedQueryForm\(query\);/const normalized = query.trim().toLowerCase();/' src/stats.ts

arm "the persisted ring is read back without sanitizing" \
  perl -0pi -e 's/\n *parsed\.query = recordedQueryForm\(parsed\.query\);\n *if \(!parsed\.query\) continue;//' src/stats.ts

arm "the web path passes the raw query and the others do not" \
  perl -0pi -e 's/const normalized = recordedQueryForm\(query\);/const normalized = context.source === "web" ? query.trim().toLowerCase() : recordedQueryForm(query);/' src/stats.ts

arm "a fourth recording call site names no surface" \
  perl -0pi -e 's/(  \} else if \(url\.pathname === "\/search" && isGetOrHead\) \{\n)/$1    if (url.searchParams.get("probe")) recordSearchQuery(url.searchParams.get("probe") ?? undefined, 0);\n/' src/serve.ts

arm "no probe exercises the web path" \
  perl -0pi -e 's/^  web: exerciseWeb,\n//m' test/search-query-sanitization.test.ts
