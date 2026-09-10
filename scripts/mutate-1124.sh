#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

RENDERED=scripts/rendered-page.js
FRESHNESS=scripts/verify-freshness.js
NAMING=scripts/vendor-naming.js
SUITE=(test/rendered-short-pages.test.ts test/short-page-floor.test.ts test/typed-price-read.test.ts test/whole-page-read.test.ts)

cp "$RENDERED" /tmp/mutate-1124-rendered.orig
cp "$FRESHNESS" /tmp/mutate-1124-freshness.orig
cp "$NAMING" /tmp/mutate-1124-naming.orig

restore() {
  cp /tmp/mutate-1124-rendered.orig "$RENDERED"
  cp /tmp/mutate-1124-freshness.orig "$FRESHNESS"
  cp /tmp/mutate-1124-naming.orig "$NAMING"
}
trap restore EXIT

killed=0
survived=0

mutate() {
  local name="$1" file="$2" from="$3" to="$4"
  restore
  FILE="$file" FROM="$from" TO="$to" python3 - <<'PY'
import os, pathlib
path = pathlib.Path(os.environ["FILE"])
source = path.read_text()
frm, to = os.environ["FROM"], os.environ["TO"]
assert source.count(frm) == 1, f"{path}: {source.count(frm)} occurrences of {frm!r}"
path.write_text(source.replace(frm, to))
PY
  if [ $? -ne 0 ]; then
    echo "SKIPPED (no such text): $name"
    return
  fi
  if TZ=UTC npx node --test "${SUITE[@]}" >/tmp/mutate-1124-run.log 2>&1; then
    echo "SURVIVED: $name"
    survived=$((survived + 1))
  else
    echo "killed:   $name"
    killed=$((killed + 1))
  fi
}

mutate "escalate on any failed read, not only a short one" \
  "$FRESHNESS" "if (!tooShortToRead(read)) return read;" "if (read.ok) return read;"

mutate "treat any refusal as too short" \
  "$FRESHNESS" 'return page?.ok === false && page.error === PAGE_TOO_SHORT_ERROR;' 'return page?.ok === false;'

mutate "claim a rendering client ran when none is installed" \
  "$FRESHNESS" "if (rendered.error === NO_RENDERING_CLIENT) return short;" "if (false) return short;"

mutate "accept a rendered page of any length" \
  "$FRESHNESS" "if (text.length < (options.minLength ?? MIN_PAGE_TEXT_LENGTH)) {" "if (false) {"

mutate "drop the length the fetcher read before rendering" \
  "$FRESHNESS" "chars_before_rendering: short.chars," "chars_before_rendering: undefined,"

mutate "leave no rendering marker on the record" \
  "$NAMING" 'if (page?.read === READ_BY_RENDERING) record.rendered = true;' 'if (false) record.rendered = true;'

mutate "let rendering clients run in parallel" \
  "$RENDERED" "oneAtATime = queued.then(" "oneAtATime = Promise.resolve().then("

mutate "ask for the loaded page instead of the rendered DOM" \
  "$RENDERED" '"--dump-dom",' '"--incognito",'

mutate "ignore the arguments the environment asks for" \
  "$RENDERED" "return String(env[RENDERER_ARGS_ENV] ?? \"\").split(/\\s+/).filter(Boolean);" "return [];"

mutate "render without bounding how long a page may load" \
  "$RENDERED" '`--virtual-time-budget=${options.virtualTimeBudgetMs ?? VIRTUAL_TIME_BUDGET_MS}`,' '"--disable-logging",'

mutate "guess at a rendering client when none is on the path" \
  "$RENDERED" "return rendererCandidates(env).find(isExecutable) ?? null;" "return rendererCandidates(env)[0] ?? null;"

echo ""
echo "$killed killed, $survived survived"
[ "$survived" -eq 0 ]
