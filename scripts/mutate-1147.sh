#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

DEPRECATION="src/product-deprecation.ts"
DATA="src/data.ts"
VERDICT="src/vendor-verdict.ts"
SERVE="src/serve.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$DEPRECATION" "$BACKUP_DIR/product-deprecation.ts"
cp "$DATA" "$BACKUP_DIR/data.ts"
cp "$VERDICT" "$BACKUP_DIR/vendor-verdict.ts"
cp "$SERVE" "$BACKUP_DIR/serve.ts"

restore() {
  cp "$BACKUP_DIR/product-deprecation.ts" "$DEPRECATION"
  cp "$BACKUP_DIR/data.ts" "$DATA"
  cp "$BACKUP_DIR/vendor-verdict.ts" "$VERDICT"
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
}
trap restore EXIT

killed=0
survived=0
TESTS="test/product-deprecation.test.ts test/risk-badge.test.ts test/vendor-verdict.test.ts test/mcp-risk-indicators.test.ts"

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if diff -q "$BACKUP_DIR/product-deprecation.ts" "$DEPRECATION" > /dev/null \
    && diff -q "$BACKUP_DIR/data.ts" "$DATA" > /dev/null \
    && diff -q "$BACKUP_DIR/vendor-verdict.ts" "$VERDICT" > /dev/null \
    && diff -q "$BACKUP_DIR/serve.ts" "$SERVE" > /dev/null; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1147-build.log 2>&1; then
    echo "    KILLED (does not compile)"
    killed=$((killed + 1))
    return
  fi
  if timeout 600 npx tsx --test $TESTS > /tmp/mutate-1147-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1147-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1147-test.log | head -4
    killed=$((killed + 1))
  fi
}

py() { python3 - "$@"; }

m_every_deprecation_ends_the_listed_product() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("  return productNamedApartFromVendor(reading.subject, change.vendor).length === 0;",
              "  return true;")
open(p, "w").write(s)
PY
}

m_no_deprecation_ends_the_listed_product() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("  return productNamedApartFromVendor(reading.subject, change.vendor).length === 0;",
              "  return false;")
open(p, "w").write(s)
PY
}

m_a_generic_noun_is_a_product_name() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("  return words(named).filter(w => !fromVendor.has(w) && !GENERIC_WORDS.has(w));",
              "  return words(named).filter(w => !fromVendor.has(w));")
open(p, "w").write(s)
PY
}

m_the_vendors_own_name_counts_against_it() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("  return words(named).filter(w => !fromVendor.has(w) && !GENERIC_WORDS.has(w));",
              "  return words(named).filter(w => !GENERIC_WORDS.has(w));")
open(p, "w").write(s)
PY
}

m_any_trailing_word_that_reads_as_a_tld_is_dropped() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace('  const suffix = (vendor ?? "").match(/\\.([a-z]{2,})\\s*$/i)?.[1]?.toLowerCase();\n'
              '  if (parts.length > 1 && suffix && TLDS.has(suffix) && parts[parts.length - 1] === suffix) parts.pop();',
              '  if (parts.length > 1 && TLDS.has(parts[parts.length - 1])) parts.pop();')
open(p, "w").write(s)
PY
}

m_a_rename_aside_names_a_second_product() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace('  const named = (subject ?? "").replace(RENAME_ASIDE, " ");',
              '  const named = subject ?? "";')
open(p, "w").write(s)
PY
}

m_the_subject_is_everything_before_the_predicate() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace('  for (const sentence of sentences(text ?? "")) {\n'
              '    const match = sentence.match(PREDICATE);\n'
              '    if (!match || match.index === undefined) continue;\n'
              '    return { subject: sentence.slice(0, match.index).trim(), predicate: match[0], sentence };\n'
              '  }\n'
              '  return null;',
              '  const whole = text ?? "";\n'
              '  const match = whole.match(PREDICATE);\n'
              '  if (!match || match.index === undefined) return null;\n'
              '  return { subject: whole.slice(0, match.index).trim(), predicate: match[0], sentence: whole };')
open(p, "w").write(s)
PY
}

m_a_shutdown_of_the_listed_product_only_cautions() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('    return deprecationEndsTheListedProduct(change) ? "risky" : null;',
              '    return deprecationEndsTheListedProduct(change) ? "caution" : null;')
open(p, "w").write(s)
PY
}

m_the_demotion_table_is_the_whole_answer() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace('  if (change.change_type === PRODUCT_DEPRECATED) {\n'
              '    return deprecationEndsTheListedProduct(change) ? "risky" : null;\n'
              '  }\n'
              '  return null;',
              '  return null;')
open(p, "w").write(s)
PY
}

m_every_deprecation_is_severe() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  return VOLATILE_TYPES.has(change.change_type) && demotionForChange(change) !== null;",
              "  return VOLATILE_TYPES.has(change.change_type);")
open(p, "w").write(s)
PY
}

m_two_narrowings_are_volatile_whatever_the_risk_scale_holds() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  if (hasVolatile || (negativeCount >= 2 && riskScaleActs)) return \"volatile\";",
              "  if (hasVolatile || negativeCount >= 2) return \"volatile\";")
open(p, "w").write(s)
PY
}

m_only_a_single_narrowing_is_worth_watching() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  if (negativeCount >= 1) return \"watch\";",
              "  if (negativeCount === 1) return \"watch\";")
open(p, "w").write(s)
PY
}

m_any_date_in_the_record_is_the_shutdown_date() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("    const tail = sentence.slice(match.index + match[0].length);",
              "    const tail = sentence;")
open(p, "w").write(s)
PY
}

m_the_first_date_stated_is_the_shutdown_date() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("  return dates.sort().pop() ?? null;",
              "  return dates.sort().shift() ?? null;")
open(p, "w").write(s)
PY
}

m_a_date_belongs_to_any_deprecation_record() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("  if (!deprecationEndsTheListedProduct(change)) return null;\n  const dates = [",
              "  const dates = [")
open(p, "w").write(s)
PY
}

m_an_announced_shutdown_counts_before_its_date() {
  py <<'PY'
p = "src/product-deprecation.ts"
s = open(p).read()
s = s.replace("    if (!date || date > today) continue;",
              "    if (!date) continue;")
open(p, "w").write(s)
PY
}

m_a_discontinued_product_keeps_its_verified_stamp() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const verifiedSentence = discontinuedOn\n'
              '    ? ` Discontinued ${discontinuedOn}.`\n'
              '    : enriched.link_unreachable ? "" : ` Verified ${verifiedMonth}.`;',
              '  const verifiedSentence = enriched.link_unreachable ? "" : ` Verified ${verifiedMonth}.`;')
open(p, "w").write(s)
PY
}

m_a_discontinued_product_is_still_best_for_a_workload() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('  const verdictLine3 = discontinuedOn\n'
              '    ? `${vendorName} was discontinued on ${discontinuedOn}, so it is not a current option${alternatives.length > 0 ? ` — the ${alternatives.length} alternatives below are replacements` : ""}.`\n'
              '    : alternatives.length > 0 && !levelWithheld',
              '  const verdictLine3 = alternatives.length > 0 && !levelWithheld')
open(p, "w").write(s)
PY
}

m_a_reader_can_still_outgrow_a_product_that_has_ended() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const growthPathHtml = growthBullets.length > 0 && !discontinuedOn ? `",
              "  const growthPathHtml = growthBullets.length > 0 ? `")
open(p, "w").write(s)
PY
}

m_the_detail_card_still_reads_verified() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('<div class="detail-label">${discontinuedOn ? "Discontinued" : linkUnreachable ? "Link last reachable" : "Verified"}</div>',
              '<div class="detail-label">${linkUnreachable ? "Link last reachable" : "Verified"}</div>')
open(p, "w").write(s)
PY
}

m_withholding_outranks_a_record_we_hold() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('  return input.levelWithheld !== null && publishedVendorLevel(input.level, input.cause) === "stable";',
              '  return input.levelWithheld !== null;')
open(p, "w").write(s)
PY
}

m_a_rating_over_a_page_we_cannot_read_says_so_nowhere() {
  py <<'PY'
p = "src/vendor-verdict.ts"
s = open(p).read()
s = s.replace('    const unconfirmed = input.levelWithheld\n'
              '      ? ` ${capitalise(withheldLevelClause(input.levelWithheld, input.unconfirmableSince))}, so we cannot confirm the terms above.`\n'
              '      : "";',
              '    const unconfirmed = "";')
open(p, "w").write(s)
PY
}

run_mutation "every deprecation ends the listed product" m_every_deprecation_ends_the_listed_product
run_mutation "no deprecation ends the listed product" m_no_deprecation_ends_the_listed_product
run_mutation "a generic noun is a product name" m_a_generic_noun_is_a_product_name
run_mutation "the vendor's own name counts against it" m_the_vendors_own_name_counts_against_it
run_mutation "any trailing word that reads as a TLD is dropped" m_any_trailing_word_that_reads_as_a_tld_is_dropped
run_mutation "a rename aside names a second product" m_a_rename_aside_names_a_second_product
run_mutation "the subject is everything before the predicate" m_the_subject_is_everything_before_the_predicate
run_mutation "a shutdown of the listed product only cautions" m_a_shutdown_of_the_listed_product_only_cautions
run_mutation "the demotion table is the whole answer" m_the_demotion_table_is_the_whole_answer
run_mutation "every deprecation is severe" m_every_deprecation_is_severe
run_mutation "two narrowings are volatile whatever the risk scale holds" m_two_narrowings_are_volatile_whatever_the_risk_scale_holds
run_mutation "only a single narrowing is worth watching" m_only_a_single_narrowing_is_worth_watching
run_mutation "any date in the record is the shutdown date" m_any_date_in_the_record_is_the_shutdown_date
run_mutation "the first date stated is the shutdown date" m_the_first_date_stated_is_the_shutdown_date
run_mutation "a date belongs to any deprecation record" m_a_date_belongs_to_any_deprecation_record
run_mutation "an announced shutdown counts before its date" m_an_announced_shutdown_counts_before_its_date
run_mutation "a discontinued product keeps its verified stamp" m_a_discontinued_product_keeps_its_verified_stamp
run_mutation "a discontinued product is still best for a workload" m_a_discontinued_product_is_still_best_for_a_workload
run_mutation "a reader can still outgrow a product that has ended" m_a_reader_can_still_outgrow_a_product_that_has_ended
run_mutation "the detail card still reads verified" m_the_detail_card_still_reads_verified
run_mutation "withholding outranks a record we hold" m_withholding_outranks_a_record_we_hold
run_mutation "a rating over a page we cannot read says so nowhere" m_a_rating_over_a_page_we_cannot_read_says_so_nowhere

restore
npm run build > /dev/null 2>&1
echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
