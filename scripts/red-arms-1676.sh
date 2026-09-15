#!/usr/bin/env bash
set -u

SNAP=$(mktemp -d)
for f in src/vendor-substitution.ts src/vendor-slug.ts src/data.ts src/retirement.ts src/serve.ts src/server.ts; do
  cp "$f" "$SNAP/$(basename "$f")"
done

restore() {
  for f in src/vendor-substitution.ts src/vendor-slug.ts src/data.ts src/retirement.ts src/serve.ts src/server.ts; do
    cp "$SNAP/$(basename "$f")" "$f"
  done
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
  if node --test test/ended-name-substitution.test.ts >/tmp/arm-1676.log 2>&1; then
    echo "STILL GREEN $name  <-- the arm is not load bearing"
  else
    echo "RED         $name"
    grep -E '^ *✖' /tmp/arm-1676.log | sed 's/^/              /' | head -4
  fi
}

ended_candidates_answer_again() {
  perl -0pi -e 's/const stillOffered = candidates\.filter\(s => !universe\.hasEnded\(s\)\);/const stillOffered = candidates.filter(() => true);/' src/vendor-substitution.ts
}

nothing_counts_as_ended() {
  perl -0pi -e 's/hasEnded: slug => endedVendorSlugs\.has\(slug\),/hasEnded: () => false,/' src/vendor-slug.ts
}

find_vendor_substitutes_an_ended_record() {
  perl -0pi -e 's/if \(theOnlyMatch && !offerRetired\(theOnlyMatch\)\) return \{ type: "inferred", offer: theOnlyMatch \};/if (theOnlyMatch) return { type: "inferred", offer: theOnlyMatch };/' src/data.ts
}

refusal_stops_naming_what_we_hold() {
  perl -0pi -e 's/if \(candidates\.length > 0\) return \{ type: "onlyMatchHasEnded", slugs: \[\.\.\.candidates\]\.sort\(\) \};/if (candidates.length > 0) return { type: "none" };/' src/vendor-substitution.ts
}

vendor_page_stops_naming_the_record() {
  perl -0pi -e 's/res\.end\(endedNamesRefusalPage\(slug, resolution\.slugs, "\/vendor", "\/vendor", `Browse all \$\{vendorSlugMap\.size\} vendors`\)\);/res.end("<!DOCTYPE html><html><body><h1>404<\/h1><\/body><\/html>");/' src/serve.ts
}

alternatives_page_stops_refusing() {
  perl -0pi -e 's/res\.end\(endedNamesRefusalPage\(slug, resolution\.slugs, "\/alternative-to", "\/alternative-to", "Browse all alternatives"\)\);/res.end("<!DOCTYPE html><html><body><h1>404<\/h1><\/body><\/html>");/' src/serve.ts
}

details_door_stops_refusing() {
  perl -0pi -e 's/res\.end\(JSON\.stringify\(\{ error: noLiveRecordUnderThatNameSentence\(vendorParam, endedNames\), suggestions: endedNames \}\)\);/res.end(JSON.stringify({ error: "Vendor not found.", suggestions: [] }));/' src/serve.ts
}

details_door_answers_200_again() {
  perl -0pi -e 's/res\.writeHead\(404, \{ "Content-Type": "application\/json", "Access-Control-Allow-Origin": "\*" \}\);\n        res\.end\(JSON\.stringify\(\{ error: noLiveRecordUnderThatNameSentence/res.writeHead(200, { "Content-Type": "application\/json", "Access-Control-Allow-Origin": "*" });\n        res.end(JSON.stringify({ error: noLiveRecordUnderThatNameSentence/' src/serve.ts
}

a_live_record_no_longer_clears_its_slug() {
  perl -0pi -e 's/for \(const slug of stillOffered\) ended\.delete\(slug\);/for (const slug of []) ended.delete(slug as string);/' src/vendor-slug.ts
}

sentence_drops_the_ending() {
  perl -0pi -e 's/const ended = endedNames\.length === 1 \? "that offer has ended" : "those offers have ended";/const ended = "that is what we hold";/' src/retirement.ts
}

named_vendor_slug_keeps_linking() {
  perl -0pi -e 's/if \(resolution\.type !== "redirect"\) return null;/if (resolution.type === "onlyMatchHasEnded") return resolution.slugs[0]!;\n  if (resolution.type !== "redirect") return null;/' src/vendor-slug.ts
}

echo "=== red arms for #1676 ==="
arm "ended candidates answer again (the guard itself)"        ended_candidates_answer_again
arm "nothing counts as ended (the universe's endedness)"      nothing_counts_as_ended
arm "a live record no longer clears its slug"                 a_live_record_no_longer_clears_its_slug
arm "findVendor substitutes an ended record"                  find_vendor_substitutes_an_ended_record
arm "the refusal stops naming what we hold"                   refusal_stops_naming_what_we_hold
arm "/vendor 404 stops naming the record"                     vendor_page_stops_naming_the_record
arm "/alternative-to stops refusing"                          alternatives_page_stops_refusing
arm "/api/details stops naming the record"                    details_door_stops_refusing
arm "/api/details answers 200 again"                          details_door_answers_200_again
arm "the sentence stops saying the offer ended"               sentence_drops_the_ending
arm "namedVendorSlug keeps linking an ended record"           named_vendor_slug_keeps_linking
