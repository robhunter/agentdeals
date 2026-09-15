#!/usr/bin/env bash
set -u

SNAP=$(mktemp -d)
cp src/retirement.ts "$SNAP/retirement.ts"
cp test/ended-terms.test.ts "$SNAP/ended-terms.test.ts"

restore() {
  cp "$SNAP/retirement.ts" src/retirement.ts
  cp "$SNAP/ended-terms.test.ts" test/ended-terms.test.ts
}
trap 'restore; npm run build >/dev/null 2>&1; echo; echo "--- git status at exit ---"; git status --short' EXIT

arm() {
  local name="$1"; shift
  restore
  "$@"
  if ! npm run build >/dev/null 2>&1; then
    echo "BUILD-FAIL  $name"
    return
  fi
  if node --test test/ended-terms.test.ts >/tmp/arm-1674.log 2>&1; then
    echo "STILL GREEN $name  <-- the arm is not load bearing"
  else
    echo "RED         $name"
    grep -E '^ *✖' /tmp/arm-1674.log | sed 's/^/              /' | head -4
  fi
}

quote_the_tier_raw() {
  perl -0pi -e 's/const named = RETIRED_TIER\.exec\(tier\)\?\.\[1\];/const named = tier;/' src/retirement.ts
}

fixed_word_for_every_record() {
  perl -0pi -e 's/const named = RETIRED_TIER\.exec\(tier\)\?\.\[1\];/const named = "retired";/' src/retirement.ts
}

sweep_skips_a_route() {
  perl -0pi -e 's/for \(const p of listed\) \{\n      const res = await fetch\(base \+ p\);/for (const p of [...listed].slice(1)) {\n      const res = await fetch(base + p);/' test/ended-terms.test.ts
}

sweep_keeps_only_a_route_that_renders_200() {
  perl -0pi -e 's/if \(res\.status === 200\) rendered\.set\(p, await res\.text\(\)\);/if (res.status === 200 \&\& p !== "\/free-llm-apis") rendered.set(p, await res.text());/' test/ended-terms.test.ts
}

arm "the note quotes the tier string raw"            quote_the_tier_raw
arm "the note states one fixed word for every record" fixed_word_for_every_record
arm "the sweep leaves one listed route unfetched"     sweep_skips_a_route
arm "the sweep drops one route it did fetch"          sweep_keeps_only_a_route_that_renders_200
