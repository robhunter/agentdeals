import type { EndedOffer } from "./retired-terms.js";

const BADGE_HOLDER = /<(td|h1|h2|h3|h4|h5|h6)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const PROVIDER_CELL_ATTRS = /class="[^"]*\bprovider-col\b[^"]*"/;
const CARRIES_REMOVED_BADGE = /class="[^"]*\bremoved-badge\b[^"]*"/;
const BADGE_ELEMENT = /<(?:span|a)\b[^>]*\bclass="[^"]*\bremoved-badge\b[^"]*"[^>]*>/;
const TRAILING_QUALIFIER_SPAN = /<span\b[^>]*>(?:(?!<span\b)[\s\S])*?<\/span>\s*$/;
const SUBJECT_TAGLINE = /\s+[—–·:]\s+/;
const TRAILING_QUALIFIER = /^(.+?)\s*\([^()]*\)$/;

function plainText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&amp;|&#38;/g, "&")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutTheQualifier(head: string): string {
  const trimmed = head.replace(TRAILING_QUALIFIER_SPAN, "");
  return plainText(trimmed) === "" ? head : trimmed;
}

export function subjectBadgedAsEnded(inner: string): string {
  const badgeAt = inner.search(BADGE_ELEMENT);
  const head = badgeAt >= 0 ? inner.slice(0, badgeAt) : inner;
  const text = plainText(withoutTheQualifier(head)).split(SUBJECT_TAGLINE)[0]!.trim();
  const qualified = text.match(TRAILING_QUALIFIER);
  return (qualified ? qualified[1]! : text).trim();
}

export function vendorsBadgedAsEnded(html: string): string[] {
  const found = new Set<string>();
  const holders = new RegExp(BADGE_HOLDER.source, "g");
  for (let m: RegExpExecArray | null; (m = holders.exec(html)); ) {
    const tag = m[1]!;
    const attrs = m[2]!;
    const inner = m[3]!;
    if (!CARRIES_REMOVED_BADGE.test(inner)) continue;
    if (tag === "td" && !PROVIDER_CELL_ATTRS.test(attrs)) continue;
    const subject = subjectBadgedAsEnded(inner);
    if (subject !== "") found.add(subject);
  }
  return [...found].sort();
}

export function badgedEndingPopulation(html: string): EndedOffer[] {
  return vendorsBadgedAsEnded(html).map(vendor => ({ vendor, tier: "Retired" }));
}
