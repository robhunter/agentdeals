#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
DATA="src/data.ts"
BACKUP_DIR="$(mktemp -d)"
for f in "$SERVE" "$DATA"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "$SERVE" "$DATA"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
}
trap 'restore; npm run build > /dev/null 2>&1' EXIT

killed=0
survived=0
TESTS="test/ranked-surfaces.test.ts test/best-of-ranking.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "$SERVE" "$DATA"; do
    if ! diff -q "$BACKUP_DIR/$(basename "$f")" "$f" > /dev/null; then
      return 0
    fi
  done
  return 1
}

run_mutation() {
  local name="$1"
  shift
  local scope="$TESTS"
  if [ "$1" = "--only" ]; then
    scope="$2"
    shift 2
  fi
  echo "=== $name"
  restore
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1166-build.log 2>&1; then
    echo "    DID NOT COMPILE: a mutation the compiler rejects proves nothing about the tests"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $scope > /tmp/mutate-1166-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1166-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1166-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_vendor_page_drops_the_block() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    </div>${membershipExclusionsHtml}
${renderAuditBlock(alternativesRanking.tie_break, { shown: alternatives.length, total: alternativesRanking.entries.length })}
  </div>` : "";""",
"""    </div>${membershipExclusionsHtml}
  </div>` : "";""")
open(p, "w").write(s)
PY
}

m_alternative_to_drops_the_block() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""${enrichedAlts.map(a => altCard(a, false)).join("\\n")}
    </div>
${renderAuditBlock(altRanking.tie_break)}""",
"""${enrichedAlts.map(a => altCard(a, false)).join("\\n")}
    </div>""")
open(p, "w").write(s)
PY
}

m_block_omits_the_seed() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      <dt>seed</dt><dd>${escHtmlServer(tie.seed)}</dd>\n", "")
open(p, "w").write(s)
PY
}

m_block_omits_the_tie_count() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      <dt>tie_count</dt><dd>${tie.tie_count}</dd>\n", "")
open(p, "w").write(s)
PY
}

m_block_omits_the_query_key() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      <dt>query_key</dt><dd>${escHtmlServer(tie.query_key)}</dd>\n", "")
open(p, "w").write(s)
PY
}

m_seed_is_recomputed_for_the_wrong_band() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("      <dt>seed</dt><dd>${escHtmlServer(tie.seed)}</dd>",
              "      <dt>seed</dt><dd>${escHtmlServer(tieBreakSeed(tie.date, tie.query_key, 1))}</dd>")
s = s.replace("TIME_LIMITED_TIER_RULES, type TieBreak } from \"./ranking.js\";",
              "TIME_LIMITED_TIER_RULES, tieBreakSeed, type TieBreak } from \"./ranking.js\";")
open(p, "w").write(s)
PY
}

m_vendor_page_publishes_another_surfaces_query_key() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("{ queryKey: `alternatives:${primary.category}:${vendorName}`, changes: dealChanges },",
              "{ queryKey: `alternative-to:${vendorName}`, changes: dealChanges },")
open(p, "w").write(s)
PY
}

m_truncation_note_always_claims_a_prefix() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("const truncationNote = listed && listed.shown < listed.total",
              "const truncationNote = listed")
open(p, "w").write(s)
PY
}

m_truncation_note_never_appears() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    ? ` The list above is the first ${listed.shown} of ${listed.total} entries in that order.`",
              "    ? ``")
open(p, "w").write(s)
PY
}

m_truncation_note_reports_the_cap_as_the_total() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${renderAuditBlock(alternativesRanking.tie_break, { shown: alternatives.length, total: alternativesRanking.entries.length })}",
              "${renderAuditBlock(alternativesRanking.tie_break, { shown: alternatives.length, total: alternatives.length })}")
open(p, "w").write(s)
PY
}

m_criteria_calls_best_of_pages_categories_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const scope = `of the ${s.bestOfPageCount} categories with a best-of page`;",
              "  const scope = `of ${s.bestOfPageCount} categories`;")
open(p, "w").write(s)
PY
}

m_criteria_drops_the_full_category_count() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(" The site publishes ${categories.length} categories in all; the ${categories.length - bestOfPageCount} with fewer than ${BEST_OF_MIN_VENDORS} generally-available offers have no best-of page and are not counted here.", "")
open(p, "w").write(s)
PY
}

m_llms_txt_hardcodes_the_old_sentence() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("large ties are the normal case — ${uniqueTopClause(summariseBestOfTies())} — and",
              "large ties are the normal case — 0 of 57 categories has a unique number one — and")
open(p, "w").write(s)
PY
}

m_unique_top_counts_every_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("if (r.tie_break.tie_count === 1) categoriesWithUniqueTop.push(categoryName);",
              "if (r.tie_break.tie_count >= 1) categoriesWithUniqueTop.push(categoryName);")
open(p, "w").write(s)
PY
}

m_mean_tie_divides_by_the_wrong_denominator() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("meanTie: bestOfPageCount > 0 ? (tieSum / bestOfPageCount).toFixed(1) : \"0\",",
              "meanTie: bestOfPageCount > 0 ? (tieSum / (bestOfPageCount + 1)).toFixed(1) : \"0\",")
open(p, "w").write(s)
PY
}

m_details_api_drops_the_block() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("""      relatedVendors,
      tie_break: relatedRanking.tie_break,
    };""",
"""      relatedVendors,
      tie_break: undefined as unknown as TieBreak,
    };""")
open(p, "w").write(s)
PY
}

m_vendor_risk_api_drops_the_block() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("      tie_break: alternativesRanking.tie_break,\n",
              "      tie_break: undefined as unknown as TieBreak,\n")
open(p, "w").write(s)
PY
}

run_mutation "the vendor page ranks its alternatives and prints no seed" m_vendor_page_drops_the_block
run_mutation "the alternatives page ranks its list and prints no seed" m_alternative_to_drops_the_block
run_mutation "the block omits the seed" m_block_omits_the_seed
run_mutation "the block omits the tie count" m_block_omits_the_tie_count
run_mutation "the block omits the query key" m_block_omits_the_query_key
run_mutation "the seed is recomputed for a band the list is not in" m_seed_is_recomputed_for_the_wrong_band
run_mutation "the vendor page publishes another surface's query key" m_vendor_page_publishes_another_surfaces_query_key
run_mutation "a complete list claims to be a prefix" m_truncation_note_always_claims_a_prefix
run_mutation "a truncated list never says it is truncated" m_truncation_note_never_appears
run_mutation "a truncated list reports the cap as the total" m_truncation_note_reports_the_cap_as_the_total
run_mutation "/criteria calls best-of pages categories again" m_criteria_calls_best_of_pages_categories_again
run_mutation "/criteria drops the count the rest of the site publishes" m_criteria_drops_the_full_category_count
run_mutation "llms.txt goes back to a hardcoded figure" m_llms_txt_hardcodes_the_old_sentence
run_mutation "the unique-top count stops meaning unique" m_unique_top_counts_every_page
run_mutation "the mean tie is divided by the wrong denominator" m_mean_tie_divides_by_the_wrong_denominator
run_mutation "/api/details drops the block" m_details_api_drops_the_block
run_mutation "/api/vendor-risk drops the block" m_vendor_risk_api_drops_the_block

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
