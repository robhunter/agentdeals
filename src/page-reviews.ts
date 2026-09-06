import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function pageReviewsPath(): string {
  return process.env.AGENTDEALS_PAGE_REVIEWS_PATH || path.join(__dirname, "..", "data", "page-reviews.json");
}

export const QUALITY_BUDGET_NAMES = [
  "stale_fact_pages",
  "unsourced_tier_a",
  "uncited_change_records",
  "source_checks_ok_without_quoted_evidence",
  "faq_answers",
  "faq_answers_stating_a_figure",
  "faq_answers_with_a_digit_but_no_figure",
  "records_with_superseded_terms",
  "vendor_pages_withholding_superseded_terms",
  "ungated_pages_withholding_superseded_terms",
] as const;

export type QualityBudgetName = (typeof QUALITY_BUDGET_NAMES)[number];

export const QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE: readonly QualityBudgetName[] = [
  "records_with_superseded_terms",
  "vendor_pages_withholding_superseded_terms",
  "ungated_pages_withholding_superseded_terms",
];

export function aDataRunMayRaise(name: QualityBudgetName): boolean {
  return QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE.includes(name);
}

export interface QualityBudgets {
  version: number;
  budgets: Record<QualityBudgetName, number>;
}

export function qualityBudgetsPath(): string {
  return (
    process.env.AGENTDEALS_QUALITY_BUDGETS_PATH ||
    path.join(__dirname, "..", "data", "quality_budgets.json")
  );
}

export function parseQualityBudgets(text: string, source: string): QualityBudgets {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`${source} is not an object`);
  const file = raw as { version?: unknown; budgets?: unknown };
  if (file.version !== 1) throw new Error(`${source} has version ${String(file.version)}, expected 1`);
  if (typeof file.budgets !== "object" || file.budgets === null) {
    throw new Error(`${source} carries no budgets object`);
  }
  const budgets = file.budgets as Record<string, unknown>;
  const known = new Set<string>(QUALITY_BUDGET_NAMES);
  const unread = Object.keys(budgets).filter(name => !known.has(name)).sort();
  if (unread.length > 0) {
    throw new Error(`${source} names ${unread.join(", ")}, which no budget in the code reads`);
  }
  const out = {} as Record<QualityBudgetName, number>;
  for (const name of QUALITY_BUDGET_NAMES) {
    const value = budgets[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${source} gives ${name} as ${JSON.stringify(value)}, expected a whole number`);
    }
    out[name] = value;
  }
  return { version: 1, budgets: out };
}

export function readQualityBudgets(file: string = qualityBudgetsPath()): QualityBudgets {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the quality budgets at ${file}: ${(err as Error).message}`);
  }
  return parseQualityBudgets(text, file);
}

export function qualityBudget(name: QualityBudgetName): number {
  return readQualityBudgets().budgets[name];
}

export function serializeQualityBudgets(budgets: QualityBudgets): string {
  const ordered = {} as Record<QualityBudgetName, number>;
  for (const name of QUALITY_BUDGET_NAMES) ordered[name] = budgets.budgets[name];
  return `${JSON.stringify({ version: budgets.version, budgets: ordered }, null, 2)}\n`;
}

export type ReviewTier = "A" | "B";

export const SLA_DAYS: Record<ReviewTier, number> = { A: 30, B: 90 };

export const TIER_RULE: Record<ReviewTier, string> = {
  A: "page carries a hand-written verdict, winner badge or stat card that names a vendor",
  B: "hand-written prose that names no winner",
};

export const EXPIRY_MULTIPLE = 2;

export type ReviewState = "current" | "overdue" | "expired" | "never_reviewed";

export type ReviewOutcome = "pass" | "fail";

export const REVIEW_OUTCOMES: ReviewOutcome[] = ["pass", "fail"];

export type PageDataSource = "catalogue" | "editorial" | "unsourced";

export const PAGE_DATA_SOURCES: PageDataSource[] = ["catalogue", "editorial", "unsourced"];

export const PAGE_DATA_SOURCE_RULE: Record<PageDataSource, string> = {
  catalogue: "renders fields from the catalogue, measured by perturbing it",
  editorial: "asserts no vendor facts of its own, and says why",
  unsourced: "asserts vendor facts that are literals in the page and reach no record",
};

export const UNSOURCED_TIER_A_BASELINE = qualityBudget("unsourced_tier_a");

export const STALE_FACT_PAGES_BASELINE = qualityBudget("stale_fact_pages");

export const UNCITED_CHANGE_RECORDS_BASELINE = qualityBudget("uncited_change_records");

export function lowerBudgetInstruction(name: string, to: number): string {
  const file = qualityBudgetsPath().split(path.sep).slice(-2).join("/");
  return `set ${name} to ${to} in ${file} — run npm run ratchet:budgets — so the slot cannot be reused`;
}

export interface PageReviewRecord {
  path: string;
  published: string;
  tier: ReviewTier;
  vendors_asserted: string[];
  vendors_tabulated: string[];
  badge_subjects_unresolved: string[];
  reviewed_at: string | null;
  reviewer: string | null;
  review_outcome: ReviewOutcome | null;
  review_note: string | null;
  reads_index: boolean;
  reads_changes: boolean;
  data_source: PageDataSource;
  data_source_reason: string | null;
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
  review_outcome: ReviewOutcome | null;
  review_note: string | null;
  vendors_asserted: string[];
  vendors_tabulated: string[];
  badge_subjects_unresolved: string[];
  reads_index: boolean;
  reads_changes: boolean;
  data_source: PageDataSource;
  data_source_reason: string | null;
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
  const reviewedAt = isReviewDate(raw.reviewed_at) ? raw.reviewed_at : null;
  return {
    path: raw.path,
    published: raw.published,
    tier,
    vendors_asserted: Array.isArray(raw.vendors_asserted) ? raw.vendors_asserted.filter((s: unknown) => typeof s === "string") : [],
    vendors_tabulated: Array.isArray(raw.vendors_tabulated) ? raw.vendors_tabulated.filter((s: unknown) => typeof s === "string") : [],
    badge_subjects_unresolved: Array.isArray(raw.badge_subjects_unresolved) ? raw.badge_subjects_unresolved.filter((s: unknown) => typeof s === "string") : [],
    reviewed_at: reviewedAt,
    reviewer: typeof raw.reviewer === "string" && raw.reviewer ? raw.reviewer : null,
    review_outcome: reviewedAt !== null && REVIEW_OUTCOMES.includes(raw.review_outcome) ? raw.review_outcome : null,
    review_note: reviewedAt !== null && typeof raw.review_note === "string" && raw.review_note.trim() ? raw.review_note.trim() : null,
    reads_index: raw.reads_index === true,
    reads_changes: raw.reads_changes === true,
    data_source: PAGE_DATA_SOURCES.includes(raw.data_source) ? raw.data_source : "unsourced",
    data_source_reason: typeof raw.data_source_reason === "string" && raw.data_source_reason.trim() ? raw.data_source_reason.trim() : null,
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
    review_outcome: reviewedAt === null ? null : record.review_outcome,
    review_note: reviewedAt === null ? null : record.review_note,
    vendors_asserted: record.vendors_asserted,
    vendors_tabulated: record.vendors_tabulated,
    badge_subjects_unresolved: record.badge_subjects_unresolved,
    reads_index: record.reads_index,
    reads_changes: record.reads_changes,
    data_source: record.data_source,
    data_source_reason: record.data_source_reason,
  };
}

const SEPARATOR = " &middot; ";

export function freshnessSegmentFor(record: PageReviewRecord | null, today: string): string {
  if (!record) return "";
  const status = reviewStatus(record, today);
  if (status.state === "never_reviewed") return `${SEPARATOR}Not yet reviewed`;
  if (status.review_outcome === "fail") return `${SEPARATOR}Reviewed ${status.reviewed_at}, corrections outstanding`;
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

export function indexCitation(indexSize: number): string {
  return `Data verified from our index of ${indexSize.toLocaleString()} developer tools`;
}

export function compiledNotice(compiledOn: string, lastChecked: string | null = null): string {
  if (lastChecked === null) return `Figures compiled ${compiledOn}, not re-checked since`;
  return `Figures compiled ${compiledOn}, last checked ${lastChecked}`;
}

export function dataProvenanceFor(record: PageReviewRecord | null, indexSize: number, today: string): string {
  if (!record) return "";
  if (record.reads_index) return indexCitation(indexSize);
  return compiledNotice(record.published, reviewStatus(record, today).reviewed_at);
}

export function pageDataProvenance(pagePath: string, indexSize: number, today = utcToday()): string {
  return dataProvenanceFor(getPageReview(pagePath), indexSize, today);
}

export function compiledClause(record: PageReviewRecord | null, today: string): string {
  if (!record) return "";
  const lastChecked = reviewStatus(record, today).reviewed_at;
  if (lastChecked === null) return `Compiled ${record.published}, not re-checked since`;
  return `Compiled ${record.published}, last checked ${lastChecked}`;
}

export function pageCompiledClause(pagePath: string, today = utcToday()): string {
  return compiledClause(getPageReview(pagePath), today);
}

export function dateModifiedFor(record: PageReviewRecord | null, fallbackPublished: string, today: string): string {
  if (!record) return fallbackPublished;
  const status = reviewStatus(record, today);
  if (status.review_outcome === "fail") return record.published;
  return status.reviewed_at ?? record.published;
}

export function pageDateModified(pagePath: string, fallbackPublished: string, today = utcToday()): string {
  return dateModifiedFor(getPageReview(pagePath), fallbackPublished, today);
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

export function newestChangeBySlug(
  changes: Array<{ vendor?: string; date?: string }>,
  notAfter: string,
  slugFor: (vendor: string) => string
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const c of changes) {
    if (!c.vendor || !c.date || c.date > notAfter) continue;
    const slug = slugFor(c.vendor);
    const current = newest.get(slug);
    if (!current || c.date > current) newest.set(slug, c.date);
  }
  return newest;
}

export type FactSurface = "verdict" | "table";

export interface OutdatedFact extends OutdatedVerdict {
  surface: FactSurface;
}

export interface StatedVendors {
  vendors_asserted: string[];
  vendors_tabulated: string[];
}

export function vendorsStatedBy(record: StatedVendors): string[] {
  return [...new Set([...record.vendors_asserted, ...record.vendors_tabulated])].sort();
}

export function factsOutdatedBy(status: ReviewStatus, changeDateFor: (slug: string) => string | null): OutdatedFact[] {
  const asserted = new Set(status.vendors_asserted);
  const out: OutdatedFact[] = [];
  for (const slug of vendorsStatedBy(status)) {
    const changed = changeDateFor(slug);
    if (changed && changed > status.clock_starts) out.push({ slug, changed, surface: asserted.has(slug) ? "verdict" : "table" });
  }
  return out.sort((a, b) => b.changed.localeCompare(a.changed) || a.slug.localeCompare(b.slug));
}

export interface StaleFactPage {
  path: string;
  clock_starts: string;
  state: ReviewState;
  facts: OutdatedFact[];
}

export function staleFactPages(
  pages: PageReviewRecord[],
  today: string,
  changeDateFor: (slug: string) => string | null
): StaleFactPage[] {
  const out: StaleFactPage[] = [];
  for (const page of pages) {
    const status = reviewStatus(page, today);
    const facts = factsOutdatedBy(status, changeDateFor);
    if (facts.length > 0) out.push({ path: page.path, clock_starts: status.clock_starts, state: status.state, facts });
  }
  return out.sort((a, b) => b.facts.length - a.facts.length || a.path.localeCompare(b.path));
}

export function staleFactViolations(
  pages: PageReviewRecord[],
  today: string,
  changeDateFor: (slug: string) => string | null,
  budget: number = STALE_FACT_PAGES_BASELINE
): PageSourceViolation[] {
  const stale = staleFactPages(pages, today, changeDateFor);
  if (stale.length === budget) return [];
  const direction =
    stale.length > budget
      ? `${stale.length - budget} more than the budget allows, and the budget does not rise. The cohort is ${stale.map(p => p.path).sort().join(", ")}`
      : lowerBudgetInstruction("stale_fact_pages", stale.length);
  return [{
    path: "",
    problem: `${stale.length} pages state a vendor fact whose record moved after the page was last read — ${direction}`,
  }];
}

export interface OverdueReport {
  generated_for: string;
  sla_days: Record<ReviewTier, number>;
  tier_rule: Record<ReviewTier, string>;
  expiry_multiple: number;
  data_source_rule: Record<PageDataSource, string>;
  totals: { pages: number; current: number; overdue: number; expired: number; never_reviewed: number };
  data_sources: Record<PageDataSource, number>;
  unsourced_tier_a: { pages: number; budget: number; paths: string[] };
  pages: ReviewStatus[];
}

export function overdueReport(today: string, index: PageReviewIndex = loadPageReviews()): OverdueReport {
  const pages = index.pages
    .map(p => reviewStatus(p, today))
    .sort((a, b) => b.days_overdue - a.days_overdue || a.path.localeCompare(b.path));
  const totals = { pages: pages.length, current: 0, overdue: 0, expired: 0, never_reviewed: 0 };
  for (const p of pages) totals[p.state] += 1;
  const dataSources: Record<PageDataSource, number> = { catalogue: 0, editorial: 0, unsourced: 0 };
  for (const p of pages) dataSources[p.data_source] += 1;
  const unsourced = unsourcedTierAPaths(index.pages);
  return {
    generated_for: today,
    sla_days: { ...SLA_DAYS },
    tier_rule: { ...TIER_RULE },
    expiry_multiple: EXPIRY_MULTIPLE,
    data_source_rule: { ...PAGE_DATA_SOURCE_RULE },
    totals,
    data_sources: dataSources,
    unsourced_tier_a: { pages: unsourced.length, budget: UNSOURCED_TIER_A_BASELINE, paths: unsourced },
    pages,
  };
}

const VERDICT_BLOCK_CLASSES = ["summary-stats", "executive-summary", "verdict-box", "pick-header"];
const VERDICT_INLINE_CLASSES = ["winner-badge", "pick-badge", "stack-verdict"];

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

export const PERTURBATION_SENTINEL = "PMPERTURB";
export const CATALOGUE_TEXT_FIELDS = ["description", "tier", "notes", "limits"];
export const CHANGE_LOG_TEXT_FIELDS = ["summary", "previous_state", "current_state"];

export function perturbTextFields(records: any[], fields: string[]): number {
  let touched = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    for (const field of fields) {
      if (typeof record[field] !== "string") continue;
      record[field] = `${PERTURBATION_SENTINEL} ${record[field].replace(/\d/g, "9")}`;
      touched += 1;
    }
  }
  return touched;
}

const TABLE_ROW = /<tr\b[\s\S]*?<\/tr>/g;
const ROW_CELL = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g;
const VENDOR_CELL_LINK = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"/;

export interface VendorFactRow {
  subject: string;
  slug: string;
}

function cellText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function vendorFactRows(html: string, slugFor: VendorSlugLookup): VendorFactRow[] {
  const found: VendorFactRow[] = [];
  for (const row of html.match(TABLE_ROW) ?? []) {
    const cells = row.match(ROW_CELL) ?? [];
    const first = cells[0];
    if (first === undefined) continue;
    if (!cells.slice(1).some(cell => /\d/.test(cellText(cell)))) continue;
    const subject = cellText(first);
    const linked = first.match(VENDOR_CELL_LINK);
    const slug = linked ? linked[1]! : subject ? slugFor(subject) : null;
    if (slug) found.push({ subject, slug });
  }
  return found;
}

export interface PageSourceMeasurement {
  reads_index: boolean;
  reads_changes: boolean;
  vendor_fact_rows: number;
}

export interface PageSourceViolation {
  path: string;
  problem: string;
}

export function unsourcedTierAPaths(pages: PageReviewRecord[]): string[] {
  return pages
    .filter(page => page.tier === "A" && page.data_source === "unsourced")
    .map(page => page.path)
    .sort();
}

function declarationViolations(page: PageReviewRecord, seen: PageSourceMeasurement): PageSourceViolation[] {
  const violations: PageSourceViolation[] = [];
  if (page.reads_index !== seen.reads_index) {
    violations.push({
      path: page.path,
      problem: `reads_index says ${page.reads_index}, perturbing the catalogue says ${seen.reads_index}`,
    });
  }
  if (page.reads_changes !== seen.reads_changes) {
    violations.push({
      path: page.path,
      problem: `reads_changes says ${page.reads_changes}, perturbing the change log says ${seen.reads_changes}`,
    });
  }
  if (seen.reads_index && page.data_source !== "catalogue") {
    violations.push({
      path: page.path,
      problem: `data_source ${page.data_source} on a page that renders catalogue fields`,
    });
  }
  if (!seen.reads_index && page.data_source === "catalogue") {
    violations.push({
      path: page.path,
      problem: "data_source catalogue on a page the catalogue perturbation leaves byte-identical",
    });
  }
  if (page.data_source !== "editorial") return violations;
  if (page.data_source_reason === null) {
    violations.push({ path: page.path, problem: "data_source editorial with no stated reason" });
  }
  if (seen.vendor_fact_rows > 0) {
    violations.push({
      path: page.path,
      problem: `data_source editorial on a page with ${seen.vendor_fact_rows} table rows putting a number beside a catalogued vendor`,
    });
  }
  if (page.vendors_asserted.length > 0) {
    violations.push({
      path: page.path,
      problem: `data_source editorial on a page whose verdict blocks assert ${page.vendors_asserted.length} vendors`,
    });
  }
  return violations;
}

export function pageSourceViolations(
  pages: PageReviewRecord[],
  measured: Map<string, PageSourceMeasurement>,
  tierABudget: number = UNSOURCED_TIER_A_BASELINE
): PageSourceViolation[] {
  const violations: PageSourceViolation[] = [];
  for (const page of pages) {
    const seen = measured.get(page.path);
    if (seen === undefined) {
      violations.push({ path: page.path, problem: "on the register but not measured" });
      continue;
    }
    violations.push(...declarationViolations(page, seen));
  }
  const unsourced = unsourcedTierAPaths(pages);
  if (unsourced.length !== tierABudget) {
    const direction =
      unsourced.length > tierABudget
        ? `${unsourced.length - tierABudget} more than the budget allows, and the budget does not rise`
        : `${tierABudget - unsourced.length} fewer than the budget; ${lowerBudgetInstruction("unsourced_tier_a", unsourced.length)}`;
    violations.push({
      path: "",
      problem: `${unsourced.length} tier-A pages assert vendor facts and read no catalogue record — ${direction}`,
    });
  }
  return violations;
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
