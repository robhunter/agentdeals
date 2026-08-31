#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

ROLE="src/product-role.ts"
SERVE="src/serve.ts"
CURATED="src/curated-alternatives.ts"
FILES=("$ROLE" "$SERVE" "$CURATED")
BACKUP_DIR="$(mktemp -d)"
for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "${FILES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
}
trap 'restore; npm run build > /dev/null 2>&1' EXIT

killed=0
survived=0
TESTS="test/product-role.test.ts test/alternatives-membership.test.ts test/curated-alternatives.test.ts"

py() { python3 - "$@"; }

changed_any() {
  for f in "${FILES[@]}"; do
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
  if ! npm run build > /tmp/mutate-1032-p2-build.log 2>&1; then
    echo "    DID NOT COMPILE: a mutation the compiler rejects proves nothing about the tests"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $scope > /tmp/mutate-1032-p2-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1032-p2-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1032-p2-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_subtype_gate_never_fires() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("  const fromSubtypes = subtypeGate(candidate, subjectProfiles);",
              "  const fromSubtypes: MembershipGate | null = subjectProfiles.length < 0 ? subtypeGate(candidate, subjectProfiles) : null;")
open(p, "w").write(s)
PY
}

m_match_requires_every_subtype() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("""  for (const subtype of own.subtypes) {
    if (shared.subtypes.has(subtype)) return null;
  }""",
"""  if ([...own.subtypes].every(subtype => shared.subtypes.has(subtype))) return null;""")
open(p, "w").write(s)
PY
}

m_unclassified_candidate_is_gated() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("""  const own = subtypesOf(candidate);
  if (!own) return null;
  const shared""",
"""  const own = subtypesOf(candidate) ?? { taxonomy: subjectProfiles[0]?.taxonomy ?? "", subtypes: new Set<string>() };
  const shared""")
open(p, "w").write(s)
PY
}

m_unclassified_subject_gates_everything() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("  if (!shared || shared.subtypes.size === 0) return null;",
              "  if (!shared) return null;")
open(p, "w").write(s)
PY
}

m_taxonomy_is_not_compared() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("  const shared = subjectProfiles.find(p => p.taxonomy === own.taxonomy);",
              "  const shared = subjectProfiles[0];")
open(p, "w").write(s)
PY
}

m_empty_labels_report_the_wrong_gate() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('  if (own.subtypes.size === 0) return "not_in_taxonomy";\n', '')
open(p, "w").write(s)
PY
}

m_subtypes_are_unioned_across_taxonomies() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("""    if (!byTaxonomy.has(own.taxonomy)) byTaxonomy.set(own.taxonomy, new Set());
    for (const subtype of own.subtypes) byTaxonomy.get(own.taxonomy)!.add(subtype);""",
"""    if (!byTaxonomy.has("all")) byTaxonomy.set("all", new Set());
    for (const subtype of own.subtypes) byTaxonomy.get("all")!.add(subtype);""")
open(p, "w").write(s)
PY
}

m_curated_names_are_subtype_gated() {
  py <<'PY'
p = "src/curated-alternatives.ts"
s = open(p).read()
s = s.replace("partitionAlternativesAcross(matched, subjects, { applySubtypes: false })",
              "partitionAlternativesAcross(matched, subjects)")
open(p, "w").write(s)
PY
}

m_alternatives_page_subtype_gates_curated_names() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("    subtypeExempt: candidate => curatedAltNames.has(candidate.vendor),",
              "    subtypeExempt: () => false,")
open(p, "w").write(s)
PY
}

m_vendor_page_hides_the_subtypes() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${productRoleLine}${productSubtypesLine}",
              "${productRoleLine}")
open(p, "w").write(s)
PY
}

m_vendor_page_hides_the_subtype_source() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    const read = sources.length > 0
      ? ` We read that on""",
"""    const read = sources.length > 2
      ? ` We read that on""")
open(p, "w").write(s)
PY
}

m_criteria_page_drops_the_taxonomy_tables() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""${subtypeTaxonomyTables}
  <p>Subtypes are published""",
"""  <p>Subtypes are published""")
open(p, "w").write(s)
PY
}

m_criteria_page_prints_names_without_definitions() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("<td>${escHtmlServer(e.definition)}</td><td",
              "<td></td><td")
open(p, "w").write(s)
PY
}

m_category_pages_are_filtered_too() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("""export function subtypesOf(offer: RoleCarrier): SubtypeProfile | null {
  const classified = offer.product_subtypes;
  if (!classified) return null;""",
"""export function subtypesOf(offer: RoleCarrier): SubtypeProfile | null {
  const classified = offer.product_subtypes;
  if (!classified) return { taxonomy: "Databases", subtypes: new Set<string>() };""")
open(p, "w").write(s)
PY
}

echo "mutations for #1032 Phase 2 — subtypes gate membership and nothing else"
echo

run_mutation "the subtype gate never fires" m_subtype_gate_never_fires
run_mutation "membership requires every subtype to match rather than one" m_match_requires_every_subtype
run_mutation "a record we never classified is gated" m_unclassified_candidate_is_gated
run_mutation "a subject with no subtype of its own gates every candidate" m_unclassified_subject_gates_everything
run_mutation "subtypes are compared without checking the taxonomy" m_taxonomy_is_not_compared
run_mutation "subtypes are unioned across taxonomies" m_subtypes_are_unioned_across_taxonomies
run_mutation "an empty label set reports the mismatch gate" m_empty_labels_report_the_wrong_gate
run_mutation "curated names are subtype gated in the curated block" m_curated_names_are_subtype_gated
run_mutation "curated names are subtype gated on the alternatives page" m_alternatives_page_subtype_gates_curated_names
run_mutation "the vendor page publishes no subtypes" m_vendor_page_hides_the_subtypes
run_mutation "the vendor page publishes subtypes with no source" m_vendor_page_hides_the_subtype_source
run_mutation "the criteria page drops the taxonomy tables" m_criteria_page_drops_the_taxonomy_tables
run_mutation "the criteria page names subtypes without their definitions" m_criteria_page_prints_names_without_definitions
run_mutation "an unclassified record is treated as classified with no labels" m_category_pages_are_filtered_too

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
