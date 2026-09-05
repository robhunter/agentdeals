import { loadOffers } from "./data.js";
import { toSlug } from "./slug.js";
import { offerRetired } from "./retirement.js";
import type { Offer } from "./types.js";

export interface ModelRate {
  model: string | null;
  input: string;
  output: string | null;
}

const AMOUNT = String.raw`\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)`;
const PAIRED = new RegExp(`${AMOUNT}\\s*/\\s*${AMOUNT}`, "g");
const SPLIT = new RegExp(`${AMOUNT}\\s*/\\s*1?M\\s+input[^.$]{0,40}?${AMOUNT}\\s*/\\s*1?M\\s+output`, "g");
const INPUT_ONLY = new RegExp(`${AMOUNT}\\s*/\\s*1?M\\s+input`, "g");

const CONNECTORS = new Set([
  "at", "from", "is", "are", "was", "costs", "cost", "start", "starts", "starting",
  "of", "for", "to", "priced", "and", "or", "then", "up", "only", "about", "around",
  "roughly", "approximately", "remains", "stays", "in",
]);

const NOT_A_MODEL = new Set([
  "rate", "rates", "price", "prices", "pricing", "tier", "tiers", "api", "apis",
  "token", "tokens", "cost", "costs", "model", "models", "plan", "plans", "access",
  "use", "usage", "paid", "free", "batch", "context", "discount", "credits", "credit",
  "inference", "platform", "limits", "month", "lineup", "tools", "tool",
]);

const CLAUSE_BREAKS = [". ", ", ", "; ", ": ", " — ", " – ", " (", ") "];

function stripTail(text: string): string {
  let s = text.replace(/\s+$/, "");
  for (;;) {
    const before = s;
    s = s.replace(/\([^()]*\)$/, "").replace(/[\s:\u2014\u2013\-=,]+$/, "");
    const word = s.match(/([A-Za-z]+)$/);
    if (word && CONNECTORS.has(word[1].toLowerCase())) s = s.slice(0, s.length - word[1].length);
    if (s === before) return s;
  }
}

function afterLastClauseBreak(text: string): string {
  let cut = 0;
  for (const brk of CLAUSE_BREAKS) {
    const at = text.lastIndexOf(brk);
    if (at >= 0) cut = Math.max(cut, at + brk.length);
  }
  return text.slice(cut);
}

function acceptableName(candidate: string): string | null {
  let name = candidate.replace(/^[\s"'\u201c]+|[\s"'\u201d]+$/g, "");
  for (;;) {
    const word = name.match(/([A-Za-z]+)$/);
    if (!word || !NOT_A_MODEL.has(word[1].toLowerCase())) break;
    name = name.slice(0, name.length - word[1].length).replace(/[\s\-:]+$/, "");
  }
  if (!name || name.length > 44) return null;
  if (!/^[A-Za-z0-9]/.test(name)) return null;
  if (!/[A-Za-z]/.test(name)) return null;
  if (/[$%]/.test(name)) return null;
  return name;
}

function nameBefore(prefix: string): string | null {
  return acceptableName(afterLastClauseBreak(stripTail(prefix)));
}

function nameAfter(suffix: string): string | null {
  const named = suffix.match(/^\s*(?:tokens?\s+)?for\s+([A-Za-z0-9][A-Za-z0-9.\- ]*?)(?=\.(?!\d)|[,;:)]|\s*$)/);
  return named ? acceptableName(named[1]) : null;
}

export function readModelRates(description: string | null | undefined): ModelRate[] {
  if (!description) return [];
  const claimed: Array<[number, number]> = [];
  const found: Array<ModelRate & { at: number }> = [];

  const scan = (re: RegExp, toRate: (m: RegExpExecArray) => { input: string; output: string | null }) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(description)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      const model = nameAfter(description.slice(end, end + 60)) ?? nameBefore(description.slice(0, start));
      found.push({ model, at: start, ...toRate(m) });
    }
  };

  scan(SPLIT, m => ({ input: `$${m[1]}`, output: `$${m[2]}` }));
  scan(PAIRED, m => ({ input: `$${m[1]}`, output: `$${m[2]}` }));
  scan(INPUT_ONLY, m => ({ input: `$${m[1]}`, output: null }));

  return found
    .sort((a, b) => a.at - b.at)
    .map(({ model, input, output }) => ({ model, input, output }));
}

export function amountValue(amount: string): number {
  return Number(amount.replace(/[$,]/g, ""));
}

export function soleMatch<T extends { vendor: string }>(offers: T[], slug: string): T | null {
  const matches = offers.filter(o => toSlug(o.vendor) === slug);
  return matches.length === 1 ? matches[0] : null;
}

export function offerForSlug(slug: string): Offer | null {
  return soleMatch(loadOffers(), slug);
}

export function publishableRates(offer: Pick<Offer, "tier" | "description"> | null): ModelRate[] {
  if (!offer || offerRetired(offer)) return [];
  return readModelRates(offer.description);
}

export function vendorRates(slug: string): ModelRate[] {
  return publishableRates(offerForSlug(slug));
}

function byInputRate(a: ModelRate, b: ModelRate): number {
  return amountValue(a.input) - amountValue(b.input);
}

export function cheapestRate(rates: ModelRate[]): ModelRate | null {
  return rates.length ? [...rates].sort(byInputRate)[0] : null;
}

export function dearestRate(rates: ModelRate[]): ModelRate | null {
  return rates.length ? [...rates].sort(byInputRate)[rates.length - 1] : null;
}

export function spanOfRates(rates: ModelRate[]): ModelRate[] {
  const cheapest = cheapestRate(rates);
  const dearest = dearestRate(rates);
  if (!cheapest) return [];
  if (!dearest || sameFigures(cheapest, dearest)) return [cheapest];
  return [cheapest, dearest];
}

export function sameFigures(a: ModelRate, b: ModelRate): boolean {
  return a.input === b.input && a.output === b.output;
}

export function formatRate(rate: ModelRate): string {
  if (rate.output === null) {
    return rate.model ? `${rate.input} (${rate.model}, input only)` : `${rate.input} (input only)`;
  }
  return rate.model ? `${rate.input}/${rate.output} (${rate.model})` : `${rate.input}/${rate.output}`;
}

export function formatRateSpan(rates: ModelRate[]): string | null {
  const span = spanOfRates(rates);
  if (!span.length) return null;
  return span.map(formatRate).join(" – ");
}

export function monthlyTokenCost(rate: ModelRate, millionsIn: number, millionsOut: number): number | null {
  if (rate.output === null) return null;
  return amountValue(rate.input) * millionsIn + amountValue(rate.output) * millionsOut;
}

export function formatDollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
