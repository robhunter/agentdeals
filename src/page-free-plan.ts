import { offeredOutrightAndNotDenied, sentencesOf } from "./superseding-reading.js";

export type WhereStated = "visible" | "structured";

export const A_PLAN_PRICED_AT_NOTHING =
  /\b(?:always\s+free|free\s+forever|forever\s+free)\b|\bfree[\s'"’-]{0,3}(?:plans?|tiers?|editions?|versions?)\b|\b(?:plans?|tiers?|editions?|versions?)\b[^.!?]{0,24}?\bis\s+free\b|[$€£]\s?0(?:[.,]0{1,2})?\s*(?:\/\s*|per\s+)(?:mo|month|user|seat|year|yr)\b|\bfree\b\s*[:=]\s*[$€£]\s?0\b/i;

export const A_QUESTION = /\?\s*$/;

export interface ReadableParts {
  visible: string;
  structured: string;
}

export interface FreePlanStatement {
  where: WhereStated;
  sentence: string;
}

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const LD_JSON_TYPE = /type\s*=\s*["']?application\/ld\+json["']?/i;

const ENTITIES: [RegExp, string][] = [
  [/&nbsp;|&#160;/g, " "],
  [/&amp;|&#38;/g, "&"],
  [/&lt;|&#60;/g, "<"],
  [/&gt;|&#62;/g, ">"],
  [/&quot;|&#34;/g, '"'],
  [/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'"],
  [/&#36;/g, "$"],
  [/&euro;|&#8364;/g, "€"],
  [/&pound;|&#163;/g, "£"],
  [/&mdash;|&#8212;/g, "—"],
  [/&ndash;|&#8211;/g, "–"],
];

function decoded(text: string): string {
  return ENTITIES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function collapsed(text: string): string {
  return decoded(text).replace(/\s+/g, " ").trim();
}

export function visibleTextOf(html: string): string {
  const withoutMarkup = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/td|\/th|\/tr|\/section)\b[^>]*>/gi, ". ")
    .replace(/<[^>]+>/g, " ");
  return collapsed(withoutMarkup);
}

function everyStringIn(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (value.trim() !== "") into.push(value.trim());
    return;
  }
  if (typeof value === "number") {
    into.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) everyStringIn(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "@context" || key === "@id" || key === "url" || key === "image") continue;
      everyStringIn(item, into);
    }
  }
}

export function structuredTextOf(html: string): string {
  const parts: string[] = [];
  for (const block of html.matchAll(SCRIPT_BLOCK)) {
    if (!LD_JSON_TYPE.test(block[1] ?? "")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded(block[2]));
    } catch {
      continue;
    }
    const strings: string[] = [];
    everyStringIn(parsed, strings);
    parts.push(...strings);
  }
  return collapsed(parts.join(". "));
}

export function readablePartsOf(html: string): ReadableParts {
  return { visible: visibleTextOf(html), structured: structuredTextOf(html) };
}

export function statesAFreePlan(sentence: string): boolean {
  if (A_QUESTION.test(sentence.trim())) return false;
  return offeredOutrightAndNotDenied(sentence, A_PLAN_PRICED_AT_NOTHING);
}

export function whereAFreePlanIsStated(text: string): string | null {
  for (const sentence of sentencesOf(text)) {
    if (statesAFreePlan(sentence.text)) return sentence.text.trim();
  }
  return null;
}

export function freePlanStatedOn(parts: ReadableParts): FreePlanStatement | null {
  const visible = whereAFreePlanIsStated(parts.visible);
  if (visible) return { where: "visible", sentence: visible };
  const structured = whereAFreePlanIsStated(parts.structured);
  if (structured) return { where: "structured", sentence: structured };
  return null;
}

export function statedOnlyInMarkupWeDiscard(parts: ReadableParts): boolean {
  return freePlanStatedOn(parts)?.where === "structured";
}
