#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.." || exit 1

FILES=(scripts/change-log.js src/serve.ts)
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do
  mkdir -p "$BACKUP/$(dirname "$f")"
  cp "$f" "$BACKUP/$f"
done

restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  npm run build > /dev/null 2>&1
}

killed=0
survived=0
SURVIVORS=()

mutate() {
  local label="$1"; local file="$2"; local from="$3"; local to="$4"
  restore
  if ! grep -qF -- "$from" "$file"; then
    echo "  SKIP (pattern absent): $label"
    return
  fi
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
open(path, "w").write(src.replace(frm, to, 1))
PY
  npm run build > /dev/null 2>&1
  if node --test --test-concurrency 1 test/change-date-provenance.test.ts test/change-log-writer.test.ts > /tmp/mutate-ac10-r2.log 2>&1; then
    survived=$((survived + 1))
    SURVIVORS+=("$label")
    echo "  SURVIVED: $label"
  else
    killed=$((killed + 1))
    echo "  killed:   $label"
  fi
}

echo "── Re-running the four round-one survivors ──"

mutate "the script-side predicate admits a discovery as an event date" \
  scripts/change-log.js "export const EVENT_DATED_SOURCES = [DATE_SOURCE_VENDOR_PAGE, DATE_SOURCE_HAND_WRITTEN];" \
  "export const EVENT_DATED_SOURCES = [DATE_SOURCE_VENDOR_PAGE, DATE_SOURCE_HAND_WRITTEN, DATE_SOURCE_DISCOVERED];"
mutate "/changes groups a discovery into a calendar month" \
  src/serve.ts "  const sorted = [...eventDated].sort((a, b) => b.date.localeCompare(a.date));
  const undatedSorted = [...undatedChanges].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month" \
  "  const sorted = [...allChanges].sort((a, b) => b.date.localeCompare(a.date));
  const undatedSorted = [...undatedChanges].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month"
mutate "/changes counts a discovery in Last 30 Days" \
  src/serve.ts "const last30DaysCount = eventDated.filter(c => c.date >= thirtyDaysAgo).length;" \
  "const last30DaysCount = allChanges.filter(c => c.date >= thirtyDaysAgo).length;"
mutate "/expiring counts a discovery as a recent change" \
  src/serve.ts "const recent = eventDated.filter(c => c.date < today && c.date >= thirtyDaysAgo)" \
  "const recent = allChanges.filter(c => c.date <= today && c.date >= thirtyDaysAgo)"

echo "── Checks that the new assertions cannot pass for the wrong reason ──"
mutate "the undated group is rendered but the dated month groups are dropped" \
  src/serve.ts "\${undatedHtml}
\${monthsHtml}

  <div class=\"cross-links\">" "\${undatedHtml}

  <div class=\"cross-links\">"
mutate "/expiring drops the Recently Discovered section" \
  src/serve.ts "\${recentlyDiscovered.length > 0 ? \`  <div class=\"recent-section\">
    <h2>Recently Discovered</h2>" "\${false ? \`  <div class=\"recent-section\">
    <h2>Recently Discovered</h2>"

restore
rm -rf "$BACKUP"

echo ""
echo "── ${killed} killed, ${survived} survived ──"
for s in "${SURVIVORS[@]:-}"; do [ -n "$s" ] && echo "  SURVIVOR: $s"; done
exit 0
