#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: signal-detector-absence.sh <marker>" >&2
  echo "  Opens one issue saying no change detector is scheduled, and not a second one." >&2
  exit 2
fi

MARKER="$1"
TITLE="No change detector is scheduled — the daily job cannot notice a pricing change"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

node scripts/detector-absence-issue-body.js "$MARKER" >"$BODY"

if ! grep -qF "<!-- $MARKER -->" "$BODY"; then
  echo "The body carries no <!-- $MARKER --> marker, so the next run could not find the issue it opened." >&2
  exit 2
fi

EXISTING="$(gh issue list --state open --limit 200 --json number,body \
  --jq "[.[] | select(.body | contains(\"<!-- $MARKER -->\"))] | sort_by(.number) | .[0].number // empty")"

if [ -n "$EXISTING" ]; then
  echo "Absence already signalled by issue #$EXISTING — not opening another."
  exit 0
fi

gh issue create --title "$TITLE" --label "priority/high" --label "type: bug" --body-file "$BODY"
