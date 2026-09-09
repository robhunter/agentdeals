#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: report-quality-budgets.sh <body-file> true|false" >&2
  echo "  The second argument says whether any budget is over its ceiling." >&2
  exit 2
fi

BODY="$1"
OVER="$2"
MARKER="quality-budget-report"
TITLE="A quality budget is over its ceiling"

case "$OVER" in
  true|false) ;;
  *) echo "The second argument is $OVER; it says whether a budget is over ceiling and must be true or false." >&2; exit 2 ;;
esac

if [ ! -s "$BODY" ]; then
  echo "No body at $BODY, so there is nothing to report." >&2
  exit 2
fi

if ! grep -qF "<!-- $MARKER -->" "$BODY"; then
  echo "The body at $BODY carries no $MARKER marker, so the next run could not find the issue it opened." >&2
  exit 2
fi

EXISTING="$(gh issue list --state open --limit 200 --json number,body \
  --jq "[.[] | select(.body | contains(\"<!-- $MARKER -->\"))] | .[0].number // empty")"

if [ -n "$EXISTING" ]; then
  gh issue edit "$EXISTING" --body-file "$BODY"
  echo "Updated issue #$EXISTING with today's measurement."
  exit 0
fi

if [ "$OVER" = "false" ]; then
  echo "Every budget is at or under its ceiling and no issue is open, so there is nothing to open one about."
  exit 0
fi

gh issue create --title "$TITLE" --label "priority/medium" --label "type: chore" --body-file "$BODY"
