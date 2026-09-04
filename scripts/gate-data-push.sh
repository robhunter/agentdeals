#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: gate-data-push.sh <quarantine-prefix> <commit-message> <path>..." >&2
  exit 2
fi

QUARANTINE_PREFIX="$1"
MESSAGE="$2"
shift 2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"

if [ -z "$(git status --porcelain -- "$@")" ]; then
  echo "No change under $* — nothing to commit or push."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -- "$@"
git commit -q -m "$MESSAGE"
COMMIT="$(git rev-parse --short HEAD)"

LOG="$(mktemp)"
VERDICT="$(mktemp)"
GATE_FAILING_FILES="$(mktemp)"
export GATE_FAILING_FILES
trap 'rm -f "$LOG" "$VERDICT" "$GATE_FAILING_FILES"' EXIT

push_to_main() {
  git push origin HEAD:main
}

quarantine() {
  local ref="${QUARANTINE_PREFIX}-$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT}"
  {
    echo "quarantined=true"
    echo "quarantine_ref=$ref"
    echo "quarantined_commit=$COMMIT"
  } >>"$OUTPUT"
  if git push origin "HEAD:refs/heads/$ref"; then
    echo "Suite red — $COMMIT is held on $ref and main is unchanged."
  else
    echo "Suite red — $COMMIT could not be held on $ref and main is unchanged. This run's data exists only in its own workspace."
  fi
  exit 1
}

summarize() {
  grep -E '(tests|pass|fail) [0-9]+$' "$LOG" | tail -3 || true
}

if ! npm run build >"$LOG" 2>&1; then
  tail -n 60 "$LOG"
  echo "The build failed, and no test-file allowance covers code that does not compile."
  quarantine
fi

if npm run test:gated >>"$LOG" 2>&1; then
  summarize
  push_to_main
  echo "Suite green — $COMMIT is on main."
  exit 0
fi

summarize
if grep -q 'failing tests:' "$LOG"; then
  sed -n '/failing tests:/,$p' "$LOG"
else
  tail -n 60 "$LOG"
fi

if node "$SCRIPT_DIR/gate-verdict.js" "$GATE_FAILING_FILES" >"$VERDICT" 2>&1; then
  cat "$VERDICT"
  {
    echo "quarantined=false"
    echo "pushed_over_failures=true"
    echo "non_blocking_files=$(tr '\n' ' ' <"$GATE_FAILING_FILES")"
  } >>"$OUTPUT"
  push_to_main
  echo "Suite red — $COMMIT is on main anyway. Every failing file above measures how current our own reading is; none of them says this data is wrong."
  exit 0
fi

cat "$VERDICT"
quarantine
