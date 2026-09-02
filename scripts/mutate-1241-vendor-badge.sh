#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/vendor-verdict.test.ts
  test/retired-vendor-page.test.ts
  test/link-liveness-pages.test.ts
)

SOURCES=(src/vendor-verdict.ts src/serve.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").borig"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").borig" "$f"; done; }

backup
trap 'restore; npm run build >/dev/null 2>&1' EXIT

killed=0
survived=0

run_mutation() {
  local name="$1"; shift
  restore
  if ! "$@"; then
    echo "NOT APPLIED                $name"
    return
  fi
  if ! npm run build >/dev/null 2>&1; then
    echo "KILLED (does not compile)  $name"
    killed=$((killed + 1))
    return
  fi
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1241-out.txt 2>&1; then
    echo "SURVIVED                   $name"
    survived=$((survived + 1))
  else
    local failed
    failed=$(grep -c '^ *✖' /tmp/mutation-1241-out.txt || true)
    echo "KILLED ($failed assertions) $name"
    killed=$((killed + 1))
  fi
}

sub() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if old not in text:
    sys.exit("mutation target not found in " + path)
open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
PY
}

run_mutation "the badge rates a record the ranker gates, as it did before" \
  sub src/vendor-verdict.ts '  if (input.gated) return { kind: "none" };
  if (input.level === null)' \
                            '  if (input.level === null)'

run_mutation "the badge reads one gate code out of five" \
  sub src/serve.ts 'gated: primaryGate !== null,
    linkUnreachable' \
                   'gated: primaryGate !== null && primaryGate.code === "eligibility_restricted",
    linkUnreachable'

run_mutation "the badge rates an ended offer instead of naming its state" \
  sub src/vendor-verdict.ts 'if (input.offerEnded) return { kind: "ended" };' \
                            'if (input.offerEnded && false) return { kind: "ended" };'

run_mutation "the cause line explains a level the verdict does not state" \
  sub src/vendor-verdict.ts '  const word = vendorVerdictWord(input);
  return word !== null && word !== "stable" && input.cause !== null;' \
                            '  return publishedVendorLevel(input.level, input.cause) !== "stable" && input.cause !== null;'

run_mutation "the badge ignores an unreachable link" \
  sub src/serve.ts 'linkUnreachable: Boolean(linkUnreachable),' \
                   'linkUnreachable: false,'

run_mutation "the badge rates a vendor we hold no level for" \
  sub src/vendor-verdict.ts '  if (input.level === null) return { kind: "none" };' \
                            ''

run_mutation "the ended badge is the rating word" \
  sub src/serve.ts 'border:1px solid ${retiredBadgeColor}40">${ENDED_BADGE_LABEL}</span>' \
                   'border:1px solid ${retiredBadgeColor}40">${riskLevel}</span>'

echo
echo "killed: $killed  survived: $survived"
