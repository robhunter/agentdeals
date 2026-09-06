import { assertedVendorSlugs, isNonVendorSubject, resolveVendorSlug, toSlug, vendorSlugMap } from "./vendor-slug.js";

export interface CompiledPageRecord {
  date: string;
  summary: string;
  dateClause?: string;
}

function recordDateClause(record: CompiledPageRecord): string {
  return record.dateClause ?? `on ${record.date}`;
}

export function recordsSinceCompiled<T extends { date: string }>(
  vendorChanges: readonly T[],
  compiledOn: string,
  servedOn: string,
): T[] {
  return vendorChanges
    .filter(change => change.date > compiledOn && change.date <= servedOn)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface CompiledFigureSubject {
  kind: "row" | "card";
  label: string;
  linkedSlug: string | null;
}

export interface CompiledFigureVerdict {
  slug: string;
  vendor: string;
  freeTierEnded: boolean;
  endedBy: CompiledPageRecord | null;
  since: readonly CompiledPageRecord[];
}

export type CompiledFigureLookup = (subject: CompiledFigureSubject) => CompiledFigureVerdict | null;

export interface CompiledFigureMarkupOptions {
  compiledOn: string;
  esc: (text: string) => string;
  shortDate: (isoDate: string) => string;
}

const TIMELINE_HEADING = /<h2\b[^>]*\bid="changes"/;
const PROVIDER_CELL = /<td\b[^>]*class="[^"]*\bprovider-col\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
const CARD_HEADING = /<div\b[^>]*class="[^"]*\bdiff-card\b[^"]*"[^>]*>\s*<h3\b[^>]*>([\s\S]*?)<\/h3>/g;
const CARD_DESCRIPTION = /<(div|p)\b[^>]*class="[^"]*\bdiff-desc\b[^"]*"[^>]*>[\s\S]*?<\/\1>/;
const VENDOR_LINK = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"/;
const DECORATION_SPAN = /<span\b[^>]*class="[^"]*\b(?:winner|caution|removed|pick)-badge\b[^"]*"[^>]*>[\s\S]*?<\/span>/g;
const ROW_CELL = /<td\b[^>]*>[\s\S]*?<\/td>/g;
const REMOVED_BADGE = /class="[^"]*\bremoved-badge\b[^"]*"/;
const RECORD_MARKER = /<a\b[^>]*href="\/vendor\/[a-z0-9-]+#changes"[^>]*>[\s\S]*?<\/a>/g;
const TRAILING_QUALIFIER = /^(.+?)\s*\([^()]*\)$/;
const SUBJECT_TAGLINE = /\s+[—–:]\s+/;
const TIMELINE_BODY = /(<h2\b[^>]*\bid="changes"(?:(?!<\/table>)[\s\S])*?<tbody>)([\s\S]*?)(<\/tbody>)/;

export function staticHalfOf(html: string): string {
  const timeline = TIMELINE_HEADING.exec(html);
  return timeline ? html.slice(0, timeline.index) : html;
}

function undecorated(fragment: string): string {
  return fragment.replace(RECORD_MARKER, " ").replace(DECORATION_SPAN, " ");
}

function plainText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#8217;/g, "’")
    .replace(/&mdash;/g, "—")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function subjectOfCardHeading(heading: string): string {
  const withoutTagline = heading.split(SUBJECT_TAGLINE)[0]!.trim();
  const qualified = withoutTagline.match(TRAILING_QUALIFIER);
  return (qualified ? qualified[1]! : withoutTagline).trim();
}

function subjectOfProviderCell(cell: string): string {
  const qualified = cell.match(TRAILING_QUALIFIER);
  return (qualified ? qualified[1]! : cell).trim();
}

interface DiscoveredSlot extends CompiledFigureSubject {
  start: number;
  end: number;
  inner: string;
  innerStart: number;
  alreadyStatesRemoval: boolean;
}

function discoverSlots(staticHtml: string): DiscoveredSlot[] {
  const slots: DiscoveredSlot[] = [];

  const cells = new RegExp(PROVIDER_CELL.source, "g");
  let cell: RegExpExecArray | null;
  while ((cell = cells.exec(staticHtml)) !== null) {
    const inner = cell[1]!;
    const linked = inner.match(VENDOR_LINK);
    slots.push({
      kind: "row",
      label: subjectOfProviderCell(plainText(undecorated(inner))),
      linkedSlug: linked ? linked[1]! : null,
      start: cell.index,
      end: cell.index + cell[0].length,
      inner,
      innerStart: cell.index + cell[0].indexOf(inner),
      alreadyStatesRemoval: REMOVED_BADGE.test(inner.replace(RECORD_MARKER, "")),
    });
  }

  const headings = new RegExp(CARD_HEADING.source, "g");
  let heading: RegExpExecArray | null;
  while ((heading = headings.exec(staticHtml)) !== null) {
    const inner = heading[1]!;
    const linked = inner.match(VENDOR_LINK);
    slots.push({
      kind: "card",
      label: subjectOfCardHeading(plainText(undecorated(inner))),
      linkedSlug: linked ? linked[1]! : null,
      start: heading.index,
      end: heading.index + heading[0].length,
      inner,
      innerStart: heading.index + heading[0].indexOf(inner),
      alreadyStatesRemoval: REMOVED_BADGE.test(inner.replace(RECORD_MARKER, "")),
    });
  }

  return slots.sort((a, b) => a.start - b.start);
}

export interface CompiledFigureSlot extends CompiledFigureSubject {
  markup: string;
}

export function compiledFigureSlots(html: string): CompiledFigureSlot[] {
  return discoverSlots(staticHalfOf(html)).map(({ kind, label, linkedSlug, inner }) => ({
    kind,
    label,
    linkedSlug,
    markup: inner,
  }));
}

export function vendorSubjectsOnCompiledPage(html: string): CompiledFigureSubject[] {
  return compiledFigureSlots(html).map(({ kind, label, linkedSlug }) => ({ kind, label, linkedSlug }));
}

const FREE_TIER_REMOVED_LABEL = "FREE REMOVED";

function endedBadgeHtml(verdict: CompiledFigureVerdict): string {
  return (
    ` <a href="/vendor/${verdict.slug}#changes" class="removed-badge"` +
    ` title="Our own change log records that the ${verdict.vendor} free tier has ended.">` +
    `${FREE_TIER_REMOVED_LABEL}</a>`
  );
}

const RECORDED_SINCE_STYLE =
  "display:inline-block;background:rgba(210,153,34,0.15);color:#d29922;font-size:.65rem;" +
  "font-weight:700;padding:.1rem .35rem;border-radius:4px;margin-left:.35rem;letter-spacing:.03em";

function recordedSinceBadgeHtml(
  verdict: CompiledFigureVerdict,
  options: CompiledFigureMarkupOptions,
): string {
  const latest = verdict.since[0]!;
  const count = verdict.since.length;
  const title =
    `We recorded ${count === 1 ? "a pricing change" : `${count} pricing changes`} for ${verdict.vendor} ` +
    `after this table was compiled on ${options.compiledOn}. The most recent, ${recordDateClause(latest)}: ${latest.summary}`;
  return (
    ` <a href="/vendor/${verdict.slug}#changes" style="${RECORDED_SINCE_STYLE}"` +
    ` title="${options.esc(title)}">CHANGED ${options.esc(options.shortDate(latest.date).toUpperCase())}</a>`
  );
}

const STRUCK_STYLE = "color:var(--text-dim);text-decoration:line-through";

function struck(inner: string): string {
  return `<span style="${STRUCK_STYLE}">${inner}</span>`;
}

function withEndedRowCells(row: string, providerCellEnd: number): string {
  const rest = row.slice(providerCellEnd);
  const cells = new RegExp(ROW_CELL.source, "g");
  return (
    row.slice(0, providerCellEnd) +
    rest.replace(cells, whole => {
      const openEnd = whole.indexOf(">") + 1;
      const closeStart = whole.lastIndexOf("</td>");
      const inner = whole.slice(openEnd, closeStart);
      if (inner.trim() === "") return whole;
      return `${whole.slice(0, openEnd)}${struck(inner)}${whole.slice(closeStart)}`;
    })
  );
}

function endedCardDescriptionHtml(
  verdict: CompiledFigureVerdict,
  options: CompiledFigureMarkupOptions,
  tag: string,
): string {
  const ending = verdict.endedBy;
  const recorded = ending
    ? `Our own pricing change record, ${options.esc(recordDateClause(ending))}, says: ${options.esc(ending.summary)}`
    : `Our own change log records that the ${options.esc(verdict.vendor)} free tier has ended.`;
  return (
    `<${tag} class="diff-desc"><strong>Free tier:</strong> none. ${recorded} ` +
    `<a href="/vendor/${verdict.slug}#changes">Read what we recorded &rarr;</a></${tag}>`
  );
}

export function markCompiledFigures(
  html: string,
  lookup: CompiledFigureLookup,
  options: CompiledFigureMarkupOptions,
): string {
  const staticHtml = staticHalfOf(html);
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const slot of discoverSlots(staticHtml)) {
    const verdict = lookup({ kind: slot.kind, label: slot.label, linkedSlug: slot.linkedSlug });
    if (!verdict) continue;
    if (!verdict.freeTierEnded && verdict.since.length === 0) continue;

    const badge = verdict.freeTierEnded
      ? endedBadgeHtml(verdict)
      : recordedSinceBadgeHtml(verdict, options);

    if (slot.kind === "card") {
      edits.push({ start: slot.innerStart + slot.inner.length, end: slot.innerStart + slot.inner.length, text: badge });
      if (!verdict.freeTierEnded || slot.alreadyStatesRemoval) continue;
      const description = CARD_DESCRIPTION.exec(staticHtml.slice(slot.end, slot.end + 6000));
      if (!description) continue;
      edits.push({
        start: slot.end + description.index,
        end: slot.end + description.index + description[0].length,
        text: endedCardDescriptionHtml(verdict, options, description[1]!),
      });
      continue;
    }

    const rowStart = staticHtml.lastIndexOf("<tr", slot.start);
    const rowEnd = staticHtml.indexOf("</tr>", slot.end);
    if (rowStart < 0 || rowEnd < 0) continue;
    const row = staticHtml.slice(rowStart, rowEnd + "</tr>".length);
    const cellEndInRow = slot.end - rowStart;
    const inner = slot.inner;
    const markedProvider = verdict.freeTierEnded
      ? struck(inner.replace(DECORATION_SPAN, "")) + badge
      : inner + badge;
    const withProvider =
      row.slice(0, slot.innerStart - rowStart) + markedProvider + row.slice(slot.innerStart - rowStart + inner.length);
    const shift = withProvider.length - row.length;
    edits.push({
      start: rowStart,
      end: rowEnd + "</tr>".length,
      text:
        verdict.freeTierEnded && !slot.alreadyStatesRemoval
          ? withEndedRowCells(withProvider, cellEndInRow + shift)
          : withProvider,
    });
  }

  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + html.slice(cursor);
}

export function vendorSlugForSubject(subject: CompiledFigureSubject): string | null {
  if (subject.linkedSlug && vendorSlugMap.has(subject.linkedSlug)) return subject.linkedSlug;
  if (isNonVendorSubject(subject.label)) return null;
  if (subject.kind === "card") return slugNamedByHeading(subject.label);
  const asserted = assertedVendorSlugs(subject.label);
  return asserted.length === 1 ? asserted[0]! : null;
}

function slugNamedByHeading(label: string): string | null {
  const slug = toSlug(label);
  if (!slug) return null;
  const resolution = resolveVendorSlug(slug);
  if (resolution.type === "exact") return resolution.slug;
  if (resolution.type === "redirect" && resolution.slug.startsWith(slug + "-")) return resolution.slug;
  return null;
}

export function vendorNameForSubject(subject: CompiledFigureSubject): string | null {
  const slug = vendorSlugForSubject(subject);
  return slug ? vendorSlugMap.get(slug) ?? null : null;
}

export function timelineRecordsFor<T extends { date: string }>(
  declaredScope: readonly T[],
  subjects: readonly CompiledFigureSubject[],
  changesForVendor: (vendor: string) => readonly T[],
  limit: number,
): T[] {
  const timeline = new Set<T>(declaredScope);
  for (const subject of subjects) {
    const vendor = vendorNameForSubject(subject);
    if (!vendor) continue;
    for (const change of changesForVendor(vendor)) timeline.add(change);
  }
  return [...timeline].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

export const COMPARED_SERVICES_PLACEHOLDER = '<span data-compared-services=""></span>';

export function comparedServicesOn(html: string): string[] {
  const named = new Set<string>();
  for (const slot of discoverSlots(staticHalfOf(html))) {
    if (slot.kind !== "row") continue;
    if (slot.label !== "") named.add(slot.label);
  }
  return [...named].sort();
}

export function fillComparedServicesCount(html: string): string {
  if (!html.includes(COMPARED_SERVICES_PLACEHOLDER)) return html;
  return html.split(COMPARED_SERVICES_PLACEHOLDER).join(String(comparedServicesOn(html).length));
}

export function replaceTimelineRows(html: string, rowsHtml: string): string {
  return html.replace(TIMELINE_BODY, (whole, open: string, _body: string, close: string) =>
    rowsHtml.trim() === "" ? whole : `${open}\n        ${rowsHtml}\n      ${close}`,
  );
}
