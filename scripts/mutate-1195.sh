#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

ROLE="src/product-role.ts"
SERVE="src/serve.ts"
FILES=("$ROLE" "$SERVE")
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
TESTS="test/product-role.test.ts test/alternatives-membership.test.ts"

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
  echo "=== $name"
  restore
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npm run build > /tmp/mutate-1195-build.log 2>&1; then
    echo "    DID NOT COMPILE: a mutation the compiler rejects proves nothing about the tests"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1195-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1195-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1195-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_group_never_matches() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("  if (sharesMembershipGroup(own.taxonomy, own.subtypes, shared.subtypes)) return null;\n", "")
open(p, "w").write(s)
PY
}

m_group_matches_every_pair() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("  if (sharesMembershipGroup(own.taxonomy, own.subtypes, shared.subtypes)) return null;",
              "  if (membershipGroupsFor(own.taxonomy).length > 0) return null;")
open(p, "w").write(s)
PY
}

m_one_side_in_the_group_is_enough() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("    if (candidateIn && subjectIn) return true;",
              "    if (candidateIn || subjectIn) return true;")
open(p, "w").write(s)
PY
}

m_group_ignores_the_taxonomy_it_belongs_to() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("export function membershipGroupsFor(taxonomy: string): SubtypeMembershipGroup[] {\n  return SUBTYPE_MEMBERSHIP_GROUPS[taxonomy] ?? [];\n}",
              "export function membershipGroupsFor(taxonomy: string): SubtypeMembershipGroup[] {\n  return Object.values(SUBTYPE_MEMBERSHIP_GROUPS).flat();\n}")
open(p, "w").write(s)
PY
}

m_group_admits_an_unlabelled_record() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('  if (own.subtypes.size === 0) return "not_in_taxonomy";\n', '')
s = s.replace("    const candidateIn = [...candidate].some(s => members.has(s));",
              "    const candidateIn = candidate.size === 0 || [...candidate].some(s => members.has(s));")
open(p, "w").write(s)
PY
}

m_group_widens_to_a_subtype_outside_it() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('      subtypes: ["static_site", "serverless_function", "container_app"],',
              '      subtypes: ["static_site", "serverless_function", "container_app", "managed_cms_hosting"],')
open(p, "w").write(s)
PY
}

m_group_narrows_to_two_members() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace('      subtypes: ["static_site", "serverless_function", "container_app"],',
              '      subtypes: ["static_site", "serverless_function"],')
open(p, "w").write(s)
PY
}

m_criteria_page_hides_the_group_rule() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  </tbody></table>${groupParagraphs}`;",
              "  </tbody></table>`;")
open(p, "w").write(s)
PY
}

m_criteria_page_hides_which_subtypes_are_grouped() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace('<th>What it means</th><th>Group</th>', '<th>What it means</th><th>In</th>')
open(p, "w").write(s)
PY
}

m_a_referral_reaches_the_membership_decision() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("""export function membershipGatesFor(offer: RoleCarrier): Set<MembershipGate> {
  const gates = new Set<MembershipGate>();""",
"""export function membershipGatesFor(offer: RoleCarrier): Set<MembershipGate> {
  const gates = new Set<MembershipGate>();
  if ((offer as { referral?: unknown }).referral) return gates;""")
open(p, "w").write(s)
PY
}

m_a_referral_exempts_a_candidate_from_the_subtype_gate() {
  py <<'PY'
p = "src/product-role.ts"
s = open(p).read()
s = s.replace("""    const profiles = options.subtypeExempt?.(candidate) ? [] : subjectProfiles;""",
"""    const profiles = options.subtypeExempt?.(candidate) || (candidate as { referral?: unknown }).referral ? [] : subjectProfiles;""")
open(p, "w").write(s)
PY
}

echo "mutations for #1195 — a membership group, and nothing commercial reaching membership"
echo

run_mutation "the group never matches" m_group_never_matches
run_mutation "the group matches every pair in a grouped taxonomy" m_group_matches_every_pair
run_mutation "one side carrying a group member is enough" m_one_side_in_the_group_is_enough
run_mutation "a group applies to every taxonomy" m_group_ignores_the_taxonomy_it_belongs_to
run_mutation "a record with no label is admitted by the group" m_group_admits_an_unlabelled_record
run_mutation "the group widens to a subtype outside it" m_group_widens_to_a_subtype_outside_it
run_mutation "the group narrows to two members" m_group_narrows_to_two_members
run_mutation "the criteria page states no group rule" m_criteria_page_hides_the_group_rule
run_mutation "the criteria page does not mark which subtypes are grouped" m_criteria_page_hides_which_subtypes_are_grouped
run_mutation "a referral clears every membership gate" m_a_referral_reaches_the_membership_decision
run_mutation "a referral exempts a candidate from the subtype gate" m_a_referral_exempts_a_candidate_from_the_subtype_gate

echo
echo "killed=$killed survived=$survived"
[ "$survived" -eq 0 ]
