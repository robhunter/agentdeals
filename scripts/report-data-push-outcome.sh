#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: report-data-push-outcome.sh <job-name> refused|reached-main|shipped-over-failures|held-back-a-vendor|drifted-a-guard [detail] [reason]" >&2
  exit 2
fi

JOB="$1"
OUTCOME="$2"
DETAIL="${3:-}"
REASON="${4:-the suite refused it}"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
REPO="${GITHUB_REPOSITORY:-robhunter/agentdeals}"
RUN_URL="$SERVER/$REPO/actions/runs/${GITHUB_RUN_ID:-unknown}"
OPENED_BY_THE_SYSTEM="app/github-actions"

JOB_SLUG="$(printf '%s' "$JOB" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/--*/-/g; s/^-//; s/-$//')"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
SCOPE=""

commit_subject_of_the_job() {
  case "$1" in
    "Daily rolling re-verification") echo "data(auto): rolling re-verification" ;;
    "Link liveness") echo "data(auto): link liveness" ;;
    "Page dates") echo "data(auto): page dates" ;;
    "Analytics rollup") echo "data(auto): analytics rollup" ;;
    "AI and LLM index") echo "data(auto): AI and LLM free-tier index" ;;
    *) echo "" ;;
  esac
}

history_main_is_visible_on() {
  local ref
  for ref in FETCH_HEAD origin/main; do
    if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
      echo "$ref"
      return 0
    fi
  done
  echo ""
}

LAST_REACHED_MAIN_AT=""
LAST_REACHED_MAIN_SHA=""
HOURS_SINCE_THIS_JOB_LAST_REACHED_MAIN=""

measure_how_long_this_job_has_been_frozen() {
  local subject ref found
  subject="$(commit_subject_of_the_job "$JOB")"
  [ -n "$subject" ] || return 0
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" = "true" ]; then
    git fetch --shallow-since="30 days ago" origin main >/dev/null 2>&1 || true
  fi
  ref="$(history_main_is_visible_on)"
  [ -n "$ref" ] || return 0
  found="$(git log "$ref" --fixed-strings --grep="$subject" -1 --format='%H %cI' 2>/dev/null || true)"
  [ -n "$found" ] || return 0
  LAST_REACHED_MAIN_SHA="${found%% *}"
  LAST_REACHED_MAIN_AT="${found##* }"
  HOURS_SINCE_THIS_JOB_LAST_REACHED_MAIN="$(
    awk -v then="$(date -u -d "$LAST_REACHED_MAIN_AT" +%s 2>/dev/null || echo 0)" -v now="$(date -u +%s)" \
      'BEGIN { if (then == 0) exit 1; printf "%.1f", (now - then) / 3600 }'
  )" || HOURS_SINCE_THIS_JOB_LAST_REACHED_MAIN=""
}

say_how_long_the_catalogue_has_been_frozen() {
  local subject
  subject="$(commit_subject_of_the_job "$JOB")"
  if [ -n "$HOURS_SINCE_THIS_JOB_LAST_REACHED_MAIN" ]; then
    echo "Frozen for **${HOURS_SINCE_THIS_JOB_LAST_REACHED_MAIN} hours**: the last \`$subject\` commit to reach \`main\` is [\`$(printf '%.7s' "$LAST_REACHED_MAIN_SHA")\`]($SERVER/$REPO/commit/$LAST_REACHED_MAIN_SHA), $LAST_REACHED_MAIN_AT. Everything this job writes has said the same thing since then."
  elif [ -n "$subject" ]; then
    echo "How long this has been frozen cannot be stated here: no \`$subject\` commit is in the history this run can see."
  else
    echo "How long this has been frozen cannot be stated here: this job's commits are not ones this script knows how to find on \`main\`."
  fi
}

the_open_alarm_carrying() {
  gh issue list --state open --limit 200 --json number,body,author \
    --jq "[.[] | select(.author.login == \"$OPENED_BY_THE_SYSTEM\") | select(.body | contains(\"<!-- $1 -->\"))] | sort_by(.number) | .[0].number // empty"
}

how_many_open_alarms_name_a_job() {
  gh issue list --state open --limit 200 --json number,body,author \
    --jq "[.[] | select(.author.login == \"$OPENED_BY_THE_SYSTEM\") | select(.body | test(\"<!-- data-push-refused:[a-z0-9-]+ -->\"))] | length"
}

case "$OUTCOME" in
  refused)
    MARKER="data-push-refused"
    SCOPE="$JOB_SLUG"
    TITLE="$JOB was refused — the part of the catalogue it writes is not advancing"
    LABEL="priority/high"
    COMMENT_EVERY_TIME="yes"
    measure_how_long_this_job_has_been_frozen
    {
      echo "\`$JOB\` produced data that did not reach \`main\`, because $REASON. The catalogue did not advance."
      echo
      say_how_long_the_catalogue_has_been_frozen
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
      echo
      echo "This issue is \`$JOB\` and nothing else. It closes itself the next time that job reaches \`main\`, so while it is open the job is frozen, and every other scheduled job has an alarm of its own."
    } >"$BODY"
    ;;
  reached-main)
    CLEARS_MARKER="data-push-refused"
    FROZEN_ALARM="$(the_open_alarm_carrying "$CLEARS_MARKER:$JOB_SLUG")"
    if [ -n "$FROZEN_ALARM" ]; then
      {
        if [ -n "$DETAIL" ]; then
          echo "Cleared. \`$JOB\` reached \`main\` at [\`$DETAIL\`]($SERVER/$REPO/commit/$DETAIL)."
        else
          echo "Cleared. \`$JOB\` ran to the end without holding anything back. It had no change to commit, so there is no commit to name — what it read agrees with what \`main\` already has."
        fi
        echo
        echo "The run: $RUN_URL"
        echo
        echo "Closing this, because while it was open it said this job was frozen and it is not. The next refusal of \`$JOB\` opens a new one, so each freeze is one issue with one beginning and one end."
        echo
        echo "<!-- $CLEARS_MARKER:$JOB_SLUG -->"
      } >"$BODY"
      gh issue comment "$FROZEN_ALARM" --body-file "$BODY"
      gh issue close "$FROZEN_ALARM"
      echo "Closed issue #$FROZEN_ALARM — $JOB is advancing again."
    fi
    NAMES_NO_JOB="$(the_open_alarm_carrying "$CLEARS_MARKER")"
    if [ -n "$NAMES_NO_JOB" ]; then
      if [ "$(how_many_open_alarms_name_a_job)" = "0" ]; then
        {
          echo "Closing this, because it names no job and no job is refused. \`$JOB\` reached \`main\`${DETAIL:+ at [\`$DETAIL\`]($SERVER/$REPO/commit/$DETAIL)}, and no scheduled data job has an open alarm of its own."
          echo
          echo "The run: $RUN_URL"
          echo
          echo "A refusal alarm now belongs to one job and closes when that job next reaches \`main\`. This one was shared, which is why it could be open on a day the catalogue advanced and say nothing by being open."
          echo
          echo "<!-- $CLEARS_MARKER -->"
        } >"$BODY"
        gh issue comment "$NAMES_NO_JOB" --body-file "$BODY"
        gh issue close "$NAMES_NO_JOB"
        echo "Closed issue #$NAMES_NO_JOB — it named no job and no job is refused."
      fi
    fi
    exit 0
    ;;
  shipped-over-failures)
    MARKER="data-push-over-failures"
    TITLE="main is red on a test that does not gate the data, and the data shipped anyway"
    LABEL="priority/medium"
    COMMENT_EVERY_TIME="yes"
    {
      echo "\`$JOB\` met a red suite, and no failing file is named in \`scripts/gate-blocking-tests.json\`. None of them says a record this run produced is wrong, so none of them held the commit. The data is on \`main\`."
      echo
      echo "The files that were red: \`${DETAIL:-none recorded}\`"
      echo
      echo "The run: $RUN_URL"
      echo
      echo "\`main\` is red until somebody clears these. Nothing is blocked, which is why this needs saying out loud: a scheduled push carries no \`tests.yml\` run behind it, so this is the only place the redness shows. Every run that ships over a red suite comments here, so a day with no comment is a day this did not happen."
      echo
      echo "What to do: read the run, and decide for each file which it is. A test that is red because the catalogue moved and it named a fixed subject is the test to fix. A test that is red because a record is wrong belongs in \`scripts/gate-blocking-tests.json\`, and adding it there is what makes it hold the next push."
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

SIGNATURE="$MARKER${SCOPE:+:$SCOPE}"

{
  echo
  echo "<!-- $SIGNATURE -->"
} >>"$BODY"

EXISTING="$(the_open_alarm_carrying "$SIGNATURE")"
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
