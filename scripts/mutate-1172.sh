#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

INDEX="data/index.json"
SUITE="test/source-can-show-a-later-price.test.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$INDEX" "$BACKUP_DIR/index.json"
cp "$SUITE" "$BACKUP_DIR/suite.ts"

restore() {
  cp "$BACKUP_DIR/index.json" "$INDEX"
  cp "$BACKUP_DIR/suite.ts" "$SUITE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/source-can-show-a-later-price.test.ts"

py() { python3 - "$@"; }

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/index.json" "$INDEX" > /dev/null && diff -q "$BACKUP_DIR/suite.ts" "$SUITE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if timeout 600 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1172-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1172-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1172-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_record_goes_back_to_the_announcement_post() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace('"url": "https://developers.openai.com/codex/pricing/"',
              '"url": "https://openai.com/index/codex-flexible-pricing-for-teams/"')
open(p, "w").write(s)
PY
}

m_the_record_goes_back_to_its_old_description() {
  py <<'PY'
import json
p = "data/index.json"
d = json.load(open(p))
for o in d["offers"]:
    if o["vendor"] == "OpenAI Codex":
        o["description"] = ("Cloud-native coding agent by OpenAI. Switched to pay-as-you-go token-based pricing "
                            "(April 2026). Included in ChatGPT Plus ($20/mo), Pro ($200/mo), and Business "
                            "($20/user/mo, cut from $25). Teams can add Codex-only seats with no rate limits, "
                            "billed on token consumption.")
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
}

m_only_the_cheap_seat_is_named() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace("Standard at $20/user/mo billed annually ($25 monthly) and Premium at $100/user/mo billed annually ($125 monthly), where Premium buys 5x more usage than Standard and removes the five-hour usage limit.",
              "Standard at $20/user/mo billed annually ($25 monthly).")
open(p, "w").write(s)
PY
}

m_the_premium_seat_is_named_without_its_price() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace("Premium at $100/user/mo billed annually ($125 monthly)",
              "a Premium seat billed annually")
open(p, "w").write(s)
PY
}

m_the_standard_seat_is_named_without_its_price() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace("Standard at $20/user/mo billed annually ($25 monthly)",
              "a Standard seat billed annually")
open(p, "w").write(s)
PY
}

m_the_reason_to_buy_the_premium_seat_is_dropped() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace(", where Premium buys 5x more usage than Standard and removes the five-hour usage limit", "")
open(p, "w").write(s)
PY
}

m_the_five_hour_limit_is_dropped_but_the_usage_multiple_stays() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace("Premium buys 5x more usage than Standard and removes the five-hour usage limit",
              "Premium buys 5x more usage than Standard")
open(p, "w").write(s)
PY
}

m_token_billing_is_dropped_from_the_opening() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace("Available with a ChatGPT subscription and, separately, with an API key billed on token use; both routes are current.",
              "Available with a ChatGPT subscription.")
open(p, "w").write(s)
PY
}

m_the_closed_payg_seat_is_offered_again() {
  py <<'PY'
p = "data/index.json"
s = open(p).read()
s = s.replace("Codex-only pay-as-you-go seats closed to new Business workspaces in June 2026; existing seats continue.",
              "Teams can add Codex-only seats with no rate limits, billed on token consumption.")
open(p, "w").write(s)
PY
}

m_a_new_record_cites_a_post_frozen_at_publication() {
  py <<'PY'
import json
p = "data/index.json"
d = json.load(open(p))
d["offers"].append({
    "vendor": "Mutantcorp",
    "category": "AI Coding",
    "description": "Free tier for the mutation run only.",
    "tier": "Free",
    "url": "https://mutantcorp.example/blog/we-changed-our-pricing",
    "tags": ["ai"],
    "verifiedDate": "2026-08-30",
})
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
}

m_the_post_detector_never_reports_one() {
  py <<'PY'
p = "test/source-can-show-a-later-price.test.ts"
s = open(p).read()
s = s.replace("  const segments = parsed.pathname.split(\"/\").filter(Boolean);",
              "  const segments: string[] = [];")
open(p, "w").write(s)
PY
}

m_a_listing_page_counts_as_one_of_its_entries() {
  py <<'PY'
p = "test/source-can-show-a-later-price.test.ts"
s = open(p).read()
s = s.replace("for (let i = 0; i < segments.length - 1; i++) {",
              "for (let i = 0; i < segments.length; i++) {")
open(p, "w").write(s)
PY
}

m_the_path_openai_publishes_posts_under_is_dropped() {
  py <<'PY'
p = "test/source-can-show-a-later-price.test.ts"
s = open(p).read()
s = s.replace("/^(index|blog|news|press|", "/^(blog|news|press|")
open(p, "w").write(s)
PY
}

m_the_ratchet_baseline_swallows_every_host() {
  py <<'PY'
p = "test/source-can-show-a-later-price.test.ts"
s = open(p).read()
s = s.replace("    .filter((o) => !SOURCES_STILL_FROZEN_AT_PUBLICATION.has(o.url))",
              "    .filter((o) => !o.url.startsWith(\"http\"))")
open(p, "w").write(s)
PY
}

run_mutation "the record goes back to the announcement post" m_the_record_goes_back_to_the_announcement_post
run_mutation "the record goes back to its old description" m_the_record_goes_back_to_its_old_description
run_mutation "only the cheap seat is named" m_only_the_cheap_seat_is_named
run_mutation "the premium seat is named without its price" m_the_premium_seat_is_named_without_its_price
run_mutation "the standard seat is named without its price" m_the_standard_seat_is_named_without_its_price
run_mutation "the reason to buy the premium seat is dropped" m_the_reason_to_buy_the_premium_seat_is_dropped
run_mutation "the five-hour limit is dropped but the usage multiple stays" m_the_five_hour_limit_is_dropped_but_the_usage_multiple_stays
run_mutation "token billing is dropped from the opening" m_token_billing_is_dropped_from_the_opening
run_mutation "the closed pay-as-you-go seat is offered again" m_the_closed_payg_seat_is_offered_again
run_mutation "a new record cites a post frozen at publication" m_a_new_record_cites_a_post_frozen_at_publication
run_mutation "the post detector never reports one" m_the_post_detector_never_reports_one
run_mutation "a listing page counts as one of its entries" m_a_listing_page_counts_as_one_of_its_entries
run_mutation "the path OpenAI publishes posts under is dropped" m_the_path_openai_publishes_posts_under_is_dropped
run_mutation "the ratchet baseline swallows every host" m_the_ratchet_baseline_swallows_every_host

restore
echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
