#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="$5"
  cp "$file" "$file.bak"
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(old) != 1:
    print(f"SKIP: pattern found {s.count(old)} times", file=sys.stderr)
    sys.exit(3)
p.write_text(s.replace(old, new))
PY
  then
    echo "SKIP  $name (pattern stale)"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi

  npm run build > /tmp/mut-build.log 2>&1
  if [ $? -ne 0 ]; then
    echo "SKIP  $name (build failed)"
    mv "$file.bak" "$file"
    npm run build > /dev/null 2>&1
    FAIL=$((FAIL + 1))
    return
  fi

  node --test $tests > /tmp/mut-test.log 2>&1
  local status=$?
  mv "$file.bak" "$file"
  npm run build > /dev/null 2>&1

  if [ $status -ne 0 ]; then
    echo "KILLED  $name"
    PASS=$((PASS + 1))
  else
    echo "SURVIVED  $name  <-- $tests did not notice"
    FAIL=$((FAIL + 1))
  fi
}

SWEEP="test/discovery-date-surfaces.test.ts"
STRUCT="test/change-structured-data.test.ts"
PROV="test/change-date-provenance.test.ts"
WRITER="test/change-log-writer.test.ts"

run_mutation "risk cause chip renders a bare date" src/serve.ts \
  'return `${changeDateLabel(cause)} ${changeTypeBadge' \
  'return `${cause.date} ${changeTypeBadge' "$SWEEP"

run_mutation "structured Event fabricates a start date" src/serve.ts \
  '    ...changeEventStartDate(c),' '    startDate: c.date,' "$SWEEP"

run_mutation "risk cause prose says the change happened on that day" src/serve.ts \
  "requires caution because of one specific recorded change\${riskCause ? \`, \${changeDateClause(riskCause)}" \
  "requires caution because of one specific recorded change\${riskCause ? \`, on \${riskCause.date}" "$SWEEP"

run_mutation "offer metadata dates itself from a discovery" src/serve.ts \
  '  const lastPricingChange = latestEventDate(vendorChanges);' \
  '  const lastPricingChange = vendorChanges.length > 0 ? vendorChanges[0].date : null;' "$SWEEP"

run_mutation "the report headline dates itself from a discovery" src/serve.ts \
  '  const latest = latestEventDate(changes, utcToday());' \
  '  const latest = changes.length > 0 ? changes.map((c) => c.date).sort().reverse()[0] : null;' "$SWEEP"

run_mutation "changes list drops entries with no effective date" src/serve.ts \
  '    itemListElement: newestFirst.slice(0, 50).map((c, i) => ({' \
  '    itemListElement: sorted.slice(0, 50).map((c, i) => ({' "$STRUCT"

run_mutation "changes list appends discoveries after the cap" src/serve.ts \
  '  const newestFirst = [...allChanges].sort((a, b) => b.date.localeCompare(a.date));' \
  '  const newestFirst = [...eventDated, ...undatedChanges];' "$STRUCT"

run_mutation "expiring list drops entries with no effective date" src/serve.ts \
  '    itemListElement: [...upcoming, ...recentlyDiscovered].slice(0, 50).map((c, i) => ({' \
  '    itemListElement: upcoming.slice(0, 50).map((c, i) => ({' "$STRUCT"

run_mutation "expiring total omits what it could not date" src/serve.ts \
  '    numberOfItems: totalUpcoming + recent.length + recentlyDiscovered.length,' \
  '    numberOfItems: totalUpcoming + recent.length,' "$STRUCT"

run_mutation "structured data publishes a discovery date" src/change-dates.ts \
  'export function changeDatePublished(c: DatedChange): { datePublished: string } | Record<string, never> {
  return isEventDated(c) ? { datePublished: c.date } : {};
}' \
  'export function changeDatePublished(c: DatedChange): { datePublished: string } | Record<string, never> {
  return { datePublished: c.date };
}' "$STRUCT $PROV"

run_mutation "the schedule reader answers on an unexpanded argument" scripts/check-change-log-staleness.js \
  '  const unresolved = invocations.flat().filter((token) => token.expands);' \
  '  const unresolved = [];' "$WRITER"

run_mutation "an option value is treated as a possible flag" scripts/check-change-log-staleness.js \
  '    if (DETECTOR_CLI_OPTIONS.takesValue.includes(token.text)) consumingValue = true;' \
  '    if (false) consumingValue = true;' "$WRITER"

run_mutation "the reader stops honouring quotes around an expansion" scripts/check-change-log-staleness.js \
  '        if (argText[j] === "$") expands = true;' \
  '        if (false) expands = true;' "$WRITER"

run_mutation "a declared exemption stops being checked for use" test/discovery-date-surfaces.test.ts \
  '    name: "a page or dataset modification date",
    allows: (before) => /"dateModified":"$/.test(before),' \
  '    name: "a page or dataset modification date",
    allows: (before) => /"neverEmittedAnywhere":"$/.test(before),' "$SWEEP"

run_mutation "the risk cause is projected without its provenance" src/data.ts \
  '      ? { date: assessment.cause.date, date_source: assessment.cause.date_source, change_type: assessment.cause.change_type, summary: assessment.cause.summary }' \
  '      ? { date: assessment.cause.date, change_type: assessment.cause.change_type, summary: assessment.cause.summary }' "$SWEEP"

echo
echo "killed: $PASS   survived-or-skipped: $FAIL"
