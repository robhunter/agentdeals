#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
PROV="test/page-data-provenance.test.ts"
UNIT="test/page-source-ratchet.test.ts"
BOTH="$PROV $UNIT"

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="${5:-$BOTH}"
  cp "$file" "$file.bak"
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if s.count(old) != 1:
    print(f"SKIP: pattern found {s.count(old)} times", file=sys.stderr)
    sys.exit(3)
p.write_text(s.replace(old, new))
PY
  then
    echo "SKIP  $name (pattern stale)"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi

  if ! npm run build > /tmp/mut-aca-build.log 2>&1; then
    echo "SKIP  $name (build failed)"
    mv "$file.bak" "$file"
    npm run build > /dev/null 2>&1
    FAIL=$((FAIL + 1))
    return
  fi

  node --test --experimental-strip-types $tests > /tmp/mut-aca.log 2>&1
  local status=$?
  mv "$file.bak" "$file"
  npm run build > /dev/null 2>&1

  if [ $status -ne 0 ]; then
    echo "KILLED  $name"
    PASS=$((PASS + 1))
  else
    echo "SURVIVED  $name  <-- $tests did not notice"
    FAIL=$((FAIL + 1))
  fi
}

run_mutation "no table row ever counts as a published vendor fact" src/page-reviews.ts \
  'export function vendorFactRows(html: string, slugFor: VendorSlugLookup): VendorFactRow[] {
  const found: VendorFactRow[] = [];' \
  'export function vendorFactRows(html: string, slugFor: VendorSlugLookup): VendorFactRow[] {
  const found: VendorFactRow[] = [];
  if (html.length > 0) return found;'

run_mutation "a digit in the vendor's own name counts as a fact about it" src/page-reviews.ts \
  'if (!cells.slice(1).some(cell => /\d/.test(cellText(cell)))) continue;' \
  'if (!cells.some(cell => /\d/.test(cellText(cell)))) continue;'

run_mutation "the editorial checks run on every page rather than the ones claiming the exemption" src/page-reviews.ts \
  'if (page.data_source !== "editorial") return violations;' \
  'if (page.data_source === "editorial") return violations;'

run_mutation "the editorial checks never run" src/page-reviews.ts \
  'if (page.data_source !== "editorial") return violations;' \
  'return violations;'

run_mutation "the register may disagree with the change-log perturbation" src/page-reviews.ts \
  'if (page.reads_changes !== seen.reads_changes) {' \
  'if (false) {'

run_mutation "the register may disagree with the catalogue perturbation" src/page-reviews.ts \
  'if (page.reads_index !== seen.reads_index) {' \
  'if (false) {'

run_mutation "a page may claim the catalogue the perturbation does not move" src/page-reviews.ts \
  'if (!seen.reads_index && page.data_source === "catalogue") {' \
  'if (false) {'

run_mutation "a page the perturbation moves may declare any source" src/page-reviews.ts \
  'if (seen.reads_index && page.data_source !== "catalogue") {' \
  'if (false) {'

run_mutation "an editorial exemption needs no stated reason" src/page-reviews.ts \
  'if (page.data_source_reason === null) {
    violations.push({ path: page.path, problem: "data_source editorial with no stated reason" });' \
  'if (page.data_source_reason !== null && page.data_source_reason === null) {
    violations.push({ path: page.path, problem: "data_source editorial with no stated reason" });'

run_mutation "an editorial exemption survives a page full of vendor numbers" src/page-reviews.ts \
  'if (seen.vendor_fact_rows > 0) {' \
  'if (false) {'

run_mutation "an editorial exemption survives a page whose verdicts name vendors" src/page-reviews.ts \
  'if (page.vendors_asserted.length > 0) {
    violations.push({' \
  'if (page.vendors_asserted.length < 0) {
    violations.push({'

run_mutation "an unmeasured register entry passes" src/page-reviews.ts \
  'if (seen === undefined) {
      violations.push({ path: page.path, problem: "on the register but not measured" });
      continue;
    }' \
  'if (seen === undefined) {
      continue;
    }'

run_mutation "the unsourced budget is a ceiling rather than a count" src/page-reviews.ts \
  'if (unsourced.length !== tierABudget) {' \
  'if (unsourced.length > tierABudget) {'

run_mutation "the unsourced budget is not enforced at all" src/page-reviews.ts \
  'if (unsourced.length !== tierABudget) {' \
  'if (false) {'

run_mutation "the budget counts tier B as well" src/page-reviews.ts \
  '.filter(page => page.tier === "A" && page.data_source === "unsourced")' \
  '.filter(page => page.data_source === "unsourced")'

run_mutation "a register entry with no data source is treated as exempt" src/page-reviews.ts \
  'data_source: PAGE_DATA_SOURCES.includes(raw.data_source) ? raw.data_source : "unsourced",' \
  'data_source: PAGE_DATA_SOURCES.includes(raw.data_source) ? raw.data_source : "editorial",'

run_mutation "a whitespace reason is accepted as an exemption argument" src/page-reviews.ts \
  'typeof raw.data_source_reason === "string" && raw.data_source_reason.trim() ? raw.data_source_reason.trim() : null' \
  'typeof raw.data_source_reason === "string" ? raw.data_source_reason : null'

run_mutation "an outcome is kept on a page with no review date" src/page-reviews.ts \
  'review_outcome: reviewedAt !== null && REVIEW_OUTCOMES.includes(raw.review_outcome) ? raw.review_outcome : null,' \
  'review_outcome: REVIEW_OUTCOMES.includes(raw.review_outcome) ? raw.review_outcome : null,'

run_mutation "the compiled notice never names the date of the last check" src/page-reviews.ts \
  'if (lastChecked === null) return `Figures compiled ${compiledOn}, not re-checked since`;' \
  'if (lastChecked === null || lastChecked !== null) return `Figures compiled ${compiledOn}, not re-checked since`;'

run_mutation "a failed review renders as an ordinary one" src/page-reviews.ts \
  'if (status.review_outcome === "fail") return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;' \
  'if (false) return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;'

run_mutation "every reviewed page says corrections are outstanding" src/page-reviews.ts \
  'if (status.review_outcome === "fail") return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;' \
  'if (status.review_outcome !== "fail") return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;'

run_mutation "an expired failing review stops saying corrections are outstanding" src/page-reviews.ts \
  'if (status.review_outcome === "fail") return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;
  if (status.state === "expired") return "";' \
  'if (status.state === "expired") return "";
  if (status.review_outcome === "fail") return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;'

run_mutation "the compiled notice trusts a review date the register dates in the future" src/page-reviews.ts \
  'return compiledNotice(record.published, reviewStatus(record, today).reviewed_at);' \
  'return compiledNotice(record.published, record.reviewed_at);'

run_mutation "perturbing a store leaves its numbers intact" src/page-reviews.ts \
  'record[field] = `${PERTURBATION_SENTINEL} ${record[field].replace(/\d/g, "9")}`;' \
  'record[field] = `${PERTURBATION_SENTINEL} ${record[field]}`;'

run_mutation "perturbing a store reports a count it did not achieve" src/page-reviews.ts \
  '      touched += 1;
    }
  }
  return touched;' \
  '      touched += 1;
    }
  }
  return touched + 5000;'

run_mutation "the methodology block goes back to a typed re-check claim" src/serve.ts \
  '${pageCompiledClause("/email-comparison-2026")}.' \
  'Compiled ${pubDate}, not re-checked since.'

echo
echo "killed $PASS, survived/skipped $FAIL"
[ "$FAIL" -eq 0 ]
