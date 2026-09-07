#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/vendor-lede-truncation.test.ts
  test/superseded-terms.test.ts
  test/stack-page-verdicts.test.ts
)

SOURCES=(src/serve.ts src/terms-opening.ts src/stack-claim.ts src/superseded-description.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1421"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1421" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1421-out.txt 2>&1; then
    echo "SURVIVED                   $name"
    survived=$((survived + 1))
  else
    echo "KILLED                     $name"
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

run_mutation "the free-tier lede goes back to a raw slice" \
  sub src/serve.ts '  const descLimits = punctuatedOpeningOfTerms(publishableTerms, 100);' \
                   '  const descLimits = publishableTerms.slice(0, 100).replace(/\.\s.*$/, "") + ".";'

run_mutation "the verdict goes back to a raw slice" \
  sub src/serve.ts '  const keyLimit = openingOfTerms(publishableTerms, 120);' \
                   '  const keyLimit = publishableTerms.slice(0, 120).replace(/\.\s.*$/, "");'

run_mutation "a clip at a sentence boundary is published unmarked" \
  sub src/terms-opening.ts '  const opening = sentences !== ""
    ? withoutTrailingSeparators(sentences.replace(/[.!?]+$/, ""))
    : withoutASeveredNumber(withoutTrailingSeparators(wordBoundary));
  return markedAsClipped(opening === "" ? wordBoundary : opening);' \
                           '  if (sentences !== "") return sentences;
  const opening = withoutASeveredNumber(withoutTrailingSeparators(wordBoundary));
  return markedAsClipped(opening === "" ? wordBoundary : opening);'

run_mutation "no clip is marked at all" \
  sub src/terms-opening.ts 'function markedAsClipped(text: string): string {
  return `${text}${CLIPPED_TERMS_MARKER}${")".repeat(unclosedBrackets(text))}`;
}' \
                           'function markedAsClipped(text: string): string {
  return `${text}${")".repeat(unclosedBrackets(text))}`;
}'

run_mutation "a clip may leave its bracket open" \
  sub src/terms-opening.ts '  return `${text}${CLIPPED_TERMS_MARKER}${")".repeat(unclosedBrackets(text))}`;' \
                           '  return `${text}${CLIPPED_TERMS_MARKER}`;'

run_mutation "a clip may end on a figure whose unit follows" \
  sub src/terms-opening.ts '    : withoutASeveredNumber(withoutTrailingSeparators(wordBoundary));' \
                           '    : withoutTrailingSeparators(wordBoundary);'

run_mutation "the clip cuts at the cap rather than a word boundary" \
  sub src/terms-opening.ts '  const lastSpace = clipped.lastIndexOf(" ");
  return lastSpace > cap / 2 ? clipped.slice(0, lastSpace) : clipped;' \
                           '  return clipped;'

run_mutation "the opening keeps a trailing comma before the marker" \
  sub src/terms-opening.ts 'function withoutTrailingSeparators(text: string): string {
  return text.replace(/[\s,;:—–-]+$/, "");
}' \
                           'function withoutTrailingSeparators(text: string): string {
  return text;
}'

run_mutation "a second full stop is added to terms that end with one" \
  sub src/terms-opening.ts '  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;' \
                           '  return `${trimmed}.`;'

run_mutation "an unmatched closing bracket counts as an open one" \
  sub src/terms-opening.ts '    else if (character === ")" && open > 0) open--;' \
                           '    else if (character === ")") open--;'

run_mutation "the sentence branch takes one sentence too many" \
  sub src/terms-opening.ts '    if (candidate.length > cap) break;
    longest = candidate;' \
                           '    longest = candidate;
    if (candidate.length > cap) break;'

run_mutation "the terms are never returned whole" \
  sub src/terms-opening.ts '  if (text.length <= cap) return text;' \
                           '  if (text.length < cap / 2) return text;'

run_mutation "the withheld reading stops publishing what it clipped" \
  sub src/superseded-description.ts '  const opening = punctuatedOpeningOfTerms(reading.terms, 90);' \
                                    '  const opening = punctuated(openingOfTerms(reading.terms, 90).replace(/…\)*$/, ""));'

echo
echo "killed:   $killed"
echo "survived: $survived"
