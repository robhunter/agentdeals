#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
SUITE="test/azure-assistants-retirement.test.ts"

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="${5:-$SUITE}"
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

  if ! npm run build > /tmp/mut-1089-build.log 2>&1; then
    echo "SKIP  $name (build failed)"
    mv "$file.bak" "$file"
    npm run build > /dev/null 2>&1
    FAIL=$((FAIL + 1))
    return
  fi

  node --test --experimental-strip-types $tests > /tmp/mut-1089.log 2>&1
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

run_mutation "the structured FAQ answer goes back to promising Azure kept the API" src/serve.ts \
  'a: `No. Microsoft retired the Azure OpenAI Assistants API on ${ASSISTANTS_API_SHUTDOWN.date}, the same date OpenAI retired its own. Microsoft'"'"'s documentation states that the Assistants API is retired and directs Azure workloads to ${ASSISTANTS_API_SHUTDOWN.azureSuccessor}, which is generally available; inference-only workloads can use the ${ASSISTANTS_API_SHUTDOWN.azureInferenceApi} instead. Running on Azure does not extend the deadline.`' \
  'a: "Azure OpenAI has NOT announced deprecation of its Assistants API implementation. Azure may maintain the Assistants API independently of OpenAI'"'"'s decision."'

run_mutation "the free-tier table cell goes back to calling the Azure API live" src/serve.ts \
  "<td style=\"font-size:.85rem\">' + escHtmlServer(ASSISTANTS_API_SHUTDOWN.azureSuccessor) + ' — Assistants API retired ' + escHtmlServer(ASSISTANTS_API_SHUTDOWN.date) + '</td>" \
  "<td style=\"font-size:.85rem\">Assistants API (not deprecated)</td>"

run_mutation "the recommendation goes back to hedging the Azure deprecation" src/serve.ts \
  "Rebuild on ' + escHtmlServer(ASSISTANTS_API_SHUTDOWN.azureSuccessor) + ': Microsoft retired the Azure Assistants API on ' + escHtmlServer(ASSISTANTS_API_SHUTDOWN.date) + ' too, so this path is a change of platform, not a way to keep the old API." \
  "Assistants API may not be deprecated on Azure."

run_mutation "the cost insight goes back to telling Azure teams to wait" src/serve.ts \
  "Teams already on Azure face the same deadline: Microsoft retired the Azure OpenAI Assistants API on ' + ASSISTANTS_API_SHUTDOWN.date + ' and directs agents to ' + ASSISTANTS_API_SHUTDOWN.azureSuccessor + '." \
  "For teams already on Azure, the Assistants API may continue working \\u2014 monitor Azure announcements."

run_mutation "one page is corrected to a different retirement date" src/serve.ts \
  'Microsoft retired the Azure OpenAI Assistants API on ${ASSISTANTS_API_SHUTDOWN.date} too and directs Azure agents to ${ASSISTANTS_API_SHUTDOWN.azureSuccessor}.' \
  'Microsoft retired the Azure OpenAI Assistants API on March 31, 2027 too and directs Azure agents to ${ASSISTANTS_API_SHUTDOWN.azureSuccessor}.'

run_mutation "one page stops naming the successor" src/serve.ts \
  'Move agents to ${ASSISTANTS_API_SHUTDOWN.azureSuccessor}; the ' \
  'The '

run_mutation "the alternatives page drops its Azure retirement statement" src/serve.ts \
  'Microsoft retired the Azure OpenAI Assistants API on ${ASSISTANTS_API_SHUTDOWN.date} as well, so an Azure deployment does not extend the deadline. ' \
  ''

run_mutation "the shared date is edited and one page is not carried with it" src/assistants-shutdown.ts \
  '  date: "August 26, 2026",' \
  '  date: "August 27, 2026",'

run_mutation "the survival detector stops looking for the hedged wording" src/assistants-shutdown.ts \
  '  /may\s+not\s+be\s+deprecated/gi,
  /may\s+continue\s+(?:working|to\s+work)/gi,
' \
  ''

run_mutation "the detector stops requiring the claim to be about this shutdown" src/assistants-shutdown.ts \
  '      if (!SHUTDOWN_SUBJECT.test(window)) continue;' \
  '      if (SHUTDOWN_SUBJECT.test(window)) continue;'

echo
echo "killed: $PASS   survived/skipped: $FAIL"
[ $FAIL -eq 0 ]
