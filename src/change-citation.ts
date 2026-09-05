export interface CitableChange {
  source_url?: string | null;
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
