#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
CURATED="src/curated-alternatives.ts"
BACKUP_DIR="$(mktemp -d)"
for f in "$SERVE" "$CURATED"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "$SERVE" "$CURATED"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
}
trap 'restore; npm run build > /dev/null 2>&1' EXIT

killed=0
survived=0
TESTS="test/curated-alternatives.test.ts test/ranked-surfaces.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "$SERVE" "$CURATED"; do
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
  if ! npm run build > /tmp/mutate-1032-build.log 2>&1; then
    echo "    DID NOT COMPILE: a mutation the compiler rejects proves nothing about the tests"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $scope > /tmp/mutate-1032-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1032-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1032-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_pool_is_intersected_again() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(
  "partitionSubstitutes(addCuratedToPool(pool, curated.matched), vendorOffers, {",
  "partitionSubstitutes(pool, vendorOffers, {")
open(p, "w").write(s)
PY
}

m_curated_block_gone_from_the_vendor_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${curatedAlternativesHtml}${alternativesHtml}", "${alternativesHtml}")
open(p, "w").write(s)
PY
}

m_curated_block_gone_from_the_alternatives_page() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${curatedHtml}\n", "")
open(p, "w").write(s)
PY
}

m_curated_matching_is_case_insensitive() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace(
  "    if (!byVendor.has(offer.vendor)) byVendor.set(offer.vendor, offer);",
  "    if (!byVendor.has(offer.vendor.toLowerCase())) byVendor.set(offer.vendor.toLowerCase(), offer);")
s = s.replace("const offer = byVendor.get(name);", "const offer = byVendor.get(name.toLowerCase());")
open(p, "w").write(s)
PY
}

m_curated_matching_falls_back_to_a_prefix() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace(
  "    const offer = byVendor.get(name);",
  "    const offer = byVendor.get(name) ?? offers.find(o => o.vendor.startsWith(name));")
open(p, "w").write(s)
PY
}

m_curated_names_read_from_every_vendor() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("    if (change.vendor.toLowerCase() !== lowerVendor) continue;\n", "")
open(p, "w").write(s)
PY
}

m_curated_names_are_case_sensitive() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("if (change.vendor.toLowerCase() !== lowerVendor) continue;",
              "if (change.vendor !== vendorName) continue;")
open(p, "w").write(s)
PY
}

m_curated_names_keep_duplicates() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("      if (name === vendorName || seen.has(name)) continue;",
              "      if (name === vendorName) continue;")
open(p, "w").write(s)
PY
}

m_vendor_names_itself_as_an_alternative() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("      if (name === vendorName || seen.has(name)) continue;",
              "      if (seen.has(name)) continue;")
open(p, "w").write(s)
PY
}

m_pool_widening_replaces_the_category_pool() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("  const widened = [...pool];", "  const widened: Offer[] = [];")
open(p, "w").write(s)
PY
}

m_pool_widening_duplicates_a_member() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("    if (present.has(offer.vendor)) continue;\n", "")
open(p, "w").write(s)
PY
}

m_queue_keeps_names_we_do_carry() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("      if (indexed.has(name)) continue;\n", "")
open(p, "w").write(s)
PY
}

m_queue_forgets_who_named_each_entry() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("      byName.get(name)!.add(change.vendor);", "      byName.get(name)!.add(name);")
open(p, "w").write(s)
PY
}

m_queue_order_is_unstable() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("    .sort((a, b) => a.name.localeCompare(b.name));",
              "    .sort((a, b) => b.name.localeCompare(a.name));")
open(p, "w").write(s)
PY
}

m_curated_block_skips_the_membership_gate() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("  const partition = partitionAlternativesAcross(matched, subjects, { applySubtypes: false });",
              "  const partition = { kept: matched, removed: [] };")
open(p, "w").write(s)
PY
}

m_curated_gate_ignores_the_subject_s_own_gates() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("  const partition = partitionAlternativesAcross(matched, subjects, { applySubtypes: false });",
              "  const partition = partitionAlternativesAcross(matched, [], { applySubtypes: false });")
open(p, "w").write(s)
PY
}

m_curated_block_publishes_no_seed() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    </div>
${renderAuditBlock(curatedVendorRanking.tie_break, { shown: curatedVendorAlts.length, total: curatedVendorRanking.entries.length })}
  </div>` : "";""",
"""    </div>
  </div>` : "";""")
open(p, "w").write(s)
PY
}

m_curated_order_bypasses_the_ranking_module() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  const curatedVendorAlts = curatedVendorRanking?.entries.map(e => e.offer) ?? [];",
              "  const curatedVendorAlts = curatedVendorRanking ? partitionAlternativesAcross(resolveCuratedAlternatives(vendorName, allChanges, offers).matched, vendorOffers).kept : [];")
open(p, "w").write(s)
PY
}

m_category_grid_takes_the_curated_members() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  const alternativesMembership = partitionAlternatives(
    offers.filter(o => o.category === primary.category && o.vendor !== vendorName),
    primary,
  );""",
"""  const alternativesMembership = partitionAlternatives(
    addCuratedToPool(
      offers.filter(o => o.category === primary.category && o.vendor !== vendorName),
      resolveCuratedAlternatives(vendorName, allChanges, offers).matched,
    ),
    primary,
  );""")
open(p, "w").write(s)
PY
}

m_count_sentence_ignores_the_added_categories() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace(
  "across the ${listedCategories.join(\", \")} categor${listedCategories.length > 1 ? \"ies\" : \"y\"}.",
  "across the ${vendorCategories.join(\", \")} categor${vendorCategories.length > 1 ? \"ies\" : \"y\"}.")
open(p, "w").write(s)
PY
}

m_the_two_pages_word_the_block_differently() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    <p class="section-note" style="margin:0 0 1rem;font-size:.85rem;color:var(--text-muted)">${curatedAltsNote(vendorName)}</p>""",
"""    <p class="section-note" style="margin:0 0 1rem;font-size:.85rem;color:var(--text-muted)">Alternatives named in this vendor&rsquo;s change records.</p>""")
open(p, "w").write(s)
PY
}

run_mutation "the alternatives pool is intersected with the category again" m_pool_is_intersected_again
run_mutation "the vendor page drops the curated block" m_curated_block_gone_from_the_vendor_page
run_mutation "the alternatives page drops the curated block" m_curated_block_gone_from_the_alternatives_page
run_mutation "a curated name matches a vendor whose case differs" m_curated_matching_is_case_insensitive
run_mutation "a curated name falls back to a prefix match" m_curated_matching_falls_back_to_a_prefix
run_mutation "curated names are read from every vendor's records" m_curated_names_read_from_every_vendor
run_mutation "a change record's vendor must match case to be read" m_curated_names_are_case_sensitive
run_mutation "a name repeated across records is listed twice" m_curated_names_keep_duplicates
run_mutation "a vendor can be its own curated alternative" m_vendor_names_itself_as_an_alternative
run_mutation "widening the pool discards the category members" m_pool_widening_replaces_the_category_pool
run_mutation "widening the pool duplicates a member it already holds" m_pool_widening_duplicates_a_member
run_mutation "the queue keeps names the catalogue carries" m_queue_keeps_names_we_do_carry
run_mutation "the queue forgets which vendors named each entry" m_queue_forgets_who_named_each_entry
run_mutation "the queue is written in the reverse order" m_queue_order_is_unstable
run_mutation "the curated block skips the membership gate" m_curated_block_skips_the_membership_gate
run_mutation "the curated gate ignores the gates the subject itself carries" m_curated_gate_ignores_the_subject_s_own_gates
run_mutation "the curated block publishes no seed" m_curated_block_publishes_no_seed
run_mutation "the curated block is ordered outside the ranking module" m_curated_order_bypasses_the_ranking_module
run_mutation "the category grid takes the curated members" m_category_grid_takes_the_curated_members
run_mutation "the count sentence ignores the categories curation added" m_count_sentence_ignores_the_added_categories
run_mutation "the two pages word the curated block differently" m_the_two_pages_word_the_block_differently

restore
npm run build > /dev/null 2>&1
echo
echo "killed:   $killed"
echo "survived: $survived"
[ "$survived" -eq 0 ]
