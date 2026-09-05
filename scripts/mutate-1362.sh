#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

SERVE=src/serve.ts
SPEC=test/model-lineup-currency.test.ts
BACKUP_DIR=$(mktemp -d)
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$SPEC" "$BACKUP_DIR/spec.ts"

restore() {
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/spec.ts" "$SPEC"
  npm run build >/dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
skipped=0

mutate() {
  local label="$1" file="$2" from="$3" to="$4"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/spec.ts" "$SPEC"
  if ! FROM="$from" TO="$to" FILE="$file" node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.env.FILE, "utf8");
    const at = text.indexOf(process.env.FROM);
    if (at < 0) process.exit(3);
    fs.writeFileSync(process.env.FILE, text.slice(0, at) + process.env.TO + text.slice(at + process.env.FROM.length));
  '; then
    echo "SKIP      $label — target not present"
    skipped=$((skipped + 1))
    return
  fi
  if npm run build >/dev/null 2>&1 && node --test --test-concurrency 1 "$SPEC" >/dev/null 2>&1; then
    echo "SURVIVED  $label"
    survived=$((survived + 1))
  else
    echo "killed    $label"
    killed=$((killed + 1))
  fi
}

mutate "date lookback narrowed to 40 characters" "$SPEC" \
  "const DATE_LOOKBACK = 320;" "const DATE_LOOKBACK = 40;"
mutate "date lookback widened to 4000 characters" "$SPEC" \
  "const DATE_LOOKBACK = 320;" "const DATE_LOOKBACK = 4000;"
mutate "ISO dates no longer count as a stated date" "$SPEC" \
  'const DATE_STATED = /\d{4}-\d{2}-\d{2}|\b(' 'const DATE_STATED = /\b('
mutate "unread-row count no longer subtracts the rows that were read" "$SPEC" \
  "priced.length - FRONTIER.size," "priced.length,"
mutate "supersession sweep reads rendered text only" "$SPEC" \
  'for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) parts.push(m[1]);' \
  ""

mutate "read date frozen a year early" "$SERVE" \
  'const FRONTIER_PRICES_READ_ON = "2026-09-05";' 'const FRONTIER_PRICES_READ_ON = "2025-09-05";'
mutate "read line replaced by a frozen sentence" "$SERVE" \
  "escHtmlServer(frontierReadLine)" "escHtmlServer('All prices verified as of September 2026.')"
mutate "unread rows counted as the whole table" "$SERVE" \
  "const rowsWithNoReadDate = providers.length - frontierReads.length;" "const rowsWithNoReadDate = providers.length;"
mutate "read hosts dropped from the line" "$SERVE" \
  'frontierReads.map(p => p.name + " (" + p.readFrom + ")").join(", ")' \
  'frontierReads.map(p => p.name).join(", ")'
mutate "Anthropic flagship reverted" "$SERVE" \
  'flagshipModel: "Claude Fable 5.1",' 'flagshipModel: "Claude Opus 4.6",'
mutate "OpenAI flagship reverted" "$SERVE" \
  'flagshipModel: "GPT-6 Astra",' 'flagshipModel: "GPT-4o",'
mutate "Mistral flagship reverted" "$SERVE" \
  'flagshipModel: "Mistral Medium 3.5",' 'flagshipModel: "Mistral Large",'
mutate "Gemini flagship reverted" "$SERVE" \
  'flagshipModel: "Gemini 3.8 Flash",' 'flagshipModel: "Gemini 2.5 Pro",'
mutate "Haiku price reverted to the retired one" "$SERVE" \
  'Haiku 4.5: $1/$5 per MTok.' 'Haiku 4.5: $0.80/$4 per MTok.'
mutate "Sonnet price left on the superseded generation" "$SERVE" \
  'Sonnet 5: $2/$10 per MTok.' 'Sonnet 5: $3/$15 per MTok.'

echo
echo "killed $killed, survived $survived, skipped $skipped"
[ "$survived" -eq 0 ] && [ "$skipped" -eq 0 ]
