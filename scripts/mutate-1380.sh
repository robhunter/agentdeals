#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TESTS=(
  test/change-log-citation.test.ts
)

SOURCES=(src/serve.ts src/change-citation.ts)

backup() { for f in "${SOURCES[@]}"; do cp "$f" "/tmp/$(basename "$f").m1380"; done; }
restore() { for f in "${SOURCES[@]}"; do cp "/tmp/$(basename "$f").m1380" "$f"; done; }

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
  if TZ=UTC node --test --test-concurrency 1 "${TESTS[@]}" >/tmp/mutation-1380-out.txt 2>&1; then
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

run_mutation "the citation link is never rendered" \
  sub src/change-citation.ts '  if (!changeCitesASource(change)) return "";
  const url = change.source_url!.trim();
  return (
    `<a href="${esc(url)}"' \
                   '  if (!changeCitesASource(change)) return "";
  if (changeCitesASource(change)) return "";
  const url = change.source_url!.trim();
  return (
    `<a href="${esc(url)}"'

run_mutation "a record with no source gets a link to nowhere" \
  sub src/change-citation.ts 'export function changeSourceLinkHtml(change: CitableChange, esc: (text: string) => string): string {
  if (!changeCitesASource(change)) return "";
  const url = change.source_url!.trim();' \
                   'export function changeSourceLinkHtml(change: CitableChange, esc: (text: string) => string): string {
  const url = (change.source_url ?? "").trim();'

run_mutation "the citation loses the class that marks it as a citation" \
  sub src/change-citation.ts ' class="${CITATION_CLASS}"' \
                   ''

run_mutation "the citation loses the title naming the page" \
  sub src/change-citation.ts ' title="${esc(citationLabel(url))}">${CITATION_LINK_HTML}' \
                   '>${CITATION_LINK_HTML}'

run_mutation "the title repeats the URL instead of the page" \
  sub src/change-citation.ts 'title="${esc(citationLabel(url))}"' \
                   'title="${esc(url)}"'

run_mutation "the label keeps the www host prefix" \
  sub src/change-citation.ts 'const host = parsed.hostname.replace(/^www\./, "");' \
                   'const host = parsed.hostname;'

run_mutation "a whitespace source counts as a source" \
  sub src/change-citation.ts 'return typeof change.source_url === "string" && change.source_url.trim() !== "";' \
                   'return typeof change.source_url === "string";'

run_mutation "the structured citation is never built" \
  sub src/change-citation.ts 'export function changeSourceCitation(change: CitableChange): { "@type": string; url: string; name: string } | null {
  if (!changeCitesASource(change)) return null;' \
                   'export function changeSourceCitation(change: CitableChange): { "@type": string; url: string; name: string } | null {
  if (true) return null;
  if (!changeCitesASource(change)) return null;'

run_mutation "the structured citation is built for a record with no source" \
  sub src/change-citation.ts '  if (!changeCitesASource(change)) return null;
  const url = change.source_url!.trim();
  return { "@type": "WebPage", url, name: citationLabel(url) };' \
                   '  const url = (change.source_url ?? "").trim();
  return { "@type": "WebPage", url, name: citationLabel(url) };'

run_mutation "the structured citation names the wrong kind of thing" \
  sub src/change-citation.ts 'return { "@type": "WebPage", url, name: citationLabel(url) };' \
                   'return { "@type": "CreativeWork", url, name: citationLabel(url) };'

run_mutation "the structured citation labels itself with the URL" \
  sub src/change-citation.ts 'return { "@type": "WebPage", url, name: citationLabel(url) };' \
                   'return { "@type": "WebPage", url, name: url };'

run_mutation "the timeline stops citing anything" \
  sub src/serve.ts '${altHtml}
          ${changeSourceLinkHtml(c, escHtmlServer)}
        </div>
      </div>`;
  }

  const upcomingCount = sorted.filter(c => c.date >= today).length;
  const removedCount = sorted.filter' \
                   '${altHtml}
        </div>
      </div>`;
  }

  const upcomingCount = sorted.filter(c => c.date >= today).length;
  const removedCount = sorted.filter'

run_mutation "the change timeline stops citing anything" \
  sub src/serve.ts '${altHtml}
          ${changeSourceLinkHtml(c, escHtmlServer)}
        </div>
      </div>`;
  }

  const upcomingCount = sorted.filter(c => c.date >= today).length;
  const removedCount = allChanges.filter' \
                   '${altHtml}
        </div>
      </div>`;
  }

  const upcomingCount = sorted.filter(c => c.date >= today).length;
  const removedCount = allChanges.filter'

run_mutation "the change timeline stops saying when it holds no source" \
  sub src/serve.ts '          <div class="chg-summary">${escHtmlServer(c.summary)}</div>
          ${changeIsUncited(c) ? unsourcedNoteHtml(c.vendor) : ""}' \
                   '          <div class="chg-summary">${escHtmlServer(c.summary)}</div>'

run_mutation "the change timeline drops the tag on an unsourced entry" \
  sub src/serve.ts '            <span class="chg-impact" style="color:${impactColor}">${c.impact}</span>
            ${changeIsUncited(c) ? unsourcedTagHtml() : ""}' \
                   '            <span class="chg-impact" style="color:${impactColor}">${c.impact}</span>'

run_mutation "the machine-readable list drops the citation" \
  sub src/serve.ts '          ...(citation ? { citation } : {}),' \
                   ''

run_mutation "the machine-readable list carries an empty citation" \
  sub src/serve.ts '          ...(citation ? { citation } : {}),' \
                   '          citation: citation as any,'

run_mutation "the quarterly report links to nowhere again" \
  sub src/serve.ts '      ${changeIsUncited(c) ? unsourcedNoteHtml(c.vendor) : changeSourceLinkHtml(c, escHtmlServer)}' \
                   '      <a href="${escHtmlServer(c.source_url)}" target="_blank" rel="noopener" class="change-source">Source &nearr;</a>'

run_mutation "the earlier quarterly report links to nowhere again" \
  sub src/serve.ts '      (changeIsUncited(c) ? unsourcedNoteHtml(c.vendor) : changeSourceLinkHtml(c, escHtmlServer)) +' \
                   '      "<a href=\"" + escHtmlServer(c.source_url) + "\" target=\"_blank\" rel=\"noopener\" class=\"change-source\">Source &nearr;</a>" +'

restore
npm run build >/dev/null 2>&1
echo
echo "killed:   $killed"
echo "survived: $survived"
