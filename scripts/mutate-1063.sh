#!/bin/bash
set -u
cd "$(dirname "$0")/.." || exit 1

TESTS="test/badge-subjects-resolve.test.ts test/page-freshness.test.ts"

run_case() {
  local name="$1" file="$2" from="$3" to="$4"
  cp "$file" /tmp/mut-backup
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
n = s.count(old)
if n != 1:
    print(f"PATTERN-MISS ({n})")
    sys.exit(3)
open(path, "w").write(s.replace(old, new))
PY
  if [ $? -eq 3 ]; then cp /tmp/mut-backup "$file"; echo "SKIP    $name (pattern not found exactly once)"; return; fi
  if ! npm run build > /tmp/mut-build.log 2>&1; then
    cp /tmp/mut-backup "$file"
    echo "KILLED  $name (build)"
    return
  fi
  node --test $TESTS > /tmp/mut-test.log 2>&1
  local code=$?
  cp /tmp/mut-backup "$file"
  if [ $code -ne 0 ]; then
    echo "KILLED  $name  <- $(grep -m1 '✖ ' /tmp/mut-test.log | sed 's/^ *//')"
  else
    echo "SURVIVED $name"
  fi
}

run_case "alias map ignored" src/vendor-slug.ts \
  '  const alias = SUBJECT_ALIASES[toSlug(phrase)];' \
  '  const alias = undefined as string | undefined;'

run_case "trailing qualifier not stripped" src/vendor-slug.ts \
  '  const qualified = phrase.match(TRAILING_QUALIFIER);' \
  '  const qualified = null as RegExpMatchArray | null;'

run_case "compound accepts a part with no record" src/vendor-slug.ts \
  '    if (resolved.every(r => r.length > 0)) return [...new Set(resolved.flat())];' \
  '    if (resolved.some(r => r.length > 0)) return [...new Set(resolved.flat())];'

run_case "compound never split" src/vendor-slug.ts \
  '  const parts = phrase.split(SUBJECT_SEPARATOR).map(p => p.trim()).filter(Boolean);' \
  '  const parts = [phrase];'

run_case "badge before name not read" src/page-reviews.ts \
  '    const linkedAfter = after.match(VENDOR_ANCHOR_AFTER);' \
  '    const linkedAfter = null as RegExpMatchArray | null;'

run_case "unlinked name after badge not read" src/page-reviews.ts \
  '    const namedAfter = after.match(NAMED_ELEMENT_AFTER);' \
  '    const namedAfter = null as RegExpMatchArray | null;'

run_case "name before badge not read" src/page-reviews.ts \
  '    const tagEnd = before.lastIndexOf(">");' \
  '    const tagEnd = -1;'

run_case "every subject treated as exempt" src/page-reviews.ts \
  '    if (subject && resolver.isNonVendor(subject)) continue;' \
  '    if (subject) continue;'

run_case "linked subjects never checked" src/page-reviews.ts \
  '    if (linkedSlug) continue;' \
  '    if (linkedSlug !== null || true) continue;'

run_case "registry field dropped on parse" src/page-reviews.ts \
  '    badge_subjects_unresolved: Array.isArray(raw.badge_subjects_unresolved) ? raw.badge_subjects_unresolved.filter((s: unknown) => typeof s === "string") : [],' \
  '    badge_subjects_unresolved: [],'

run_case "review status drops the field" src/page-reviews.ts \
  '    badge_subjects_unresolved: record.badge_subjects_unresolved,' \
  '    badge_subjects_unresolved: [] as string[],'

run_case "SES keeps its winner badge" src/serve.ts \
  '        <td class="provider-col">Amazon SES<span class="removed-badge">FREE REMOVED</span></td>' \
  '        <td class="provider-col">Amazon SES<span class="winner-badge">MOST VOLUME</span></td>'

run_case "SES free volume claim restored" src/serve.ts \
  '<strong>Amazon SES</strong> is the cheapest at volume at $0.10 per 1,000 emails, but it no longer has a free tier' \
  '<strong>Amazon SES</strong> offers the highest free volume at 62,000 emails/month when sent from EC2'

run_case "Storj called the most generous free tier again" src/serve.ts \
  '      <strong>Largest trial capacity &rarr; Storj</strong>' \
  '      <strong>Most generous free tier overall &rarr; Storj</strong>'

run_case "Storj free-storage cell drops the time limit" src/serve.ts \
  '        <td>25 GB for 30 days</td>' \
  '        <td>25 GB</td>'

run_case "API stops reporting unresolved subjects" src/serve.ts \
  '        unresolved_badge_subjects: [...new Set(pages.flatMap(p => p.badge_subjects_unresolved))].sort(),' \
  '        unresolved_badge_subjects: undefined,'

run_case "Storj marked permanently free again" src/serve.ts \
  '        <td class="cross">&#10007;</td>
        <td>$0.007/GB</td>' \
  '        <td class="check">&#10003;</td>
        <td>$0.007/GB</td>'

run_case "Grafana verdict names the wrong record" src/serve.ts \
  '<div class="stat-number green">Grafana Cloud</div><div class="stat-label">Best Overall Free Tier</div>' \
  '<div class="stat-number green">Grafana</div><div class="stat-label">Best Overall Free Tier</div>'

echo "--- rebuilding clean ---"
npm run build > /tmp/mut-build.log 2>&1 && echo "build ok" || echo "BUILD FAILED"
