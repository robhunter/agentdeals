import { loadOffers } from "./data.js";
import { offerRetired } from "./retirement.js";
import { toSlug } from "./slug.js";
import type { Offer } from "./types.js";

export type EndedOffer = Pick<Offer, "vendor" | "tier">;

export type StatedTerms = {
  vendor: string;
  where: string;
  unit: string;
  reason: "names a free tier" | "states an allowance";
};

const BLOCK_TAGS = "tr|li|dd|dt|p|h1|h2|h3|h4|h5|h6|figcaption|blockquote|summary|caption";

const ENDED_WORD = /\b(?:retired|retires|retiring|retirement|deprecated|deprecation|discontinued|sunset|sunsetting|withdrawn|withdrew|shut down|shutting down|shutdown|wound down|no longer|has ended|have ended|ended|closed to new|removed|removal|killed|kills|killing|eliminated|eliminates)\b/i;

const NO_OFFER_WORD = /\bno free\b|\bnot free\b|\bwithout a free\b|\bfree tier (?:removed|gone|withdrawn|is gone)\b|\bnot available\b|\bn\/a\b/i;

const OPENS_BY_DENYING_A_FREE_TIER = /^\s*(?:none|no free (?:tier|plan|allowance))\b/i;

export function statesNoFreeTier(text: string): boolean {
  return OPENS_BY_DENYING_A_FREE_TIER.test(text);
}

const AFFIRMATIVE_FREE = /\bfree\b|\bfreemium\b|\bno credit card\b|\bgenerous\b/i;

const ALLOWANCE_UNIT = "gb|gib|mb|mib|tb|tib|kb|tokens?|requests?|req|calls?|rpm|rps|tpm|qps|models?|minutes?|hours?|builds?|seats?|users?|projects?|messages?|emails?|operations?|ops|commands?|neurons?|rows?|records?|events?|pageviews?|visits?|sessions?|domains?|sites?|repos(?:itories)?|containers?|deploys?|queries|invocations?|executions?|jobs?|runs?|workflows?|credits?|checks?|monitors?|alerts?|dashboards?|members?|collaborators?";

const ALLOWANCE_QUANTITY = new RegExp(`\\b\\d[\\d,.]*\\s*[km]?\\+?\\s*(?:${ALLOWANCE_UNIT})\\b`, "i");

const PRICE = /[$€£]\s?\d|\bUSD\b|\bper (?:seat|user|month|GB-month)\b|\bpay-as-you-go\b/i;

export function endedOfferPopulation(offers: Offer[]): EndedOffer[] {
  return offers
    .filter(o => offerRetired(o))
    .map(o => ({ vendor: o.vendor, tier: o.tier }));
}

export function ENDED_TERMS_POPULATION(): EndedOffer[] {
  return endedOfferPopulation(loadOffers());
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&amp;|&#38;/g, "&")
    .replace(/&mdash;|&ndash;|&#8212;|&#8211;/g, "-")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blankOut(html: string, pattern: RegExp): string {
  return html.replace(pattern, m => " ".repeat(m.length));
}

function renderedBody(html: string): string {
  return blankOut(
    blankOut(
      blankOut(html, /<script\b[\s\S]*?<\/script>/gi),
      /<style\b[\s\S]*?<\/style>/gi,
    ),
    /<head\b[\s\S]*?<\/head>|<!--[\s\S]*?-->/gi,
  );
}

type Span = { tag: string; start: number; end: number };

function blockSpans(html: string): Span[] {
  const open = new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>`, "gi");
  const close = new RegExp(`</(${BLOCK_TAGS})\\s*>`, "gi");
  const events: { at: number; after: number; tag: string; open: boolean }[] = [];
  for (let m: RegExpExecArray | null; (m = open.exec(html)); ) {
    events.push({ at: m.index, after: m.index + m[0].length, tag: m[1].toLowerCase(), open: true });
  }
  for (let m: RegExpExecArray | null; (m = close.exec(html)); ) {
    events.push({ at: m.index, after: m.index + m[0].length, tag: m[1].toLowerCase(), open: false });
  }
  events.sort((a, b) => a.at - b.at);

  const spans: Span[] = [];
  const stack: typeof events = [];
  for (const e of events) {
    if (e.open) { stack.push(e); continue; }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag !== e.tag) continue;
      spans.push({ tag: e.tag, start: stack[i].at, end: e.after });
      stack.length = i;
      break;
    }
  }
  return spans;
}

function metaDescription(html: string): string | null {
  const m = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)
    ?? /<meta\s+content="([^"]*)"\s+name="description"/i.exec(html);
  return m ? stripTags(m[1]) : null;
}

function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripTags(m[1]));
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).filter(s => s.trim().length > 0);
}

function names(vendor: string): RegExp {
  const escaped = vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^[a-z0-9]/i.test(vendor) ? "\\b" : "";
  const tail = /[a-z0-9]$/i.test(vendor) ? "\\b" : "";
  return new RegExp(`${lead}${escaped}${tail}`, "i");
}

function claimIn(unit: string): StatedTerms["reason"] | null {
  if (ENDED_WORD.test(unit) || NO_OFFER_WORD.test(unit)) return null;
  if (AFFIRMATIVE_FREE.test(unit)) return "names a free tier";
  if (ALLOWANCE_QUANTITY.test(unit) && !PRICE.test(unit)) return "states an allowance";
  return null;
}

export function pageSubjectSlug(path: string): string | null {
  const m = /^\/(?:alternative-to|vendor)\/([a-z0-9][a-z0-9-]*)\/?$/.exec(path);
  return m ? m[1] : null;
}

function attributionUnits(tag: string, blockHtml: string, blockText: string, matcher: RegExp): string[] {
  if (tag === "tr") {
    const cells = rowCells(blockHtml);
    if (cells.length === 0) return [blockText];
    if (matcher.test(cells[0])) return [blockText];
    return cells.filter(c => matcher.test(c));
  }
  return sentences(blockText).filter(s => matcher.test(s));
}

export function endedOffersStatedAsAvailable(
  html: string,
  path: string,
  population: EndedOffer[],
): StatedTerms[] {
  const subject = pageSubjectSlug(path);
  const candidates = population.filter(o => toSlug(o.vendor) !== subject);
  if (candidates.length === 0) return [];

  const found: StatedTerms[] = [];

  const meta = metaDescription(html);
  if (meta) {
    for (const offer of candidates) {
      const matcher = names(offer.vendor);
      if (!matcher.test(meta)) continue;
      for (const unit of sentences(meta).filter(s => matcher.test(s))) {
        const reason = claimIn(unit);
        if (reason) found.push({ vendor: offer.vendor, where: "meta description", unit, reason });
      }
    }
  }

  const body = renderedBody(html);
  const spans = blockSpans(body);
  const withText = spans.map(s => ({ ...s, text: stripTags(body.slice(s.start, s.end)) }));

  for (const offer of candidates) {
    const matcher = names(offer.vendor);
    const holding = withText.filter(s => matcher.test(s.text));
    const innermost = holding.filter(s =>
      !holding.some(other => other !== s && other.start >= s.start && other.end <= s.end && other.end - other.start < s.end - s.start));
    for (const block of innermost) {
      for (const unit of attributionUnits(block.tag, body.slice(block.start, block.end), block.text, matcher)) {
        const reason = claimIn(unit);
        if (reason) found.push({ vendor: offer.vendor, where: `<${block.tag}>`, unit, reason });
      }
    }
  }

  return found;
}
