#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: gate-data-push.sh <quarantine-prefix> <commit-message> <path>..." >&2
  exit 2
fi

QUARANTINE_PREFIX="$1"
MESSAGE="$2"
shift 2
COMMITTABLE=("$@")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
RATCHET_BUDGETS="${GATE_RATCHET_BUDGETS:-}"
BUDGETS_PATH="data/quality_budgets.json"
UPDATE_PAGE_LASTMOD="${GATE_UPDATE_PAGE_LASTMOD:-}"
PAGE_LASTMOD_PATH="data/page-lastmod.json"
REGENERATE_LLM_INDEX="${GATE_REGENERATE_LLM_INDEX:-}"
LLM_INDEX_PATH="artifacts/free-llm-api-index/README.md"

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

if [ -n "$REGENERATE_LLM_INDEX" ] && ! among_the_committable "$LLM_INDEX_PATH" "$@"; then
  echo "usage: GATE_REGENERATE_LLM_INDEX is set but $LLM_INDEX_PATH is not among the paths this run may commit ($*), so the index generated here would be left behind in the workspace." >&2
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
HELD_BACK_LIST="$(mktemp)"
export GATE_FAILING_FILES
export GITHUB_OUTPUT="$SUBPROCESS_OUTPUT"
trap 'rm -f "$LOG" "$VERDICT" "$GATE_FAILING_FILES" "$SUBPROCESS_OUTPUT" "$HELD_BACK_LIST"' EXIT

REPLAYS=0
REPLAYS_ONTO_A_MOVED_MAIN="${GATE_REPLAYS_ONTO_A_MOVED_MAIN:-2}"
HELD_BACK_VENDORS=""
BATCH_AS_THE_RUN_WROTE_IT=""
BATCH_COMMIT_AS_THE_RUN_WROTE_IT=""

push_to_main() {
  git push origin HEAD:main
}

replay_onto_main() {
  git fetch origin main || return 1
  if ! git rebase FETCH_HEAD; then
    git rebase --abort || true
    return 1
  fi
  COMMIT="$(git rev-parse --short HEAD)"
}

quarantine() {
  local why="$1"
  local refused="${BATCH_AS_THE_RUN_WROTE_IT:-$(git rev-parse HEAD)}"
  local shown="${BATCH_COMMIT_AS_THE_RUN_WROTE_IT:-$COMMIT}"
  local ref="${QUARANTINE_PREFIX}-$(date -u +%Y%m%dT%H%M%SZ)-${shown}"
  {
    echo "quarantined=true"
    echo "quarantine_ref=$ref"
    echo "quarantined_commit=$shown"
    echo "quarantine_reason=$why"
  } >>"$OUTPUT"
  if git push origin "$refused:refs/heads/$ref"; then
    echo "Held back because $why — $shown is on $ref and main is unchanged."
  else
    echo "Held back because $why — $shown could not be pushed to $ref and main is unchanged. This run's data exists only in its own workspace."
  fi
  exit 1
}

amend_with_what_the_derivation_moved() {
  if [ -n "$(git status --porcelain -- "${COMMITTABLE[@]}")" ]; then
    git add -- "${COMMITTABLE[@]}"
    git commit -q --amend --no-edit --allow-empty
    COMMIT="$(git rev-parse --short HEAD)"
    echo "$1"
  fi
}

derive_from_the_data() {
  if [ -n "$RATCHET_BUDGETS" ]; then
    echo "── Lowering any quality budget this run's data has earned ──"
    if ! npm run ratchet:budgets; then
      echo "The budgets could not be measured. That decides nothing about whether this run's data is right, so the data is held rather than discarded."
      quarantine "the quality budgets could not be measured"
    fi
    amend_with_what_the_derivation_moved "A budget fell to what this run's data measures, in the same commit as the data that earned it."
  fi

  if [ -n "$UPDATE_PAGE_LASTMOD" ]; then
    echo "── Reading every page this run renders, to date the ones whose output moved ──"
    if node "$SCRIPT_DIR/update-page-lastmod.js"; then
      amend_with_what_the_derivation_moved "The pages whose output this run moved are dated today, in the same commit as the data that moved them."
    else
      echo "The pages could not be read, so each one keeps the day it last changed. That says nothing about whether this run's data is right, so the data goes on to the suite."
    fi
  fi

  if [ -n "$REGENERATE_LLM_INDEX" ]; then
    echo "── Regenerating the AI and LLM free-tier index from the records this run moved ──"
    if node "$SCRIPT_DIR/generate-llm-api-readme.js"; then
      amend_with_what_the_derivation_moved "The published index reads this run's records, in the same commit as the records it reads."
    else
      echo "The index could not be generated, so the one already published stands rather than a new stale one. That says nothing about whether this run's data is right, so the data goes on to the suite, and the job that regenerates the index on every push to main fails loudly on its own."
    fi
  fi
}

hold_back_the_vendors_a_failing_test_named() {
  if [ -n "$HELD_BACK_VENDORS" ]; then
    echo "── A set of vendors has already been held back on this run and the suite is still red, so the batch stands or falls as one ──"
    return 1
  fi
  local baseline named
  baseline="$(git rev-parse HEAD^)" || return 1
  : >"$HELD_BACK_LIST"
  node "$SCRIPT_DIR/gate-hold-back-vendors.js" \
    --baseline "$baseline" --failures "$LOG" --vendors-to "$HELD_BACK_LIST" -- "${COMMITTABLE[@]}" || return 1
  named="$(tr '\n' ' ' <"$HELD_BACK_LIST" | sed 's/ *$//')"
  [ -n "$named" ] || return 1

  BATCH_AS_THE_RUN_WROTE_IT="$(git rev-parse HEAD)"
  BATCH_COMMIT_AS_THE_RUN_WROTE_IT="$COMMIT"
  HELD_BACK_VENDORS="$named"
  echo "── Held back: $HELD_BACK_VENDORS. What is left is derived again and read by the suite again, and only that reaches main ──"
  amend_with_what_the_derivation_moved "The vendors a failing test named read as main already has them, in this run's commit."
  derive_from_the_data
  return 0
}

summarize() {
  grep -E '(tests|pass|fail) [0-9]+$' "$LOG" | tail -3 || true
}

if ! npm run build >"$LOG" 2>&1; then
  tail -n 60 "$LOG"
  echo "The build failed, and no test-file allowance covers code that does not compile."
  quarantine "the build does not compile"
fi

derive_from_the_data

while :; do
  : >"$LOG"
  : >"$GATE_FAILING_FILES"

  if env -u GATE_RATCHET_BUDGETS -u GATE_UPDATE_PAGE_LASTMOD -u GATE_REGENERATE_LLM_INDEX npm run test:gated >>"$LOG" 2>&1; then
    summarize
    SUITE_WAS_RED=""
  else
    summarize
    if grep -q 'failing tests:' "$LOG"; then
      sed -n '/failing tests:/,$p' "$LOG"
    else
      tail -n 60 "$LOG"
    fi
    if ! node "$SCRIPT_DIR/gate-verdict.js" "$GATE_FAILING_FILES" >"$VERDICT" 2>&1; then
      cat "$VERDICT"
      if hold_back_the_vendors_a_failing_test_named; then continue; fi
      quarantine "the suite refused it"
    fi
    cat "$VERDICT"
    SUITE_WAS_RED="1"
  fi

  if push_to_main; then
    if [ -n "$HELD_BACK_VENDORS" ]; then
      echo "held_back_vendors=$HELD_BACK_VENDORS" >>"$OUTPUT"
      echo "Held back and left for the next run to read again: $HELD_BACK_VENDORS. Every other vendor this run read is on main."
    fi
    if [ -n "$SUITE_WAS_RED" ]; then
      {
        echo "quarantined=false"
        echo "pushed_over_failures=true"
        echo "non_blocking_files=$(tr '\n' ' ' <"$GATE_FAILING_FILES")"
      } >>"$OUTPUT"
      echo "Suite red — $COMMIT is on main anyway. Every failing file above measures how current our own reading is; none of them says this data is wrong."
    else
      echo "Suite green — $COMMIT is on main."
    fi
    exit 0
  fi

  REPLAYS="$((REPLAYS + 1))"
  if [ "$REPLAYS" -gt "$REPLAYS_ONTO_A_MOVED_MAIN" ]; then
    quarantine "main moved while the suite ran, more often than this run replays onto it"
  fi

  echo "── main moved while the suite ran. Replaying this run's commit onto it and running the suite again, so what reaches main is what the suite read ──"
  if ! replay_onto_main; then
    quarantine "main moved while the suite ran and this run's commit does not replay onto it"
  fi
  if ! npm run build >>"$LOG" 2>&1; then
    tail -n 60 "$LOG"
    quarantine "main moved while the suite ran and the tree it moved to does not compile with this run's commit on top"
  fi
done
