const VENDOR_THEN_ALTERNATIVES = /^(.+?)\s+alternatives?$/i;
const ALTERNATIVES_TO_VENDOR = /^alternatives?\s+(?:to|for)\s+(.+)$/i;

export function vendorPhraseOfAnAlternativesQuery(query: string): string | null {
  const asked = query.replace(/\s+/g, " ").trim();
  const match = VENDOR_THEN_ALTERNATIVES.exec(asked) ?? ALTERNATIVES_TO_VENDOR.exec(asked);
  return match ? match[1].trim() : null;
}
