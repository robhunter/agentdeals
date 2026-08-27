import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function pageReviewsPath(): string {
  return process.env.AGENTDEALS_PAGE_REVIEWS_PATH || path.join(__dirname, "..", "data", "page-reviews.json");
}

export type ReviewTier = "A" | "B";

export const SLA_DAYS: Record<ReviewTier, number> = { A: 30, B: 90 };

export const TIER_RULE: Record<ReviewTier, string> = {
  A: "page carries a hand-written verdict, winner badge or stat card that names a vendor",
  B: "hand-written prose that names no winner",
};

export const EXPIRY_MULTIPLE = 2;

export type ReviewState = "current" | "overdue" | "expired" | "never_reviewed";

export interface PageReviewRecord {
  path: string;
  published: string;
  tier: ReviewTier;
  vendors_asserted: string[];
  badge_subjects_unresolved: string[];
  reviewed_at: string | null;
  reviewer: string | null;
}

export interface PageReviewIndex {
  version: number;
  sla_days: Record<ReviewTier, number>;
  pages: PageReviewRecord[];
}

export interface ReviewStatus {
  path: string;
  tier: ReviewTier;
  sla_days: number;
  published: string;
  reviewed_at: string | null;
  clock_starts: string;
  days_since: number;
  days_overdue: number;
  state: ReviewState;
  vendors_asserted: string[];
  badge_subjects_unresolved: string[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isReviewDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function normalizeRecord(raw: any): PageReviewRecord | null {
  if (!raw || typeof raw.path !== "string" || !raw.path.startsWith("/")) return null;
  if (!isReviewDate(raw.published)) return null;
  const tier: ReviewTier = raw.tier === "A" ? "A" : "B";
  return {
    path: raw.path,
    published: raw.published,
    tier,
    vendors_asserted: Array.isArray(raw.vendors_asserted) ? raw.vendors_asserted.filter((s: unknown) => typeof s === "string") : [],
    badge_subjects_unresolved: Array.isArray(raw.badge_subjects_unresolved) ? raw.badge_subjects_unresolved.filter((s: unknown) => typeof s === "string") : [],
    reviewed_at: isReviewDate(raw.reviewed_at) ? raw.reviewed_at : null,
    reviewer: typeof raw.reviewer === "string" && raw.reviewer ? raw.reviewer : null,
  };
}

export function parsePageReviews(text: string): PageReviewIndex {
  const empty: PageReviewIndex = { version: 1, sla_days: { ...SLA_DAYS }, pages: [] };
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!raw || !Array.isArray(raw.pages)) return empty;
  const pages: PageReviewRecord[] = [];
  const seen = new Set<string>();
  for (const entry of raw.pages) {
    const record = normalizeRecord(entry);
    if (!record || seen.has(record.path)) continue;
    seen.add(record.path);
    pages.push(record);
  }
  return { version: typeof raw.version === "number" ? raw.version : 1, sla_days: { ...SLA_DAYS }, pages };
}

let cached: PageReviewIndex | null = null;
let cachedFrom = "";

export function loadPageReviews(): PageReviewIndex {
  const file = pageReviewsPath();
  if (cached && cachedFrom === file) return cached;
  let index: PageReviewIndex;
  try {
    index = parsePageReviews(fs.readFileSync(file, "utf-8"));
  } catch {
    index = { version: 1, sla_days: { ...SLA_DAYS }, pages: [] };
  }
  cached = index;
  cachedFrom = file;
  return index;
}

export function resetPageReviewsCache(): void {
  cached = null;
  cachedFrom = "";
}

export function getPageReview(pagePath: string): PageReviewRecord | null {
  return loadPageReviews().pages.find(p => p.path === pagePath) ?? null;
}

export function reviewStatus(record: PageReviewRecord, today: string): ReviewStatus {
  const sla = SLA_DAYS[record.tier];
  const reviewedAt = record.reviewed_at !== null && record.reviewed_at <= today ? record.reviewed_at : null;
  const clockStarts = reviewedAt ?? record.published;
  const daysSince = Math.max(0, daysBetween(clockStarts, today));
  const overdue = Math.max(0, daysSince - sla);
  let state: ReviewState;
  if (reviewedAt === null) state = "never_reviewed";
  else if (daysSince > sla * EXPIRY_MULTIPLE) state = "expired";
  else if (daysSince > sla) state = "overdue";
  else state = "current";
  return {
    path: record.path,
    tier: record.tier,
    sla_days: sla,
    published: record.published,
    reviewed_at: reviewedAt,
    clock_starts: clockStarts,
    days_since: daysSince,
    days_overdue: overdue,
    state,
    vendors_asserted: record.vendors_asserted,
    badge_subjects_unresolved: record.badge_subjects_unresolved,
  };
}

const SEPARATOR = " &middot; ";

export function freshnessSegmentFor(record: PageReviewRecord | null, today: string): string {
  if (!record) return "";
  const status = reviewStatus(record, today);
  if (status.state === "never_reviewed") return `${SEPARATOR}Not yet reviewed`;
  if (status.state === "expired") return "";
  return `${SEPARATOR}Reviewed ${status.reviewed_at}`;
}

export function pageFreshness(pagePath: string, today = utcToday()): string {
  return freshnessSegmentFor(getPageReview(pagePath), today);
}

export function freshnessSentenceFor(record: PageReviewRecord | null, today: string): string {
  const segment = freshnessSegmentFor(record, today);
  return segment ? ` ${segment.slice(SEPARATOR.length)}.` : "";
}

export function pageFreshnessSentence(pagePath: string, today = utcToday()): string {
  return freshnessSentenceFor(getPageReview(pagePath), today);
}

export function pageDateModified(pagePath: string, fallbackPublished: string, today = utcToday()): string {
  const record = getPageReview(pagePath);
  if (!record) return fallbackPublished;
  return reviewStatus(record, today).reviewed_at ?? record.published;
}

export function pagePublished(pagePath: string, fallbackPublished: string): string {
  return getPageReview(pagePath)?.published ?? fallbackPublished;
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface OutdatedVerdict {
  slug: string;
  changed: string;
}

export function verdictsOutdatedBy(status: ReviewStatus, changeDateFor: (slug: string) => string | null): OutdatedVerdict[] {
  const out: OutdatedVerdict[] = [];
  for (const slug of status.vendors_asserted) {
    const changed = changeDateFor(slug);
    if (changed && changed > status.clock_starts) out.push({ slug, changed });
  }
  return out.sort((a, b) => b.changed.localeCompare(a.changed) || a.slug.localeCompare(b.slug));
}

export interface OverdueReport {
  generated_for: string;
  sla_days: Record<ReviewTier, number>;
  tier_rule: Record<ReviewTier, string>;
  expiry_multiple: number;
  totals: { pages: number; current: number; overdue: number; expired: number; never_reviewed: number };
  pages: ReviewStatus[];
}

export function overdueReport(today: string, index: PageReviewIndex = loadPageReviews()): OverdueReport {
  const pages = index.pages
    .map(p => reviewStatus(p, today))
    .sort((a, b) => b.days_overdue - a.days_overdue || a.path.localeCompare(b.path));
  const totals = { pages: pages.length, current: 0, overdue: 0, expired: 0, never_reviewed: 0 };
  for (const p of pages) totals[p.state] += 1;
  return {
    generated_for: today,
    sla_days: { ...SLA_DAYS },
    tier_rule: { ...TIER_RULE },
    expiry_multiple: EXPIRY_MULTIPLE,
    totals,
    pages,
  };
}

const VERDICT_BLOCK_CLASSES = ["summary-stats", "executive-summary", "verdict-box", "pick-header"];
const VERDICT_INLINE_CLASSES = ["winner-badge", "pick-badge"];

export function verdictBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const cls of VERDICT_BLOCK_CLASSES) {
    const open = new RegExp(`<(div|p|section)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, "g");
    let m: RegExpExecArray | null;
    while ((m = open.exec(html)) !== null) {
      const body = extractBalanced(html, m.index, m[1]);
      if (body) blocks.push(body);
    }
  }
  for (const cls of VERDICT_INLINE_CLASSES) {
    if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(html)) {
      const rows = html.match(new RegExp(`<(?:h[1-6]|td|div|li)[^>]*>[^<]*<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>[^<]*</span>`, "g"));
      if (rows) blocks.push(...rows);
    }
  }
  return blocks;
}

const BADGE_SPAN = /<span\b[^>]*class="[^"]*\b(?:winner-badge|pick-badge)\b[^"]*"[^>]*>([^<]*)<\/span>/g;
const VENDOR_ANCHOR_BEFORE = /<a\b[^>]*href="\/vendor\/([a-z0-9][a-z0-9-]*)"[^>]*>([^<]*)<\/a>\s*$/;
const VENDOR_ANCHOR_AFTER = /^\s*<a\b[^>]*href="\/vendor\/([a-z0-9][a-z0-9-]*)"[^>]*>([^<]*)<\/a>/;
const NAMED_ELEMENT_AFTER = /^\s*<(span|strong|b|em|a)\b[^>]*>([^<]+)<\/\1>/;

export interface BadgedSubject {
  subject: string;
  badge: string;
  linkedSlug: string | null;
}

function collapseEntities(raw: string): string {
  return raw.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function badgedSubjects(html: string): BadgedSubject[] {
  const found: BadgedSubject[] = [];
  const scan = new RegExp(BADGE_SPAN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html)) !== null) {
    const badge = collapseEntities(m[1]);
    const before = html.slice(0, m.index);
    const linkedBefore = before.match(VENDOR_ANCHOR_BEFORE);
    if (linkedBefore) {
      found.push({ subject: collapseEntities(linkedBefore[2]), badge, linkedSlug: linkedBefore[1] });
      continue;
    }
    const tagEnd = before.lastIndexOf(">");
    const preceding = collapseEntities(tagEnd >= 0 ? before.slice(tagEnd + 1) : before);
    if (preceding) {
      found.push({ subject: preceding, badge, linkedSlug: null });
      continue;
    }
    const after = html.slice(m.index + m[0].length);
    const linkedAfter = after.match(VENDOR_ANCHOR_AFTER);
    if (linkedAfter) {
      found.push({ subject: collapseEntities(linkedAfter[2]), badge, linkedSlug: linkedAfter[1] });
      continue;
    }
    const namedAfter = after.match(NAMED_ELEMENT_AFTER);
    found.push({ subject: namedAfter ? collapseEntities(namedAfter[2]) : "", badge, linkedSlug: null });
  }
  return found;
}

export type SubjectVendorLookup = (phrase: string) => string[];

export interface UnresolvedBadge {
  subject: string;
  badges: string[];
}

export interface SubjectResolver {
  slugsFor: SubjectVendorLookup;
  isNonVendor: (phrase: string) => boolean;
}

export function unresolvedBadgeSubjects(html: string, resolver: SubjectResolver): UnresolvedBadge[] {
  const byName = new Map<string, Set<string>>();
  for (const { subject, badge, linkedSlug } of badgedSubjects(html)) {
    if (linkedSlug) continue;
    if (subject && resolver.isNonVendor(subject)) continue;
    if (subject && resolver.slugsFor(subject).length > 0) continue;
    const badges = byName.get(subject) ?? new Set<string>();
    badges.add(badge);
    byName.set(subject, badges);
  }
  return [...byName.entries()]
    .map(([subject, badges]) => ({ subject, badges: [...badges].sort() }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function extractBalanced(html: string, openIndex: number, tag: string): string | null {
  const openTag = new RegExp(`<${tag}\\b`, "g");
  const closeTag = new RegExp(`</${tag}>`, "g");
  let depth = 0;
  let cursor = openIndex;
  const limit = html.length;
  while (cursor < limit) {
    openTag.lastIndex = cursor;
    closeTag.lastIndex = cursor;
    const nextOpen = openTag.exec(html);
    const nextClose = closeTag.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + 1;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return html.slice(openIndex, cursor);
  }
  return null;
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

export type VendorSlugLookup = (text: string) => string | null;

export const NAMED_VENDOR_MAX_CHARS = 40;

function candidateName(raw: string): string | null {
  const text = raw.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  if (!text || text.length > NAMED_VENDOR_MAX_CHARS) return null;
  if (/[:;.!?]$/.test(text)) return null;
  if (!/[A-Za-z]/.test(text)) return null;
  return text;
}

const EMPHASIS_ELEMENT = /<(strong|b|em)\b[^>]*>([^<]+)<\/\1>/g;
const STAT_NUMBER_ELEMENT = /<(div|span)\b[^>]*class="[^"]*\bstat-number\b[^"]*"[^>]*>([^<]+)<\/\1>/g;
const BADGED_SUBJECT = /<(?:h[1-6]|td|li|div)\b[^>]*>([^<]+)<span\b[^>]*class="[^"]*\b(?:winner-badge|pick-badge)\b[^"]*"[^>]*>/g;

const NAMING_PATTERNS = [EMPHASIS_ELEMENT, STAT_NUMBER_ELEMENT, BADGED_SUBJECT];

function namedSubjects(fragment: string): string[] {
  const names: string[] = [];
  for (const pattern of NAMING_PATTERNS) {
    const scan = new RegExp(pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = scan.exec(fragment)) !== null) {
      const name = candidateName(m[m.length - 1]);
      if (name) names.push(name);
    }
  }
  return names;
}

const VENDOR_HREF = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"/g;

export function vendorSlugsLinkedIn(fragment: string): string[] {
  const slugs = new Set<string>();
  const scan = new RegExp(VENDOR_HREF.source, "g");
  let m: RegExpExecArray | null;
  while ((m = scan.exec(fragment)) !== null) slugs.add(m[1]);
  return [...slugs];
}

export interface VendorLookup {
  slugForPhrase: VendorSlugLookup;
  slugsForSubject: SubjectVendorLookup;
  nameForSlug: (slug: string) => string | null;
}

function namesLinkedOnPage(html: string, lookup: VendorLookup): Array<{ slug: string; name: string }> {
  const named: Array<{ slug: string; name: string }> = [];
  for (const slug of vendorSlugsLinkedIn(html)) {
    const name = lookup.nameForSlug(slug);
    if (name && name.length >= 3) named.push({ slug, name });
  }
  return named;
}

export function vendorsAssertedIn(html: string, lookup: VendorLookup): string[] {
  const found = new Set<string>();
  const blocks = verdictBlocks(html);
  const linkedOnPage = namesLinkedOnPage(html, lookup);
  for (const block of blocks) {
    for (const slug of vendorSlugsLinkedIn(block)) found.add(slug);
    for (const name of namedSubjects(block)) {
      for (const slug of lookup.slugsForSubject(name)) found.add(slug);
    }
    const text = stripTags(block);
    for (const { slug, name } of linkedOnPage) {
      if (found.has(slug)) continue;
      if (new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}([^A-Za-z0-9]|$)`).test(text)) found.add(slug);
    }
  }
  return [...found].sort();
}

export function deriveTier(html: string): ReviewTier {
  return verdictBlocks(html).length > 0 ? "A" : "B";
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LINKIFY_BLOCK_CLASSES = ["summary-stats", "executive-summary"];
const LINKIFY_PATTERNS = [EMPHASIS_ELEMENT, STAT_NUMBER_ELEMENT];

export function linkifyVerdictBlocks(html: string, slugFor: VendorSlugLookup): string {
  let out = html;
  for (const cls of LINKIFY_BLOCK_CLASSES) {
    const open = new RegExp(`<(div|p|section)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, "g");
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = open.exec(out)) !== null) {
      const block = extractBalanced(out, m.index, m[1]);
      if (!block) continue;
      const linked = linkNamedSubjects(block, slugFor);
      if (linked !== block) replacements.push({ start: m.index, end: m.index + block.length, text: linked });
      open.lastIndex = m.index + block.length;
    }
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      out = out.slice(0, r.start) + r.text + out.slice(r.end);
    }
  }
  return out;
}

function linkNamedSubjects(fragment: string, slugFor: VendorSlugLookup): string {
  let out = fragment;
  for (const pattern of LINKIFY_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "g"), (whole, _tag, inner) => {
      const name = candidateName(inner);
      if (!name) return whole;
      const slug = slugFor(name);
      if (!slug) return whole;
      const openEnd = whole.indexOf(">") + 1;
      const closeStart = whole.lastIndexOf("</");
      if (openEnd <= 0 || closeStart <= openEnd) return whole;
      return `${whole.slice(0, openEnd)}<a href="/vendor/${slug}">${whole.slice(openEnd, closeStart)}</a>${whole.slice(closeStart)}`;
    });
  }
  return out;
}
