import { CITATION_LINK_HTML, RECORD_SOURCE_CLASS, UNCITED_TAG_CLASS, citationLabel } from "./change-citation.js";
import { FREE_TIER_STANDING_LABELS } from "./risk-scorecard.js";
import {
  passedWithoutQuotingThePage,
  termsUnconfirmedOutcome,
  unconfirmedTermsClause,
} from "./source-check.js";
import type { Offer } from "./types.js";

export type Escaper = (text: string) => string;

export interface ReadSource {
  url: string;
  quote?: string | null;
}

export interface ReadClauseOptions {
  dateClass: string;
  rel?: string;
  linkText?: (url: string) => string;
}

export function readClauseHtml(
  readOn: string,
  sources: readonly ReadSource[],
  esc: Escaper,
  options: ReadClauseOptions,
): string {
  if (sources.length === 0) return "";
  const rel = options.rel ?? "nofollow noopener";
  const linkText = options.linkText ?? ((url: string) => url);
  const provenance = sources
    .map(source => {
      const link = `<a href="${esc(source.url)}" rel="${rel}">${esc(linkText(source.url))}</a>`;
      return source.quote
        ? `${link}, where it says: &ldquo;${esc(source.quote)}&rdquo;`
        : link;
    })
    .join(" and from ");
  return (
    `We read that on <span class="${options.dateClass}" style="font-family:var(--mono)">${esc(readOn)}</span>` +
    ` from ${provenance}`
  );
}

export interface SourceRead {
  cited: true;
  url: string;
  readOn: string;
  quote: string | null;
}

export interface SourceMissing {
  cited: false;
  clause: string;
}

export type FreeTierSource = SourceRead | SourceMissing;

export const NO_CATALOGUE_RECORD = FREE_TIER_STANDING_LABELS.not_in_catalogue;

export type SourcedOffer = Pick<Offer, "url" | "source_check" | "verifiedDate">;

export function freeTierSourceOf(offer: SourcedOffer | null | undefined): FreeTierSource {
  if (!offer) return { cited: false, clause: NO_CATALOGUE_RECORD };
  const check = offer.source_check;
  const unconfirmed = termsUnconfirmedOutcome(check?.outcome);
  if (unconfirmed) return { cited: false, clause: unconfirmedTermsClause(unconfirmed) };
  const url = (offer.url ?? "").trim();
  if (!check || !url) return { cited: false, clause: NO_CATALOGUE_RECORD };
  return {
    cited: true,
    url,
    readOn: check.checked,
    quote: passedWithoutQuotingThePage(offer) ? null : check.detail,
  };
}

export interface CitedService {
  vendor: string;
  slug: string | null;
  source: FreeTierSource;
}

export function sourceAnchorId(service: Pick<CitedService, "vendor" | "slug">): string {
  return `source-${service.slug ?? service.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

const MARKER_STYLE = "font-size:.75rem;color:var(--text-dim);margin-left:.35rem";

export function citedSourceLinkHtml(read: SourceRead, esc: Escaper): string {
  const title = `${citationLabel(read.url)} — ${read.readOn}`;
  return (
    ` <a href="${esc(read.url)}" rel="nofollow noopener" class="${RECORD_SOURCE_CLASS}"` +
    ` style="${MARKER_STYLE}" title="${esc(title)}">${CITATION_LINK_HTML}</a>`
  );
}

const UNCITED_TAG_STYLE =
  "display:inline-block;margin-left:.35rem;padding:.1rem .4rem;border-radius:10px;" +
  "font-size:.65rem;font-weight:600;background:#8b949e22;color:#8b949e";

export function uncitedSourceTagHtml(missing: SourceMissing, esc: Escaper, label: string): string {
  return (
    ` <span class="${UNCITED_TAG_CLASS}" style="${UNCITED_TAG_STYLE}"` +
    ` title="${esc(missing.clause)}">${esc(label)}</span>`
  );
}

export function uncitedSourceLinkHtml(
  service: CitedService & { source: SourceMissing },
  esc: Escaper,
  label: string,
): string {
  return (
    ` <a href="#${esc(sourceAnchorId(service))}" class="${UNCITED_TAG_CLASS}" style="${UNCITED_TAG_STYLE}"` +
    ` title="${esc(service.source.clause)}">${esc(label)}</a>`
  );
}

export function sourceMarkerHtml(
  source: FreeTierSource,
  esc: Escaper,
  uncitedLabel: string,
): string {
  return source.cited
    ? citedSourceLinkHtml(source, esc)
    : uncitedSourceTagHtml(source, esc, uncitedLabel);
}

export const CITED_SOURCES_CLASS = "cited-sources";

export function citedSourcesListHtml(
  services: readonly CitedService[],
  esc: Escaper,
  dateClass: string,
): string {
  if (services.length === 0) return "";
  const items = services
    .map(service => {
      const name = service.slug
        ? `<a href="/vendor/${esc(service.slug)}">${esc(service.vendor)}</a>`
        : esc(service.vendor);
      const body = service.source.cited
        ? readClauseHtml(
            service.source.readOn,
            [{ url: service.source.url, quote: service.source.quote }],
            esc,
            { dateClass, linkText: citationLabel },
          )
        : esc(service.source.clause);
      return `<li id="${esc(sourceAnchorId(service))}">${name} &mdash; ${body}</li>`;
    })
    .join("\n      ");
  return (
    `<ul class="${CITED_SOURCES_CLASS}" style="margin:1rem 0 0 1.1rem;padding:0;font-size:.85rem;line-height:1.7">\n` +
    `      ${items}\n    </ul>`
  );
}

const METHODOLOGY_OPEN = /<div\b[^>]*class="[^"]*\bmethodology\b[^"]*"[^>]*>/;
const DIV_TAG = /<div\b[^>]*>|<\/div>/g;
const DATA_SOURCE_HEADING = /<h2\b[^>]*\bid="data-source"/;

export function methodologyBlockEnd(html: string): number | null {
  const heading = DATA_SOURCE_HEADING.exec(html);
  const from = heading ? heading.index : 0;
  const open = METHODOLOGY_OPEN.exec(html.slice(from));
  if (!open) return null;
  const openStart = from + open.index;
  const tags = new RegExp(DIV_TAG.source, "g");
  tags.lastIndex = openStart + open[0].length;
  let depth = 1;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    depth += tag[0] === "</div>" ? -1 : 1;
    if (depth === 0) return tag.index;
  }
  return null;
}

export function withCitedSources(html: string, listHtml: string): string {
  if (listHtml === "") return html;
  const end = methodologyBlockEnd(html);
  if (end === null) return html;
  return `${html.slice(0, end)}\n    ${listHtml}${html.slice(end)}`;
}
