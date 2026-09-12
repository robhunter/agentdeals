#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: report-data-push-outcome.sh <job-name> refused|shipped-over-failures|held-back-a-vendor|drifted-a-guard [detail] [reason]" >&2
  exit 2
fi

JOB="$1"
OUTCOME="$2"
DETAIL="${3:-}"
REASON="${4:-the suite refused it}"
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
      echo "\`$JOB\` produced data that did not reach \`main\`, because $REASON. The catalogue did not advance."
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
      echo "What to do: read the run for what went red, fix it on \`main\`, then merge the quarantined data or let the next scheduled run redo it."
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
  held-back-a-vendor)
    MARKER="data-push-vendorholdback"
    TITLE="A scheduled run keeps reading a vendor the suite will not publish"
    LABEL="priority/medium"
    COMMENT_EVERY_TIME="yes"
    {
      echo "\`$JOB\` produced data the suite would not pass, and the failing tests named \`${DETAIL:-nobody}\`. Those vendors are on \`main\` the way it already had them, and everything else the run read is on \`main\` too. The catalogue advanced."
      echo
      echo "This is the good outcome of a bad reading: one vendor costs one vendor rather than the batch it arrived in. It still says that a reading we take every time that vendor is drawn is one the suite will not publish, so the same holdback repeats until either the reading or the rule behind it changes."
      echo
      echo "The run: $RUN_URL"
      echo
      echo "What to do: read the run for what went red on \`${DETAIL:-that vendor}\`, and decide which of the two is wrong."
    } >"$BODY"
    ;;
  drifted-a-guard)
    MARKER="data-push-drifted-guard"
    TITLE="A population floor has drifted into its own headroom — the data shipped and the guard needs recalibrating"
    LABEL="priority/medium"
    COMMENT_EVERY_TIME="yes"
    {
      echo "\`$JOB\` met a red suite whose failures name no record and no vendor. Each one states that a floor sits inside the quarter below the population it measures, which is a statement about how a test is calibrated rather than about the catalogue. The data is on \`main\`."
      echo
      echo "${DETAIL:-No table reached this issue, which is itself worth reading the run for.}"
      echo
      echo "The run: $RUN_URL"
      echo
      echo "A floor this close to its population goes red when the data shrinks and stays green when the data is wrong, so it guards nothing and holds everything. Some of these populations are ones the re-verification run exists to shrink, which is why they drift on a run that did its job."
      echo
      echo "What to do: lower each floor to at most the value in the \`clears at\` column, or state the property as a share of the population it was filtered from with \`assertSharesPopulation\`. \`npm run floors\` prints every floor's margin from a run with \`POPULATION_FLOOR_LOG\` set."
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
