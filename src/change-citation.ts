export interface CitableChange {
  source_url?: string | null;
}

export interface SummarisedChange extends CitableChange {
  summary?: string | null;
}

export function changeCitesASource(change: CitableChange): boolean {
  return typeof change.source_url === "string" && change.source_url.trim() !== "";
}

export function changeIsUncited(change: CitableChange): boolean {
  return !changeCitesASource(change);
}

export function citedChanges<T extends CitableChange>(changes: readonly T[]): T[] {
  return changes.filter(changeCitesASource);
}

export function uncitedChanges<T extends CitableChange>(changes: readonly T[]): T[] {
  return changes.filter(changeIsUncited);
}

export function citationLabel(url: string): string {
  const trimmed = (url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const withinHost = `${parsed.pathname}${parsed.search}`.replace(/\/+$/, "");
  return `${host}${withinHost}`;
}

export const CITATION_CLASS = "change-source";

export const CITATION_LINK_HTML = "Source &nearr;";

const CITATION_STYLE = "font-size:.75rem;color:var(--text-dim)";

export function changeSourceLinkHtml(change: CitableChange, esc: (text: string) => string): string {
  if (!changeCitesASource(change)) return "";
  const url = change.source_url!.trim();
  return (
    `<a href="${esc(url)}" target="_blank" rel="noopener" class="${CITATION_CLASS}"` +
    ` style="${CITATION_STYLE}" title="${esc(citationLabel(url))}">${CITATION_LINK_HTML}</a>`
  );
}

export function changeSourceCitation(change: CitableChange): { "@type": string; url: string; name: string } | null {
  if (!changeCitesASource(change)) return null;
  const url = change.source_url!.trim();
  return { "@type": "WebPage", url, name: citationLabel(url) };
}

export const UNCITED_CHANGE_LABEL = "Unsourced";

export function uncitedChangeNotice(vendor: string): string {
  return `We hold no source for this record, so it does not set ${vendor}'s rating.`;
}

export function ratingWithheldForNoSourceSentence(vendor: string): string {
  return `The only record that would rate ${vendor} cites no source, so we are not publishing a rating for it.`;
}

export function ratingWithheldForNoSourceClause(): string {
  return "the only record that would rate it cites no source";
}

const DOCUMENT_NOUN =
  "(?:home\\s?page|web\\s?site|source\\s+page|pricing\\s+page|deal\\s+page|landing\\s+page|blog\\s+post"
  + "|page|site|domain|url|link|blog)";

const STILL_THE_SAME_SUBJECT =
  "(?:\\s+(?:is|are|was|were|now|currently|itself|also)|\\s+appears?(?:\\s+to\\s+be)?|\\s+seems?(?:\\s+to\\s+be)?)*";

const CANNOT_BE_READ =
  "(?:\\s+no\\s+longer\\s+(?:accessible|available|resolves|resolving|reachable|loads|exists|online|live)"
  + "|\\s+not\\s+(?:accessible|reachable|available|resolving)"
  + "|\\s+(?:inaccessible|unreachable|dead|gone|down|offline|missing)\\b"
  + "|\\s+does\\s+not\\s+resolve|\\s+fails\\s+to\\s+resolve|\\s+stopped\\s+resolving"
  + "|\\s+returns?\\s+(?:HTTP\\s+)?[45]\\d\\d"
  + "|\\s+[45]\\d\\d(?:s\\b|\\s+errors?\\b|\\b))";

const UNREADABLE_DOCUMENT = new RegExp(DOCUMENT_NOUN + STILL_THE_SAME_SUBJECT + CANNOT_BE_READ, "gi");

const A_DIFFERENT_DOCUMENT = /(?:old|previous|former|legacy|archived|original)\s+$/i;

const HOST_IN_PROSE = /\b(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}\b/gi;

const SENTENCE_BREAK = /(?<=[.!?])\s+/;

function bareHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

function citedHost(change: CitableChange): string | null {
  if (!changeCitesASource(change)) return null;
  try {
    return bareHost(new URL(change.source_url!.trim()).hostname);
  } catch {
    return null;
  }
}

export function summaryCallsItsSourceUnreadable(change: SummarisedChange): string | null {
  const host = citedHost(change);
  if (host === null) return null;
  for (const sentence of (change.summary ?? "").split(SENTENCE_BREAK)) {
    const hosts = (sentence.match(HOST_IN_PROSE) ?? []).map(bareHost);
    if (hosts.length > 0 && !hosts.includes(host)) continue;
    for (const claim of sentence.matchAll(UNREADABLE_DOCUMENT)) {
      if (A_DIFFERENT_DOCUMENT.test(sentence.slice(Math.max(0, claim.index - 12), claim.index))) continue;
      return claim[0].trim();
    }
  }
  return null;
}

export function citesAPageItCallsUnreadable(change: SummarisedChange): boolean {
  return summaryCallsItsSourceUnreadable(change) !== null;
}

export function changesCitingAPageTheyCallUnreadable<T extends SummarisedChange>(changes: readonly T[]): T[] {
  return changes.filter(citesAPageItCallsUnreadable);
}
