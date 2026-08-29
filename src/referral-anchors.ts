export interface RenderedAnchor {
  href: string;
  label: string;
  rel: string[];
}

const ANCHOR_TAG = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
const BENEFIT_VERB = /^(claim|get|redeem|save|unlock|grab|sign\s?up|start)\b/i;
const BENEFIT_AMOUNT = /[$€£]\s?\d|\b\d+\s*%\s*(off|discount)\b/i;

function attributeOf(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag);
  return match ? match[1] : "";
}

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
}

export function anchorsIn(html: string): RenderedAnchor[] {
  const anchors: RenderedAnchor[] = [];
  for (const match of html.matchAll(ANCHOR_TAG)) {
    anchors.push({
      href: attributeOf(match[1], "href"),
      label: plainText(match[2]),
      rel: attributeOf(match[1], "rel").split(/\s+/).filter(Boolean),
    });
  }
  return anchors;
}

export function isSponsored(anchor: RenderedAnchor): boolean {
  return anchor.rel.includes("sponsored");
}

export function sponsoredAnchorsIn(html: string): RenderedAnchor[] {
  return anchorsIn(html).filter(isSponsored);
}

export function offersAReaderBenefit(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  return BENEFIT_VERB.test(text) || BENEFIT_AMOUNT.test(text);
}
