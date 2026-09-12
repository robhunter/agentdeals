import { freshnessSegmentFor, getPageReview, utcToday, type PageReviewRecord } from "./page-reviews.js";

export const BYLINE_CLASS = "pub-date";

const PUBLISHED_DATE = /(<(?:p|div)\b[^>]*>)(Published \d{4}-\d{2}-\d{2})/g;

const TITLE_CLOSE = "</h1>";

function insideScript(html: string, at: number): boolean {
  const before = html.slice(0, at);
  return before.split("<script").length !== before.split("</script>").length;
}

function firstOutsideScript(html: string, find: string): number {
  let from = 0;
  for (;;) {
    const at = html.indexOf(find, from);
    if (at === -1) return -1;
    if (!insideScript(html, at)) return at;
    from = at + find.length;
  }
}

export function publishedDateEndsAt(html: string): number {
  PUBLISHED_DATE.lastIndex = 0;
  for (let match = PUBLISHED_DATE.exec(html); match !== null; match = PUBLISHED_DATE.exec(html)) {
    if (!insideScript(html, match.index)) return match.index + match[0].length;
  }
  return -1;
}

export function bylineFor(record: PageReviewRecord, segment: string): string {
  return `<p class="${BYLINE_CLASS}">Published ${record.published}${segment}</p>`;
}

export function acceptsAByline(html: string): boolean {
  return publishedDateEndsAt(html) !== -1 || firstOutsideScript(html, TITLE_CLOSE) !== -1;
}

export function withReviewByline(
  html: string,
  pagePath: string,
  today: string = utcToday(),
  reviewFor: (pagePath: string) => PageReviewRecord | null = getPageReview,
): string {
  const record = reviewFor(pagePath);
  if (record === null) return html;
  const segment = freshnessSegmentFor(record, today);

  const publishedEndsAt = publishedDateEndsAt(html);
  if (publishedEndsAt !== -1) {
    if (segment === "" || html.startsWith(segment, publishedEndsAt)) return html;
    return html.slice(0, publishedEndsAt) + segment + html.slice(publishedEndsAt);
  }

  const titleAt = firstOutsideScript(html, TITLE_CLOSE);
  if (titleAt === -1) return html;
  const at = titleAt + TITLE_CLOSE.length;
  return html.slice(0, at) + bylineFor(record, segment) + html.slice(at);
}
