import { ENDED_OFFER_CLAUSE, offerRetired } from "./retirement.js";
import { toSlug } from "./slug.js";
import type { Offer } from "./types.js";

export type EndedRecord = { vendor: string; tier: string; slug: string };

export type EndedIndex = {
  bySlug: Map<string, EndedRecord>;
  byLongestName: EndedRecord[];
};

export function endedIndex(offers: Pick<Offer, "vendor" | "tier">[]): EndedIndex {
  const bySlug = new Map<string, EndedRecord>();
  for (const offer of offers) {
    if (!offerRetired(offer)) continue;
    const slug = toSlug(offer.vendor);
    if (!bySlug.has(slug)) bySlug.set(slug, { vendor: offer.vendor, tier: offer.tier, slug });
  }
  const byLongestName = [...bySlug.values()].sort((a, b) => b.vendor.length - a.vendor.length);
  return { bySlug, byLongestName };
}

export function endedRowStatement(tier: string): string {
  return `${tier} — ${ENDED_OFFER_CLAUSE}, so there is no free tier to compare.`;
}

const ROW = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
const CELL = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi;
const VENDOR_HREF = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"/i;
const ALREADY_SAYS = /\b(?:retired|deprecated|discontinued|sunset|withdrawn|no longer|has ended|the offer has ended)\b/i;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markEndedVendorRows(html: string, ended: EndedIndex): string {
  if (ended.bySlug.size === 0) return html;
  return html.replace(ROW, row => {
    const cells = row.match(CELL);
    if (!cells || cells.length < 2) return row;
    const slug = VENDOR_HREF.exec(cells[0])?.[1];
    if (!slug) return row;
    const record = ended.bySlug.get(slug);
    if (!record) return row;
    if (ALREADY_SAYS.test(row)) return row;
    const statement = `<td colspan="${cells.length - 1}" class="ended-row-note">${escapeHtml(endedRowStatement(record.tier))}</td>`;
    const head = row.slice(0, row.indexOf(cells[0]) + cells[0].length);
    const tail = row.slice(row.lastIndexOf(cells[cells.length - 1]) + cells[cells.length - 1].length);
    return `${head}${statement}${tail}`;
  });
}

function dropName(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`,\\s*(?:and\\s+)?${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*,\\s*`),
    new RegExp(`\\s+and\\s+${escaped}\\b`),
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) return text.replace(pattern, "");
  }
  return text;
}

export function dropEndedFromNameList(text: string, ended: EndedIndex): string {
  let out = text;
  for (const record of ended.byLongestName) {
    if (!out.includes(record.vendor)) continue;
    out = dropName(out, record.vendor);
  }
  return out;
}
