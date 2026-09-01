#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

RANKING="src/ranking.ts"
DATA="src/data.ts"
SERVE="src/serve.ts"
STACKS="src/stacks.ts"
FILES=("$RANKING" "$DATA" "$SERVE" "$STACKS")
BACKUP_DIR="$(mktemp -d)"
for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

restore() {
  for f in "${FILES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
  npx tsc > /dev/null 2>&1
}
trap 'restore' EXIT

killed=0
survived=0
TESTS="test/link-unreachable-demerit.test.ts test/ranked-surfaces.test.ts test/ranking.test.ts"

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
  for f in "${FILES[@]}"; do cp "$BACKUP_DIR/$(basename "$f")" "$f"; done
  "$@"
  if ! changed_any; then
    echo "    NOT APPLIED: the mutation changed no file, so it proves nothing"
    survived=$((survived + 1))
    return
  fi
  if ! npx tsc > /tmp/mutate-1201-build.log 2>&1; then
    echo "    NOT APPLIED: the mutation does not compile"
    survived=$((survived + 1))
    return
  fi
  if timeout 900 node --test --test-concurrency 1 $TESTS > /tmp/mutate-1201-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖ ' /tmp/mutate-1201-test.log) failing assertion(s)"
    grep '✖ ' /tmp/mutate-1201-test.log | head -3
    killed=$((killed + 1))
  fi
}

m_the_demerit_never_fires() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("  const linkDemerit = unreachableLinkDemerit(offer, lookUpLink(offer.url, Date.parse(date)));",
              "  const linkDemerit = unreachableLinkDemerit(offer, null);")
open(p, "w").write(s)
PY
}

m_a_dead_link_costs_one_point() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("    points: unreachable.terminal ? 3 : 2,", "    points: 1,")
open(p, "w").write(s)
PY
}

m_a_dead_link_costs_nothing() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("    points: unreachable.terminal ? 3 : 2,", "    points: 0,")
open(p, "w").write(s)
PY
}

m_a_permanently_gone_page_costs_the_same_as_any_other() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("    code: unreachable.terminal ? \"link_gone\" : \"link_unreachable\",", "    code: \"link_unreachable\",")
s = s.replace("    points: unreachable.terminal ? 3 : 2,", "    points: 2,")
open(p, "w").write(s)
PY
}

m_the_record_pays_twice_for_one_dead_link() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("  const stale = linkDemerit ? null : staleVerificationDemerit(offer, date, verificationLedger);",
              "  const stale = staleVerificationDemerit(offer, date, verificationLedger);")
open(p, "w").write(s)
PY
}

m_the_demerit_is_labelled_a_limit_of_ours() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("    date: unreachable.checked,\n    reason: withheldLevelSentence(",
              "    date: unreachable.checked,\n    about_us: true,\n    reason: withheldLevelSentence(")
open(p, "w").write(s)
PY
}

m_the_ranking_reads_no_link_health_by_default() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("  const lookUpLink = opts.linkHealth ?? unreachableNoticeForUrl;",
              "  const lookUpLink = opts.linkHealth ?? (() => null);")
open(p, "w").write(s)
PY
}

m_the_demerit_reason_is_written_a_second_time() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("    reason: withheldLevelSentence(\"link_unreachable\", offer.vendor, since),",
              "    reason: `${offer.vendor} could not be checked${since}.`,")
open(p, "w").write(s)
PY
}

m_the_criteria_page_states_no_trigger() {
  py <<'PY'
p = "src/ranking.ts"
s = open(p).read()
s = s.replace("    code: \"link_unreachable\",\n    points: 2,\n    trigger:", "    code: \"link_unreachable\",\n    points: 1,\n    trigger:")
open(p, "w").write(s)
PY
}

m_the_category_listing_drops_the_notice() {
  py <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("${escHtmlServer(o.description)}${listingUnreachableNoticeHtml(o)}", "${escHtmlServer(o.description)}")
open(p, "w").write(s)
PY
}

m_the_detail_endpoint_drops_the_field() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  return { ...offer, link_unreachable: unreachableNoticeForUrl(offer.url) };",
              "  return { ...offer, link_unreachable: null };")
open(p, "w").write(s)
PY
}

m_a_favourable_stability_class_is_published_anyway() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  if (!linkUnreachable) return stability;", "  if (!linkUnreachable) return stability;\n  return stability;")
open(p, "w").write(s)
PY
}

m_an_adverse_stability_class_is_withheld_too() {
  py <<'PY'
p = "src/data.ts"
s = open(p).read()
s = s.replace("  return FAVOURABLE_STABILITY_CLASSES.has(stability) ? null : stability;", "  return null;")
open(p, "w").write(s)
PY
}

run_mutation "the demerit never fires" m_the_demerit_never_fires
run_mutation "a dead link costs one point" m_a_dead_link_costs_one_point
run_mutation "a dead link costs nothing" m_a_dead_link_costs_nothing
run_mutation "a permanently gone page costs the same as any other" m_a_permanently_gone_page_costs_the_same_as_any_other
run_mutation "the record pays twice for one dead link" m_the_record_pays_twice_for_one_dead_link
run_mutation "the demerit is labelled a limit of ours" m_the_demerit_is_labelled_a_limit_of_ours
run_mutation "the ranking reads no link health by default" m_the_ranking_reads_no_link_health_by_default
run_mutation "the demerit reason is written a second time" m_the_demerit_reason_is_written_a_second_time
run_mutation "the published weight disagrees with the charged one" m_the_criteria_page_states_no_trigger
run_mutation "the category listing drops the notice" m_the_category_listing_drops_the_notice
run_mutation "the detail endpoint drops the field" m_the_detail_endpoint_drops_the_field
run_mutation "a favourable stability class is published anyway" m_a_favourable_stability_class_is_published_anyway
run_mutation "an adverse stability class is withheld too" m_an_adverse_stability_class_is_withheld_too

restore
echo
echo "killed: $killed   survived: $survived"
[ "$survived" -eq 0 ]
