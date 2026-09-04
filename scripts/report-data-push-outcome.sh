#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: report-data-push-outcome.sh <job-name> refused|shipped-over-failures [detail]" >&2
  exit 2
fi

JOB="$1"
OUTCOME="$2"
DETAIL="${3:-}"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPO="${GITHUB_REPOSITORY:-robhunter/agentdeals}"
RUN_URL="$SERVER/$REPO/actions/runs/${GITHUB_RUN_ID:-unknown}"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

case "$OUTCOME" in
  refused)
    MARKER="data-push-refused"
    TITLE="A scheduled data push was refused — the catalogue is not advancing"
    LABEL="priority/high"
    COMMENT_EVERY_TIME="yes"
    {
      echo "\`$JOB\` produced data the suite refused, so \`main\` did not move and the catalogue did not advance."
      echo
      if [ -n "$DETAIL" ]; then
        echo "The refused commit is held on [\`$DETAIL\`]($SERVER/$REPO/tree/$DETAIL). Each refusal gets its own ref, so this one is not overwritten by the next."
      else
        echo "The refused commit could not be pushed anywhere. This run's data exists only in the run's workspace and goes when it expires."
      fi
      echo
      echo "The run: $RUN_URL"
      echo
      echo "Until this clears, the queue does not advance: the next run picks the same entries, finds the same things, and is refused again."
      echo
      echo "What to do: read the failing tests in the run, fix them on \`main\`, then merge the quarantined data or let the next scheduled run redo it."
    } >"$BODY"
    ;;
  shipped-over-failures)
    MARKER="data-push-over-failures"
    TITLE="main is red on a test that measures our own reading, and the data shipped anyway"
    LABEL="priority/medium"
    COMMENT_EVERY_TIME="no"
    {
      echo "\`$JOB\` met a red suite, and every failing file was one whose failures do not hold a data commit — they measure how current our own editorial reading is, not whether the catalogue is right. The data is on \`main\`."
      echo
      echo "The files that were red: \`${DETAIL:-none recorded}\`"
      echo
      echo "The run: $RUN_URL"
      echo
      echo "\`main\` is red until somebody clears these. Nothing is blocked, which is why this needs saying out loud: a scheduled push carries no \`tests.yml\` run behind it, so this is the only place the redness shows."
      echo
      echo "What to do: clear the entries that put the measurement over its budget, then \`npm run ratchet:budgets\`."
    } >"$BODY"
    ;;
  *)
    echo "Unknown outcome: $OUTCOME" >&2
    exit 2
    ;;
esac

{
  echo
  echo "<!-- $MARKER -->"
} >>"$BODY"

EXISTING="$(gh issue list --state open --search "$MARKER in:body" --json number --jq '.[0].number // empty')"
if [ -n "$EXISTING" ]; then
  if [ "$COMMENT_EVERY_TIME" = "yes" ]; then
    gh issue comment "$EXISTING" --body-file "$BODY"
    echo "Reported on issue #$EXISTING."
  else
    echo "Already signalled by issue #$EXISTING — not opening or commenting on another."
  fi
  exit 0
fi

gh issue create --title "$TITLE" --label "$LABEL" --label "type: bug" --body-file "$BODY"
