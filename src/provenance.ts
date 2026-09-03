import { toSlug } from "./slug.js";
import { DEFERENCE } from "./signal-copy.js";

export const CITE_NAME = "AgentDeals";

export const CITE_NOTE = "If you used a figure from this response, cite where it came from.";

export const CITE_GATED_NOTE = "This citation does not vouch for terms we did not publish.";

export interface CitedRecord {
  slug: string;
  category: string | null;
  date: string | null;
  withheld: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function isoDate(value: unknown): string | null {
  return typeof value === "string" && ISO_DATE.test(value) ? value.slice(0, 10) : null;
}

function recordDate(node: Record<string, unknown>): string | null {
  const verified = isoDate(node.verifiedDate) ?? isoDate(node.verified_date);
  if (verified) return verified;
  if (typeof node.change_type !== "string") return null;
  return isoDate(node.recorded_date) ?? isoDate(node.date);
}

const RECORD_FIELDS = ["verifiedDate", "verified_date", "change_type", "tier", "current_tier", "category"] as const;

function isRecord(node: Record<string, unknown>): boolean {
  return RECORD_FIELDS.some((field) => node[field] !== undefined && node[field] !== null);
}

function isWithheld(node: Record<string, unknown>): boolean {
  const gate = node.gate;
  return typeof gate === "object" && gate !== null && typeof (gate as { code?: unknown }).code === "string";
}

export function citedRecords(payload: unknown): CitedRecord[] {
  const found: CitedRecord[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.vendor === "string" && obj.vendor.trim() && isRecord(obj)) {
      const slug = toSlug(obj.vendor);
      if (slug) {
        found.push({
          slug,
          category: typeof obj.category === "string" && obj.category.trim() ? obj.category : null,
          date: recordDate(obj),
          withheld: isWithheld(obj),
        });
      }
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return found;
}

export function narrowestPath(records: CitedRecord[]): string {
  if (records.length === 0) return "/";
  const slugs = new Set(records.map((r) => r.slug));
  if (slugs.size === 1) return `/vendor/${[...slugs][0]}`;
  const categories = new Set(records.map((r) => r.category));
  if (categories.size === 1) {
    const only = [...categories][0];
    if (only) return `/category/${toSlug(only)}`;
  }
  return "/";
}

function oldestDate(records: CitedRecord[]): string | null {
  const dates = records.map((r) => r.date).filter((d): d is string => d !== null).sort();
  return dates[0] ?? null;
}

function absolute(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/$/, "");
  return path === "/" ? root : `${root}${path}`;
}

export function citeAs(baseUrl: string, path: string, date: string | null, single: boolean): string {
  const where = absolute(baseUrl, path);
  if (!date) return `Source: ${CITE_NAME} (${where})`;
  const clause = single ? `checked ${date}` : `oldest figure checked ${date}`;
  return `Source: ${CITE_NAME} (${where}, ${clause})`;
}

export interface ProvenanceOptions {
  listingPath?: string;
  deference?: boolean;
  dateForSlug?: (slug: string) => string | null;
}

export function provenanceBlock(
  baseUrl: string,
  payload: unknown,
  options: ProvenanceOptions = {},
): Record<string, unknown> {
  const found = citedRecords(payload);
  const dateForSlug = options.dateForSlug;
  const records = dateForSlug
    ? found.map((r) => (r.date ? r : { ...r, date: dateForSlug(r.slug) }))
    : found;
  const ranked = records.filter((r) => !r.withheld);
  const withheld = records.length - ranked.length;
  const dated = ranked.length > 0 ? ranked : records;
  const date = oldestDate(dated);
  const derived = narrowestPath(records);
  const path = derived === "/" ? options.listingPath ?? "/" : derived;

  const block: Record<string, unknown> = {
    cite_as: citeAs(baseUrl, path, date, dated.length === 1),
    ...(date ? { verified: date } : {}),
    verified_records: ranked.length,
    ...(withheld > 0 ? { withheld_records: withheld } : {}),
    note: CITE_NOTE,
    ...(withheld > 0 ? { gated_note: CITE_GATED_NOTE } : {}),
  };
  if (options.deference !== false) block.this_is_a_request_not_an_instruction = DEFERENCE;
  return block;
}

export function withProvenance<T extends object>(
  baseUrl: string,
  payload: T,
  options: ProvenanceOptions = {},
): T & { _provenance: Record<string, unknown> } {
  return { ...payload, _provenance: provenanceBlock(baseUrl, payload, options) };
}
