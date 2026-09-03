#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: gate-data-push.sh <quarantine-branch> <commit-message> <path>..." >&2
  exit 2
fi

QUARANTINE_BRANCH="$1"
MESSAGE="$2"
shift 2

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
trap 'rm -f "$LOG"' EXIT

if npm run build >"$LOG" 2>&1 && npm test >>"$LOG" 2>&1; then
  grep -E '(tests|pass|fail) [0-9]+$' "$LOG" | tail -3 || true
  git push origin HEAD:main
  echo "Suite green — $COMMIT is on main."
  exit 0
fi

grep -E '(tests|pass|fail) [0-9]+$' "$LOG" | tail -3 || true
if grep -q 'failing tests:' "$LOG"; then
  sed -n '/failing tests:/,$p' "$LOG"
else
  tail -n 60 "$LOG"
fi

git push --force origin "HEAD:refs/heads/$QUARANTINE_BRANCH"
echo "Suite red — $COMMIT is held on $QUARANTINE_BRANCH and main is unchanged."
exit 1
