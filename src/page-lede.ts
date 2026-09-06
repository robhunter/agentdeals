export const PAGE_HEAD_OPEN = '<div class="page-head">';
export const PAGE_CLAIM_OPEN = '<p class="page-claim">';
const PAGE_CLAIM_CLOSE = "</p>";

export function metaDescriptionOf(html: string): string {
  return html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? "";
}

export function pageClaimOf(html: string): string | null {
  const claimAt = html.indexOf(PAGE_CLAIM_OPEN);
  if (claimAt === -1) return null;
  const from = claimAt + PAGE_CLAIM_OPEN.length;
  const to = html.indexOf(PAGE_CLAIM_CLOSE, from);
  return to === -1 ? null : html.slice(from, to);
}

export function withLedeBeforeNav(html: string): string {
  const headAt = html.indexOf(PAGE_HEAD_OPEN);
  if (headAt === -1) return html;

  const insertAt = headAt + PAGE_HEAD_OPEN.length;
  if (html.startsWith(PAGE_CLAIM_OPEN, insertAt)) return html;

  const description = metaDescriptionOf(html);
  if (!description.trim()) return html;

  return html.slice(0, insertAt)
    + PAGE_CLAIM_OPEN + description + PAGE_CLAIM_CLOSE
    + html.slice(insertAt);
}
