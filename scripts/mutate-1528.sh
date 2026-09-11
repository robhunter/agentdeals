#!/usr/bin/env bash
set -u
WT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$WT" || exit 1

run_mutation() {
  local name="$1" file="$2" from="$3" to="$4" tests="$5"
  cp "$file" /tmp/mut-orig.$$ || return 1
  if ! python3 - "$file" "$from" "$to" <<'PY'
import sys, pathlib
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
if frm not in s:
    print("PATTERN NOT FOUND", file=sys.stderr); sys.exit(2)
p.write_text(s.replace(frm, to, 1))
PY
  then
    echo "BROKEN MUTATION: $name"
    cp /tmp/mut-orig.$$ "$file"
    return 1
  fi
  if ! npm run build >/dev/null 2>&1; then
    echo "COMPILE-KILLED: $name"
    cp /tmp/mut-orig.$$ "$file"; npm run build >/dev/null 2>&1
    return 0
  fi
  if node --test --test-concurrency 1 $tests >/tmp/mut-out.$$ 2>&1; then
    echo "SURVIVED: $name"
  else
    echo "KILLED: $name"
  fi
  cp /tmp/mut-orig.$$ "$file"
  npm run build >/dev/null 2>&1
}

T="test/change-direction-review.test.ts test/tier-scoped-verdicts.test.ts test/superseded-terms.test.ts"

run_mutation "the direction never refutes the label" src/change-direction.ts \
  'if (direction !== "unchanged" && direction !== "widened") return false;' \
  'return false;' "$T"

run_mutation "a widened reading still rates the tier" src/change-direction.ts \
  'if (direction !== "unchanged" && direction !== "widened") return false;' \
  'if (direction !== "unchanged") return false;' "$T"

run_mutation "a reading that restates the terms still rates the tier" src/change-direction.ts \
  'if (direction !== "unchanged" && direction !== "widened") return false;' \
  'if (direction !== "widened") return false;' "$T"

run_mutation "the direction withdraws a favourable verdict too" src/change-direction.ts \
  '  return narrowsTheStoredTerms(change.change_type);
}' \
  '  return true;
}' "$T"

run_mutation "the tier rule is dropped from the rating" src/change-tier.ts \
  '  if (readingDescribesNoNarrowing(change)) return false;
  return changeGradesTheListedTier(change, offer);' \
  '  return !readingDescribesNoNarrowing(change);' "$T"

run_mutation "the direction is dropped from the rating" src/change-tier.ts \
  '  if (readingDescribesNoNarrowing(change)) return false;
  return changeGradesTheListedTier(change, offer);' \
  '  return changeGradesTheListedTier(change, offer);' "$T"

run_mutation "the review overrides a record that states its own direction" src/change-direction-review.ts \
  '    if (isTierDirection(change.tier_direction)) return change;' \
  '' "$T"

run_mutation "the review reaches nothing" src/change-direction-review.ts \
  '    return reviewed ? { ...change, tier_direction: reviewed.tier_direction } : change;' \
  '    return change;' "$T"

run_mutation "the review key ignores the record date" src/change-direction-review.ts \
  '    record.date,
    (record.source_url ?? "").trim(),' \
  '    (record.source_url ?? "").trim(),' "$T"

run_mutation "the review key ignores the source" src/change-direction-review.ts \
  '    record.date,
    (record.source_url ?? "").trim(),' \
  '    record.date,' "$T"

run_mutation "any word is read as a direction" src/change-direction-review.ts \
  '  return typeof value === "string" && TIER_DIRECTIONS.includes(value);' \
  '  return typeof value === "string" && value.length > 0;' "$T"

run_mutation "an entry outside the vocabulary is loaded" src/change-direction-review.ts \
  '    directions: review.directions.filter((entry) => isTierDirection(entry?.tier_direction)),' \
  '    directions: review.directions,' "$T"

run_mutation "a malformed review file throws" src/change-direction-review.ts \
  '  if (!fs.existsSync(filePath)) return empty;' \
  '' "$T"

run_mutation "the catalogue is loaded without the review" src/data.ts \
  'applyReviewedDirections(data.changes.map(withResolutionInSummary))' \
  'data.changes.map(withResolutionInSummary)' "$T"

run_mutation "the detector's direction is stored unchecked" scripts/change-log.js \
  'TIER_DIRECTIONS.includes(result.tier_direction) ? result.tier_direction : null' \
  'result.tier_direction ?? null' "$T"

run_mutation "the detector's direction is discarded" scripts/change-log.js \
  '      ...(directionRead ? { tier_direction: directionRead } : {}),
' \
  '' "$T"

run_mutation "the reader is not asked for the direction" scripts/verify-freshness.js \
  '"tier_direction":"<narrowed|unchanged|widened>",' \
  '' "$T"
