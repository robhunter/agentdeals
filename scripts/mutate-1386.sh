#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/superseded-terms.test.ts
  test/gated-vendor-answers.test.ts
)

SOURCES=(src/superseded-description.ts src/change-citation.ts src/unrendered-text.ts src/serve.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1386"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1386" "$f"; done; }

backup
trap 'restore; npm run build >/dev/null 2>&1' EXIT

killed=0
survived=0

run_mutation() {
  local name="$1"; shift
  restore
  if ! "$@"; then
    echo "NOT APPLIED                $name"
    return
  fi
  if ! npm run build >/dev/null 2>&1; then
    echo "KILLED (does not compile)  $name"
    killed=$((killed + 1))
    return
  fi
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1386-out.txt 2>&1; then
    echo "SURVIVED                   $name"
    survived=$((survived + 1))
  else
    echo "KILLED                     $name"
    killed=$((killed + 1))
  fi
}

sub() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if old not in text:
    sys.exit("mutation target not found in " + path)
open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
PY
}

run_mutation "a record that read nothing still publishes a reading" \
  sub src/superseded-description.ts 'if (terms === "" || carriesAnUnrenderedExpression(terms)) return null;' \
                                    'if (carriesAnUnrenderedExpression(terms)) return null;'

run_mutation "a record that cites nothing still publishes a reading" \
  sub src/superseded-description.ts '  if (!changeCitesASource(change)) return null;
' ''

run_mutation "a reading the vendor's page never rendered is published" \
  sub src/superseded-description.ts 'if (terms === "" || carriesAnUnrenderedExpression(terms)) return null;' \
                                    'if (terms === "") return null;'

run_mutation "nothing is ever read as unrendered" \
  sub src/unrendered-text.ts '  const subject = text ?? "";' '  const subject = String(text ?? "").slice(0, 0);'

run_mutation "a client-side template is read as rendered text" \
  sub src/unrendered-text.ts '  /\{\{[\s\S]*?\}\}|\{\{[^\n]*/,
' ''

run_mutation "a template whose closer a clip cut off is read as rendered text" \
  sub src/unrendered-text.ts '/\{\{[\s\S]*?\}\}|\{\{[^\n]*/' '/\{\{[\s\S]*?\}\}/'

run_mutation "a template literal is read as rendered text" \
  sub src/unrendered-text.ts '  /\$\{[\s\S]*?\}|\$\{[^\n]*/,
' ''

run_mutation "a server-side template is read as rendered text" \
  sub src/unrendered-text.ts '  /<%[\s\S]*?%>|<%[^\n]*/,
' ''

run_mutation "a stringified object is read as rendered text" \
  sub src/unrendered-text.ts '  /\[object Object\]/,
' ''

run_mutation "a value that never arrived is read as rendered text" \
  sub src/unrendered-text.ts '  /\bundefined\b/,
' ''

run_mutation "a calculation that failed is read as rendered text" \
  sub src/unrendered-text.ts '  /\bNaN\b/,
' ''

run_mutation "the refusal cannot name what it refused" \
  sub src/unrendered-text.ts '    if (found) return found[0];' '    if (found) return pattern.source;'

run_mutation "the reading is dated by the change rather than by the day it was recorded" \
  sub src/superseded-description.ts 'date: (change.recorded_date ?? "").trim() || change.date,' 'date: change.date,'

run_mutation "the reading is dated by recorded_date even when the record carries none" \
  sub src/superseded-description.ts 'date: (change.recorded_date ?? "").trim() || change.date,' \
                                    'date: (change.recorded_date ?? "").trim(),'

run_mutation "the citation prints the whole URL rather than what a reader can place" \
  sub src/change-citation.ts '  const host = parsed.hostname.replace(/^www\./, "");' \
                             '  const host = parsed.host; return trimmed;'

run_mutation "the citation keeps the www a reader does not need" \
  sub src/change-citation.ts 'parsed.hostname.replace(/^www\./, "")' 'parsed.hostname'

run_mutation "the citation names only the host, so two pricing pages read alike" \
  sub src/change-citation.ts 'return `${host}${withinHost}`;' 'return host;'

run_mutation "the citation keeps the trailing slash it strips" \
  sub src/change-citation.ts '.replace(/\/+$/, "");' ';'

run_mutation "an unparseable source is dropped instead of printed as stored" \
  sub src/change-citation.ts '    return trimmed;' '    return "";'

run_mutation "the opening is clipped mid-word" \
  sub src/superseded-description.ts '  const kept = lastSpace > cap / 2 ? clipped.slice(0, lastSpace) : clipped;' \
                                    '  const kept = clipped;'

run_mutation "a clipped opening is not marked as clipped" \
  sub src/superseded-description.ts 'return `${kept.replace(/[,;:]$/, "")}…`;' 'return kept.replace(/[,;:]$/, "");'

run_mutation "the cap is ignored and every surface prints the whole reading" \
  sub src/superseded-description.ts '  if (text.length <= cap) return text;' '  return text;'

run_mutation "the opening cuts at the cap rather than at a sentence" \
  sub src/superseded-description.ts '    if (candidate.length > cap) break;' '    if (candidate.length > cap) continue;'

run_mutation "the reading runs into the sentence after it with no stop" \
  sub src/superseded-description.ts 'return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;' 'return trimmed;'

run_mutation "the notice goes back to refusing without the reading" \
  sub src/superseded-description.ts '    readingWithTail(vendor, change) ??
    `${withheldTail(vendor, change, false)} We have not re-read' \
                                    '    null ??
    `${withheldTail(vendor, change, false)} We have not re-read'

run_mutation "the answer goes back to refusing without the reading" \
  sub src/superseded-description.ts '    readingWithTail(vendor, change) ??
    `We are not answering that' \
                                    '    null ??
    `We are not answering that'

run_mutation "the answer drops what our own record says changed" \
  sub src/superseded-description.ts 'return `${opening} What our record says changed: ${change.summary}`;' 'return opening;'

run_mutation "the meta description goes back to refusing without the reading" \
  sub src/superseded-description.ts '  const reading = readingBehindTheChange(change);
  if (!reading) {' \
                                    '  const reading = null;
  if (!reading) {'

run_mutation "the verdict goes back to refusing without the reading" \
  sub src/superseded-description.ts 'return readingWithTail(vendor, change, 170) ?? withheldTail(vendor, change, false);' \
                                    'return withheldTail(vendor, change, false);'

run_mutation "the withholding sentence stops saying our own record supersedes the terms" \
  sub src/superseded-description.ts '`our own pricing change record, ${changeDateClause(change)}, ${STORED_TERMS_WITHHELD_PHRASE}.`' \
                                    '`our own pricing change record supersedes them.`'

run_mutation "the description block prints the source as text with no link" \
  sub src/superseded-description.ts '  const link =
    `<a href="${esc(reading.url)}" target="_blank" rel="noopener" class="change-source">` +
    `${esc(reading.label)}</a>`;' \
                                    '  const link = esc(reading.label);'

run_mutation "the href is not escaped" \
  sub src/superseded-description.ts '`<a href="${esc(reading.url)}" target="_blank" rel="noopener" class="change-source">`' \
                                    '`<a href="${reading.url}" target="_blank" rel="noopener" class="change-source">`'

run_mutation "the terms are not escaped before going into the page" \
  sub src/superseded-description.ts '${readingSentence(esc(reading.date), link, esc(punctuated(reading.terms)))} ' \
                                    '${readingSentence(esc(reading.date), link, punctuated(reading.terms))} '

run_mutation "the description block escapes the notice whole, so the link never renders" \
  sub src/serve.ts '${supersededTermsNoticeHtml(vendorName, termsSuperseded, escHtmlServer)}' \
                   '${escHtmlServer(supersededTermsNotice(vendorName, termsSuperseded))}'

echo
echo "killed $killed, survived $survived"
