import { CITATION_LINK_HTML, RECORD_SOURCE_CLASS, UNCITED_TAG_CLASS, citationLabel } from "./change-citation.js";
import { FREE_TIER_STANDING_LABELS } from "./risk-scorecard.js";
import {
  checkFinding,
  termsUnconfirmedOutcome,
  unconfirmedTermsClause,
} from "./source-check.js";
import { ENDED_OFFER_CLAUSE, offerRetired } from "./retirement.js";
import type { Offer } from "./types.js";

export type Escaper = (text: string) => string;

export const PAGE_QUOTE_CLASS = "page-quote";

export const CHECK_FINDING_CLASS = "check-finding";

export const CHECK_FINDING_LEAD = "our check recorded";

export const CHECK_ESTABLISHES =
  "A source check reads the cited page for the service's name and a price; the limits above are from our own record.";

export const CHECK_ESTABLISHES_ON_A_LIST =
  "A source check reads each cited page for that service's name and a price; the figures in the tables above are from our own records.";

export const CHECK_ESTABLISHES_ON_THE_REST_OF_A_LIST =
  "A source check reads each cited page for that service's name and a price."
  + " The figures in the tables above are from our own records, except for the services"
  + " whose entry below dates them to a read of the vendor's own page.";

export function pageQuoteHtml(quote: string, esc: Escaper): string {
  return `<span class="${PAGE_QUOTE_CLASS}">where it says: &ldquo;${esc(quote)}&rdquo;</span>`;
}

export function checkFindingHtml(finding: string, esc: Escaper): string {
  return `<span class="${CHECK_FINDING_CLASS}">${CHECK_FINDING_LEAD}: ${esc(finding)}</span>`;
}

export interface ReadSource {
  url: string;
  quote?: string | null;
  finding?: string | null;
}

export interface ReadClauseOptions {
  dateClass: string;
  rel?: string;
  linkText?: (url: string) => string;
}

function attributionHtml(source: ReadSource, esc: Escaper): string {
  if (source.quote) return `, ${pageQuoteHtml(source.quote, esc)}`;
  if (source.finding) return `, and ${checkFindingHtml(source.finding, esc)}`;
  return "";
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
      const link = `<a href="${esc(source.url)}" rel="${rel}" class="${RECORD_SOURCE_CLASS}">${esc(linkText(source.url))}</a>`;
      return `${link}${attributionHtml(source, esc)}`;
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
  finding: string | null;
}

export type MissingSourceKind = "ended" | "unconfirmed" | "no_record";

export interface SourceMissing {
  cited: false;
  kind: MissingSourceKind;
  clause: string;
}

export type FreeTierSource = SourceRead | SourceMissing;

export const NO_CATALOGUE_RECORD = FREE_TIER_STANDING_LABELS.not_in_catalogue;

export const MISSING_SOURCE_LABELS: Record<MissingSourceKind, string> = {
  ended: "Ended",
  unconfirmed: "Unconfirmed",
  no_record: "No record",
};

export function missingSourceLabel(missing: SourceMissing): string {
  return MISSING_SOURCE_LABELS[missing.kind];
}

export const NO_CATALOGUE_RECORD_SOURCE: SourceMissing = {
  cited: false,
  kind: "no_record",
  clause: NO_CATALOGUE_RECORD,
};

export type SourcedOffer = Pick<Offer, "url" | "tier" | "source_check" | "verifiedDate">;

export function freeTierSourceOf(offer: SourcedOffer | null | undefined): FreeTierSource {
  if (!offer) return NO_CATALOGUE_RECORD_SOURCE;
  if (offerRetired(offer)) return { cited: false, kind: "ended", clause: ENDED_OFFER_CLAUSE };
  const check = offer.source_check;
  const unconfirmed = termsUnconfirmedOutcome(check?.outcome);
  if (unconfirmed) {
    return { cited: false, kind: "unconfirmed", clause: unconfirmedTermsClause(unconfirmed) };
  }
  const url = (offer.url ?? "").trim();
  if (!check || !url) return NO_CATALOGUE_RECORD_SOURCE;
  return {
    cited: true,
    url,
    readOn: check.checked,
    finding: checkFinding(offer),
  };
}

export function freeTierSourceWeMayCite(
  offer: SourcedOffer | null | undefined,
  termsWeCannotConfirm: { clause: string } | null,
): FreeTierSource {
  const source = freeTierSourceOf(offer);
  if (!source.cited || !termsWeCannotConfirm) return source;
  return { cited: false, kind: "unconfirmed", clause: termsWeCannotConfirm.clause };
}

export interface CitedService {
  vendor: string;
  slug: string | null;
  source: FreeTierSource;
  termsCameFrom?: string | null;
}

export function servicesWhoseFiguresAreOurOwn(
  services: readonly CitedService[],
): readonly CitedService[] {
  return services.filter(service => !service.termsCameFrom);
}

export function citedSourcesScopeNote(services: readonly CitedService[]): string | null {
  const ourOwn = servicesWhoseFiguresAreOurOwn(services);
  if (ourOwn.length === 0) return null;
  return ourOwn.length === services.length
    ? CHECK_ESTABLISHES_ON_A_LIST
    : CHECK_ESTABLISHES_ON_THE_REST_OF_A_LIST;
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

export const FIGURE_SOURCE_CLASS = "figure-source";

export function figureSourceLinkHtml(url: string, esc: Escaper): string {
  return (
    ` <a href="${esc(url)}" rel="nofollow noopener" class="${FIGURE_SOURCE_CLASS}"` +
    ` style="${MARKER_STYLE}" title="${esc(citationLabel(url))}">${CITATION_LINK_HTML}</a>`
  );
}

const UNCITED_TAG_STYLE =
  "display:inline-block;margin-left:.35rem;padding:.1rem .4rem;border-radius:10px;" +
  "font-size:.65rem;font-weight:600;background:#8b949e22;color:#8b949e";

export function uncitedSourceTagHtml(missing: SourceMissing, esc: Escaper): string {
  return (
    ` <span class="${UNCITED_TAG_CLASS}" style="${UNCITED_TAG_STYLE}"` +
    ` title="${esc(missing.clause)}">${esc(missingSourceLabel(missing))}</span>`
  );
}

export function uncitedSourceLinkHtml(
  service: CitedService & { source: SourceMissing },
  esc: Escaper,
): string {
  return (
    ` <a href="#${esc(sourceAnchorId(service))}" class="${UNCITED_TAG_CLASS}" style="${UNCITED_TAG_STYLE}"` +
    ` title="${esc(service.source.clause)}">${esc(missingSourceLabel(service.source))}</a>`
  );
}

export function serviceSourceMarkerHtml(service: CitedService, esc: Escaper): string {
  return service.source.cited
    ? citedSourceLinkHtml(service.source, esc)
    : uncitedSourceLinkHtml({ ...service, source: service.source }, esc);
}

export const CITED_SOURCES_CLASS = "cited-sources";

export const CHECK_SCOPE_CLASS = "check-scope";

export const TERMS_CAME_FROM_CLASS = "terms-came-from";

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
            [{ url: service.source.url, finding: service.source.finding }],
            esc,
            { dateClass, linkText: citationLabel },
          )
        : esc(service.source.clause);
      const cameFrom = service.termsCameFrom
        ? `. <span class="${TERMS_CAME_FROM_CLASS}">${esc(service.termsCameFrom)}</span>`
        : "";
      return `<li id="${esc(sourceAnchorId(service))}">${name} &mdash; ${body}${cameFrom}</li>`;
    })
    .join("\n      ");
  const scope = citedSourcesScopeNote(services);
  const scopeHtml = scope === null
    ? ""
    : `<p class="${CHECK_SCOPE_CLASS}" style="margin:1rem 0 0;font-size:.8rem;color:var(--text-dim)">${esc(scope)}</p>\n    `;
  return (
    `${scopeHtml}` +
    `<ul class="${CITED_SOURCES_CLASS}" style="margin:.5rem 0 0 1.1rem;padding:0;font-size:.85rem;line-height:1.7">\n` +
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
