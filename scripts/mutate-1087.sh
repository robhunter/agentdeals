#!/usr/bin/env bash
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=("$REPO/scripts/verify-freshness.js" "$REPO/scripts/reverify-rolling.js" "$REPO/.github/workflows/reverify.yml")
BACKUPS=()
for t in "${TARGETS[@]}"; do b=$(mktemp); cp "$t" "$b"; BACKUPS+=("$b"); done
restore() { for i in "${!TARGETS[@]}"; do cp "${BACKUPS[$i]}" "${TARGETS[$i]}"; done; }
trap restore EXIT

TESTS=(test/verify-freshness.test.ts test/change-log-writer.test.ts)

mutate() {
  FILE="$1" FIND="$2" REPLACE="$3" python3 - <<'PY'
import os, sys
path, find, replace = os.environ["FILE"], os.environ["FIND"], os.environ["REPLACE"]
text = open(path, encoding="utf-8").read()
if find not in text:
    sys.exit(2)
open(path, "w", encoding="utf-8").write(text.replace(find, replace, 1))
PY
}

run_case() {
  local name="$1"
  local dirty=0
  for i in "${!TARGETS[@]}"; do cmp -s "${TARGETS[$i]}" "${BACKUPS[$i]}" || dirty=1; done
  if [ "$dirty" -eq 0 ]; then echo "NOT APPLIED: $name"; return; fi
  if (cd "$REPO" && node --test --test-concurrency 1 "${TESTS[@]}" > /tmp/mut-1087.log 2>&1); then
    echo "SURVIVED: $name"
  else
    echo "killed:   $name"
  fi
  restore
}

case_run() { mutate "$1" "$2" "$3" || true; run_case "$4"; }

case_run "$REPO/scripts/verify-freshness.js" \
  '  if (!apiKey) {' \
  '  if (false) {' \
  "a missing key no longer stops the run"

case_run "$REPO/scripts/verify-freshness.js" \
  'export const VERIFIER_MODEL = "google/gemma-3-27b-it";' \
  'export const VERIFIER_MODEL = "some/other-model";' \
  "the request names a different model than the constant"

case_run "$REPO/scripts/verify-freshness.js" \
  '`${baseUrl}/chat/completions`' \
  '`${baseUrl}/completions`' \
  "the request goes to the wrong path"

case_run "$REPO/scripts/verify-freshness.js" \
  'Authorization: `Bearer ${apiKey}`,' \
  '' \
  "the request carries no authorization header"

case_run "$REPO/scripts/verify-freshness.js" \
  '.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "")' \
  '' \
  "a fenced code block is no longer unwrapped"

case_run "$REPO/scripts/verify-freshness.js" \
  'parsed && ["confirmed", "changed", "unclear"].includes(parsed.status) ? parsed : null' \
  'parsed ?? null' \
  "any status is accepted"

case_run "$REPO/scripts/verify-freshness.js" \
  'if (!res.ok) {' \
  'if (false) {' \
  "an error status is treated as a successful answer"

case_run "$REPO/scripts/reverify-rolling.js" \
  '    const client = createVerifierClient();
    verifyFn = (offer, pageText) => verifyOfferAgainstPage(client, offer, pageText);' \
  '    verifyFn = (offer, pageText) => verifyOfferAgainstPage(createVerifierClient(), offer, pageText);' \
  "the client is built per record instead of up front"

case_run "$REPO/.github/workflows/reverify.yml" \
  'reverify-rolling.js --ai --limit' \
  'reverify-rolling.js --limit' \
  "the workflow stops passing --ai"

case_run "$REPO/.github/workflows/reverify.yml" \
  '          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
' \
  '' \
  "the workflow passes the flag without the credential"
