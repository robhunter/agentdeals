const LISTING_BLOCK = '<div class="vendor-listing" data-listing-url="';

export function listingBlocksOf(body: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const opens = body.indexOf('<div class="section other-listings">');
  if (opens === -1) return blocks;
  const closes = body.indexOf('\n  <div class="section', opens + 1);
  const section = body.slice(opens, closes === -1 ? undefined : closes);
  for (const part of section.split(LISTING_BLOCK).slice(1)) {
    blocks.set(part.slice(0, part.indexOf('"')), part);
  }
  return blocks;
}

export function withoutTheListingBlocks(body: string): string {
  const opens = body.indexOf('<div class="section other-listings">');
  if (opens === -1) return body;
  const closes = body.indexOf('\n  <div class="section', opens + 1);
  return body.slice(0, opens) + (closes === -1 ? "" : body.slice(closes));
}
