export type StackVerdictConfidence = 0 | 1 | 2 | 3;

export interface PublishedPick {
  vendor: string;
  badgeVerdict: string;
  pageVerdict: string;
}

export interface OverconfidentPick extends PublishedPick {
  badgeConfidence: StackVerdictConfidence;
  pageConfidence: StackVerdictConfidence;
}

export interface UnreadablePick extends PublishedPick {
  side: "badge" | "page";
}

const ENDED_PHRASES = [
  "free tier removed",
  "offer ended",
  "no longer free",
  "deprecated",
  "retired",
  "shut down",
  "sunset",
];

const WITHHELD_PHRASES = [
  "unrated",
  "unknown",
  "not found",
  "no source",
  "withheld",
  "unconfirmed",
  "cannot confirm",
  "risky",
  "volatile",
];

const QUALIFIED_PHRASES = [
  "at risk",
  "stale",
  "caution",
  "watch",
];

const CONFIDENT_PHRASES = [
  "active",
  "stable",
  "improving",
  "free",
];

function normalise(text: string): string {
  return text
    .replace(/[—–‒]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function holds(text: string, phrases: string[]): boolean {
  return phrases.some(p => text.includes(p));
}

export function verdictConfidence(verdict: string): StackVerdictConfidence | null {
  const text = normalise(verdict);
  if (text === "") return null;
  if (holds(text, ENDED_PHRASES)) return 0;
  if (holds(text, WITHHELD_PHRASES)) return 1;
  if (holds(text, QUALIFIED_PHRASES)) return 2;
  if (holds(text, CONFIDENT_PHRASES)) return 3;
  return null;
}

export function overconfidentPicks(picks: readonly PublishedPick[]): OverconfidentPick[] {
  const over: OverconfidentPick[] = [];
  for (const pick of picks) {
    const badgeConfidence = verdictConfidence(pick.badgeVerdict);
    const pageConfidence = verdictConfidence(pick.pageVerdict);
    if (badgeConfidence === null || pageConfidence === null) continue;
    if (pageConfidence > badgeConfidence) over.push({ ...pick, badgeConfidence, pageConfidence });
  }
  return over;
}

export function unreadablePicks(picks: readonly PublishedPick[]): UnreadablePick[] {
  const unreadable: UnreadablePick[] = [];
  for (const pick of picks) {
    if (verdictConfidence(pick.badgeVerdict) === null) unreadable.push({ ...pick, side: "badge" });
    else if (verdictConfidence(pick.pageVerdict) === null) unreadable.push({ ...pick, side: "page" });
  }
  return unreadable;
}

export interface PublishedVerdict {
  slug: string;
  verdict: string;
}

const VENDOR_LINK_OR_VERDICT = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"|<span[^>]*class="[^"]*\bstack-verdict\b[^"]*"[^>]*>([^<]*)<\/span>|class="stability-dot"[^>]*><\/span>\s*(?:<span[^>]*>)?([A-Za-z][A-Za-z ]*)/g;

export function verdictsPublishedOn(html: string): PublishedVerdict[] {
  const published: PublishedVerdict[] = [];
  const scan = new RegExp(VENDOR_LINK_OR_VERDICT.source, "g");
  let subject: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html)) !== null) {
    if (m[1] !== undefined) {
      subject = m[1];
      continue;
    }
    if (subject === null) continue;
    const verdict = (m[2] ?? m[3] ?? "").replace(/&mdash;/g, "—").trim();
    if (verdict !== "") published.push({ slug: subject, verdict });
  }
  return published;
}

export interface PublishedLimit {
  slug: string;
  limit: string;
}

const LIMIT_SCAN = /(<tr\b|<div class="stack-pick">|<div class="why-card">)|href="\/vendor\/([a-z0-9][a-z0-9-]*)"|<(?:td|p|span)[^>]*class="(?:pick-limits|limits-cell|why-free|free-tier-info)"[^>]*>([\s\S]*?)<\/(?:td|p|span)>|<td style="font-family:var\(--mono\);font-size:\.8rem;color:var\(--accent\)">([\s\S]*?)<\/td>/g;

const CITATION_LINK = /<a\b[^>]*class="[^"]*\bstack-limit-source\b[^"]*"[^>]*>[\s\S]*?<\/a>/g;

function textOf(html: string): string {
  return html
    .replace(CITATION_LINK, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, "—").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function limitsPublishedOn(html: string): PublishedLimit[] {
  const published: PublishedLimit[] = [];
  const scan = new RegExp(LIMIT_SCAN.source, "g");
  let subject: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html)) !== null) {
    if (m[1] !== undefined) {
      subject = null;
      continue;
    }
    if (m[2] !== undefined) {
      subject = m[2];
      continue;
    }
    if (subject === null) continue;
    const limit = textOf(m[3] ?? m[4] ?? "");
    if (limit !== "") published.push({ slug: subject, limit });
  }
  return published;
}

const RECOMMENDATION_SLOT =/<tr\b[^>]*>[\s\S]*?<\/tr>|<a\b[^>]*class="[^"]*\balt-chip\b[^"]*"[^>]*>[\s\S]*?<\/a>|<div\b[^>]*class="[^"]*\bpick-header\b[^"]*"[^>]*>[\s\S]*?<\/div>/g;

export function slotsMissingAVerdict(html: string): string[] {
  const missing: string[] = [];
  const scan = new RegExp(RECOMMENDATION_SLOT.source, "g");
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html)) !== null) {
    const slot = m[0];
    const link = slot.match(/href="\/vendor\/([a-z0-9][a-z0-9-]*)"/);
    if (!link) continue;
    if (/class="[^"]*\bstack-verdict\b/.test(slot)) continue;
    missing.push(link[1]);
  }
  return missing;
}

export type StackBadgeStatus =
  | "active"
  | "at-risk"
  | "stale"
  | "removed"
  | "retired"
  | "withheld"
  | "unknown";

export function freeTierHasEnded(status: StackBadgeStatus): boolean {
  return status === "removed" || status === "retired";
}

export function mayRecommendAsFree(status: StackBadgeStatus): boolean {
  return !freeTierHasEnded(status);
}

export function readsActive(status: StackBadgeStatus): boolean {
  return status === "active";
}

export function proseWithoutNames(prose: string, names: readonly string[]): string {
  if (names.length === 0) return prose;
  return prose
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => !names.some(name => sentence.includes(name)))
    .join(" ");
}

export const NO_CURRENT_FIGURE = "No current figure";

export function limitCellText(terms: string, cap: number): string {
  const text = terms.replace(/\s+/g, " ").trim();
  if (text.length <= cap) return text;
  const clipped = text.slice(0, cap);
  const lastSpace = clipped.lastIndexOf(" ");
  const kept = lastSpace > cap / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${kept.replace(/[,;:.]$/, "")}…`;
}

export function stackFreshnessStatement(verifiedDates: readonly string[]): string {
  const dates = verifiedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice().sort();
  if (dates.length === 0) return "";
  const oldest = dates[0];
  const newest = dates[dates.length - 1];
  const subject = dates.length === 1 ? "The limit on this page was" : "The limits on this page were";
  return oldest === newest
    ? `${subject} read from vendor pricing pages on ${newest}.`
    : `${subject} read from vendor pricing pages between ${oldest} and ${newest}.`;
}

export interface CostHeadlinePick {
  vendor: string;
  verdict: string;
  readsActive: boolean;
}

export function costHeadlineCaveat(picks: readonly CostHeadlinePick[]): string {
  const total = picks.length;
  if (total === 0) return "";
  const unconfirmed = picks.filter(p => !p.readsActive);
  if (unconfirmed.length === 0) return "";
  const named = unconfirmed.map(p => `${p.vendor} (${p.verdict})`).join(", ");
  const confirmed = total - unconfirmed.length;
  const noun = total === 1 ? "pick" : "picks";
  return `$0 covers the ${confirmed} of ${total} ${noun} whose free tier our own badge still reads as active. It does not cover ${named}.`;
}
