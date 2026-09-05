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
RATCHET_BUDGETS="${GATE_RATCHET_BUDGETS:-}"
BUDGETS_PATH="data/quality_budgets.json"
UPDATE_PAGE_LASTMOD="${GATE_UPDATE_PAGE_LASTMOD:-}"
PAGE_LASTMOD_PATH="data/page-lastmod.json"

among_the_committable() {
  local wanted="$1"
  shift
  for path in "$@"; do
    case "$wanted" in "$path"|"$path"/*) return 0 ;; esac
  done
  return 1
}

if [ -n "$RATCHET_BUDGETS" ] && ! among_the_committable "$BUDGETS_PATH" "$@"; then
  echo "usage: GATE_RATCHET_BUDGETS is set but $BUDGETS_PATH is not among the paths this run may commit ($*), so a budget lowered here would be left behind in the workspace." >&2
  exit 2
fi

if [ -n "$UPDATE_PAGE_LASTMOD" ] && ! among_the_committable "$PAGE_LASTMOD_PATH" "$@"; then
  echo "usage: GATE_UPDATE_PAGE_LASTMOD is set but $PAGE_LASTMOD_PATH is not among the paths this run may commit ($*), so the days read here would be left behind in the workspace." >&2
  exit 2
fi

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
SUBPROCESS_OUTPUT="$(mktemp)"
export GATE_FAILING_FILES
export GITHUB_OUTPUT="$SUBPROCESS_OUTPUT"
trap 'rm -f "$LOG" "$VERDICT" "$GATE_FAILING_FILES" "$SUBPROCESS_OUTPUT"' EXIT

push_to_main() {
  git push origin HEAD:main
}

quarantine() {
  local why="$1"
  local ref="${QUARANTINE_PREFIX}-$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT}"
  {
    echo "quarantined=true"
    echo "quarantine_ref=$ref"
    echo "quarantined_commit=$COMMIT"
    echo "quarantine_reason=$why"
  } >>"$OUTPUT"
  if git push origin "HEAD:refs/heads/$ref"; then
    echo "Held back because $why — $COMMIT is on $ref and main is unchanged."
  else
    echo "Held back because $why — $COMMIT could not be pushed to $ref and main is unchanged. This run's data exists only in its own workspace."
  fi
  exit 1
}

summarize() {
  grep -E '(tests|pass|fail) [0-9]+$' "$LOG" | tail -3 || true
}

if ! npm run build >"$LOG" 2>&1; then
  tail -n 60 "$LOG"
  echo "The build failed, and no test-file allowance covers code that does not compile."
  quarantine "the build does not compile"
fi

if [ -n "$RATCHET_BUDGETS" ]; then
  echo "── Lowering any quality budget this run's data has earned ──"
  if ! npm run ratchet:budgets; then
    echo "The budgets could not be measured. That decides nothing about whether this run's data is right, so the data is held rather than discarded."
    quarantine "the quality budgets could not be measured"
  fi
  if [ -n "$(git status --porcelain -- "$@")" ]; then
    git add -- "$@"
    git commit -q --amend --no-edit
    COMMIT="$(git rev-parse --short HEAD)"
    echo "A budget fell to what this run's data measures, in the same commit as the data that earned it."
  fi
fi

if [ -n "$UPDATE_PAGE_LASTMOD" ]; then
  echo "── Reading every page this run renders, to date the ones whose output moved ──"
  if node "$SCRIPT_DIR/update-page-lastmod.js"; then
    if [ -n "$(git status --porcelain -- "$@")" ]; then
      git add -- "$@"
      git commit -q --amend --no-edit
      COMMIT="$(git rev-parse --short HEAD)"
      echo "The pages whose output this run moved are dated today, in the same commit as the data that moved them."
    fi
  else
    echo "The pages could not be read, so each one keeps the day it last changed. That says nothing about whether this run's data is right, so the data goes on to the suite."
  fi
fi

if env -u GATE_RATCHET_BUDGETS -u GATE_UPDATE_PAGE_LASTMOD npm run test:gated >>"$LOG" 2>&1; then
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
quarantine "the suite refused it"
