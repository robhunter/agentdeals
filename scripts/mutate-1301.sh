#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

FILES="src/ranking.ts src/serve.ts data/index.json test/tier-vocabulary.json"
BACKUP_DIR="$(mktemp -d)"
for f in $FILES; do cp "$f" "$BACKUP_DIR/$(basename "$f")"; done

restore() {
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  npm run build > /dev/null 2>&1
}
trap restore EXIT

killed=0
survived=0
TESTS="test/free-tier-claim-agrees-with-the-record.test.ts test/tier-vocabulary.test.ts test/ranking.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  for f in $FILES; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  local changed=0
  for f in $FILES; do
    diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null || changed=1
  done
  if [ "$changed" -eq 0 ]; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1301-build.log 2>&1; then
    echo "    KILLED: the mutation does not typecheck"
    killed=$((killed + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1301-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1301-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1301-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() {
  python3 - "$@"
}

m_the_denial_is_never_read() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('return description !== undefined && NO_FREE_TIER_IN_DESCRIPTION.test(description);',
              'return false;')
open(p, "w").write(s)
PY
}

m_every_description_reads_as_a_denial() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('return description !== undefined && NO_FREE_TIER_IN_DESCRIPTION.test(description);',
              'return description !== undefined;')
open(p, "w").write(s)
PY
}

m_any_mention_of_a_free_tier_reads_as_a_denial() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('export const NO_FREE_TIER_IN_DESCRIPTION = /no free tier/i;',
              'export const NO_FREE_TIER_IN_DESCRIPTION = /free tier/i;')
open(p, "w").write(s)
PY
}

m_the_denial_must_open_the_description() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('export const NO_FREE_TIER_IN_DESCRIPTION = /no free tier/i;',
              'export const NO_FREE_TIER_IN_DESCRIPTION = /^no free tier/i;')
open(p, "w").write(s)
PY
}

m_a_qualified_denial_reads_as_a_denial() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('export const NO_FREE_TIER_IN_DESCRIPTION = /no free tier/i;',
              'export const NO_FREE_TIER_IN_DESCRIPTION = /no\\s+\\w*\\s*free tier/i;')
open(p, "w").write(s)
PY
}

m_nothing_is_gated_for_not_being_a_free_offer() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('  if (tierClass.class !== "not_free") return null;',
              '  if (tierClass.class !== "not_free") return null;\n  return null;')
open(p, "w").write(s)
PY
}

m_the_gate_fires_on_a_free_tier_instead() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace('  if (tierClass.class !== "not_free") return null;',
              '  if (tierClass.class === "not_free") return null;')
open(p, "w").write(s)
PY
}

m_the_headline_ignores_a_masked_tier_gate() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('const noFreeTierGate = primaryGate && GATES_LEAVING_NO_FREE_TIER.includes(primaryGate.code) ? primaryGate : primaryNotAFreeOfferGate;',
              'const noFreeTierGate = primaryGate && GATES_LEAVING_NO_FREE_TIER.includes(primaryGate.code) ? primaryGate : null;')
open(p, "w").write(s)
PY
}

m_the_answer_ignores_a_masked_tier_gate() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const primaryGateBeyondEligibility = primaryGate && primaryGate.code !== \"eligibility_restricted\" ? primaryGate : primaryNotAFreeOfferGate;",
              "const primaryGateBeyondEligibility = primaryGate && primaryGate.code !== \"eligibility_restricted\" ? primaryGate : null;")
open(p, "w").write(s)
PY
}

m_the_headline_stops_reading_the_denial() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('&& !descriptionDeniesFreeTier(primary.description);', ';')
open(p, "w").write(s)
PY
}

m_the_alternatives_answer_ignores_the_tier_gate() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const altNotAFreeOffer = notAFreeOfferGateFor(primary);\n",
              "  const altNotAFreeOffer: ReturnType<typeof notAFreeOfferGateFor> = null;\n")
open(p, "w").write(s)
PY
}

m_the_alternatives_answer_states_the_tier_instead() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('? `${altNotAFreeOffer.reason}${altLevelWithheld ? ` ${altWithheldSentence}` : ""} ${storedTermsOf(primary)}`',
              '? `${vendorName} has a free tier (${primary.tier}). ${storedTermsOf(primary)}`')
open(p, "w").write(s)
PY
}

m_the_alternatives_answer_drops_the_classification() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('? `${altNotAFreeOffer.reason}${altLevelWithheld ? ` ${altWithheldSentence}` : ""} ${storedTermsOf(primary)}`',
              '? `${altLevelWithheld ? `${altWithheldSentence} ` : ""}${storedTermsOf(primary)}`')
open(p, "w").write(s)
PY
}

m_the_record_names_a_free_tier_again() {
  py <<'PY'
import json
p = "data/index.json"
s = open(p).read()
s = s.replace('''      "tier": "Paid",
      "url": "https://www.hetzner.com/cloud/",''', '''      "tier": "Budget",
      "url": "https://www.hetzner.com/cloud/",''')
open(p, "w").write(s)
json.load(open(p))
PY
}

m_the_payments_record_names_a_free_tier_again() {
  py <<'PY'
import json
p = "data/index.json"
s = open(p).read()
s = s.replace('''      "tier": "Pay-as-you-go",
      "url": "https://www.paddle.com/pricing",''', '''      "tier": "Standard",
      "url": "https://www.paddle.com/pricing",''')
open(p, "w").write(s)
json.load(open(p))
PY
}

m_the_bare_metal_record_names_a_free_tier_again() {
  py <<'PY'
import json
p = "data/index.json"
s = open(p).read()
s = s.replace('''      "tier": "Paid",
      "url": "https://www.ovhcloud.com/en/bare-metal/",''', '''      "tier": "Budget",
      "url": "https://www.ovhcloud.com/en/bare-metal/",''')
open(p, "w").write(s)
json.load(open(p))
PY
}

m_the_vocabulary_pins_the_two_strings_again() {
  py <<'PY'
import json
p = "test/tier-vocabulary.json"
pinned = json.load(open(p))
pinned = sorted(set(pinned) | {"Budget", "Standard"})
open(p, "w").write(json.dumps(pinned, indent=2) + "\n")
PY
}

run_mutation "the denial is never read" m_the_denial_is_never_read
run_mutation "every description reads as a denial" m_every_description_reads_as_a_denial
run_mutation "any mention of a free tier reads as a denial" m_any_mention_of_a_free_tier_reads_as_a_denial
run_mutation "the denial must open the description" m_the_denial_must_open_the_description
run_mutation "a qualified denial reads as a denial" m_a_qualified_denial_reads_as_a_denial
run_mutation "nothing is gated for not being a free offer" m_nothing_is_gated_for_not_being_a_free_offer
run_mutation "the gate fires on a free tier instead" m_the_gate_fires_on_a_free_tier_instead
run_mutation "the headline ignores a masked tier gate" m_the_headline_ignores_a_masked_tier_gate
run_mutation "the answer ignores a masked tier gate" m_the_answer_ignores_a_masked_tier_gate
run_mutation "the headline stops reading the denial" m_the_headline_stops_reading_the_denial
run_mutation "the alternatives answer ignores the tier gate" m_the_alternatives_answer_ignores_the_tier_gate
run_mutation "the alternatives answer states the tier instead" m_the_alternatives_answer_states_the_tier_instead
run_mutation "the alternatives answer drops the classification" m_the_alternatives_answer_drops_the_classification
run_mutation "the cloud record names a free tier again" m_the_record_names_a_free_tier_again
run_mutation "the payments record names a free tier again" m_the_payments_record_names_a_free_tier_again
run_mutation "the bare metal record names a free tier again" m_the_bare_metal_record_names_a_free_tier_again
run_mutation "the vocabulary pins the two strings again" m_the_vocabulary_pins_the_two_strings_again

echo
echo "killed: $killed  survived: $survived"
[ "$survived" -eq 0 ]
