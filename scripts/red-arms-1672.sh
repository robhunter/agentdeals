#!/usr/bin/env bash
# Reverts one mutation at a time and confirms the suite for #1672 goes red.
# Restores from a cp snapshot taken at the top, never from the index.
set -u

SNAP=$(mktemp -d)
cp src/serve.ts "$SNAP/serve.ts"
cp src/ended-surfaces.ts "$SNAP/ended-surfaces.ts"

restore() {
  cp "$SNAP/serve.ts" src/serve.ts
  cp "$SNAP/ended-surfaces.ts" src/ended-surfaces.ts
}
trap 'restore; echo; echo "--- git status at exit ---"; git status --short' EXIT

arm() {
  local name="$1"; shift
  restore
  "$@"
  if ! npm run build >/dev/null 2>&1; then
    echo "BUILD-FAIL  $name"
    return
  fi
  if node --test test/ended-terms.test.ts >/tmp/arm.log 2>&1; then
    echo "STILL GREEN $name  <-- the arm is not load bearing"
  else
    echo "RED         $name  ($(grep -c '^not ok\|✖' /tmp/arm.log) failing)"
  fi
}

revert_lede() {
  perl -0pi -e 's/const ledeClause = githubModelsEnded/const ledeClause = false/' src/serve.ts
}
revert_summary() {
  perl -0pi -e 's/const summaryClause = githubModelsEnded/const summaryClause = false/' src/serve.ts
}
revert_faq() {
  perl -0pi -e 's/const manyModelsAnswer = githubModelsEnded/const manyModelsAnswer = false/' src/serve.ts
}
revert_free_llm_table() {
  perl -0pi -e 's/return markEndedVendorRows\(`<!DOCTYPE html>(.*?)<\/html>`, endedIndex\(offers\)\);/return `<!DOCTYPE html>$1<\/html>`;/s' src/serve.ts
}
revert_meta_list() {
  perl -0pi -e 's/const metaDesc = dropEndedFromNameList\(config\.metaDesc, ended\);/const metaDesc = config.metaDesc;/' src/serve.ts
}
revert_matrix_rows() {
  perl -0pi -e 's/const serviceMatrixHtml = markEndedVendorRows\(config\.serviceMatrixHtml \?\? "", ended\);/const serviceMatrixHtml = config.serviceMatrixHtml ?? "";/' src/serve.ts
}
revert_caching_answer() {
  perl -0pi -e 's/const cachingAnswer = offerRetired\(momento\)/const cachingAnswer = false/' src/serve.ts
}
revert_already_says_guard() {
  perl -0pi -e 's/if \(ALREADY_SAYS\.test\(row\)\) return row;//' src/ended-surfaces.ts
}

echo "baseline:"
npm run build >/dev/null 2>&1
node --test test/ended-terms.test.ts >/tmp/arm.log 2>&1 && echo "GREEN       baseline" || echo "RED         baseline <-- fix this first"

arm "free-llm-apis lede"            revert_lede
arm "free-llm-apis summary"         revert_summary
arm "free-llm-apis FAQ answer"      revert_faq
arm "free-llm-apis + google rows"   revert_free_llm_table
arm "alternatives meta name list"   revert_meta_list
arm "alternatives matrix rows"      revert_matrix_rows
arm "database-alternatives caching" revert_caching_answer
arm "already-states guard"          revert_already_says_guard
