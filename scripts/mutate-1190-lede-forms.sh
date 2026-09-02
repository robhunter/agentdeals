#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/category-gate-lede.test.ts
  test/eligibility-disclosure.test.ts
)

SOURCES=(src/eligibility.ts src/gate-disclosure.ts test/category-gate-lede.test.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").lorig"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").lorig" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1190-out.txt 2>&1; then
    echo "SURVIVED                   $name"
    survived=$((survived + 1))
  else
    local failed
    failed=$(grep -c '^ *✖' /tmp/mutation-1190-out.txt || true)
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

run_mutation "the all-gated sentence denies the ranked list twice" \
  sub src/gate-disclosure.ts 'return `None of ${subject} are on our ranked list' \
                             'return `None of ${subject} are not on our ranked list'

run_mutation "eligibility wording covers any entirely gated set, whatever gated it" \
  sub src/eligibility.ts 'return codes.length >= total && codes.every((code) => code === "eligibility_restricted");' \
                         'return codes.length >= total;'

run_mutation "the all-gated form is dropped and the count form takes it" \
  sub src/gate-disclosure.ts 'if (gated >= total && total > 1) return' \
                             'if (false && gated >= total && total > 1) return'

run_mutation "the single-record form is dropped and the count form takes it" \
  sub src/gate-disclosure.ts 'if (gated === 1) return `One of ${subject}' \
                             'if (false) return `One of ${subject}'

run_mutation "the retired clause keeps its singular verb in the plural" \
  sub src/gate-disclosure.ts 'many: (n) => `${n} have ended`' \
                             'many: (n) => `${n} has ended`'

run_mutation "the clause list states the first code and stops" \
  sub src/gate-disclosure.ts 'return clauses.join(", ");' \
                             'return clauses.slice(0, 1).join(", ");'

run_mutation "the lede states the count and no gate sentence at all" \
  sub src/eligibility.ts 'return `${counted}. ${gateDisclosureSentence("them", total, codes)}`;' \
                         'return `${counted}.`;'

run_mutation "the count this test reads back is the one the branch never matched" \
  sub test/category-gate-lede.test.ts 'lede.includes(`None of them are ${ON_THE_RANKED_LIST}`)' \
                                      'lede.includes(`None of them are ${RANKED_LIST_PHRASE}`)'

echo
echo "killed: $killed  survived: $survived"
