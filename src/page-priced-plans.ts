import { A_TRIAL_A_CREDIT_OR_A_DISCOUNT, DENIES_A_FREE_PLAN } from "./superseding-reading.js";

export interface PricedPlan {
  name: string;
  amount: number;
  field: string;
  currency: string | null;
  period: string | null;
  reading: number;
}

export const A_PLAN_NAME_KEY = /^(?:name|title|label)$/i;
export const A_PRICE_KEY = /price|cost|amount/i;

const A_MONTHLY_PRICE_KEY = /month/i;
const A_YEARLY_PRICE_KEY = /annual|year/i;
const A_CURRENCY_CODE = /^[A-Z]{3}$/;
const LONGEST_NAME = 60;
const LONGEST_OBJECT_WE_PARSE = 8192;

const SCRIPT_BODY = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const A_DOUBLE_QUOTED_LITERAL = /"(?:[^"\\]|\\[\s\S])*"/g;

export const ESCAPING_LEVELS_WE_FOLLOW = 3;

export function decodedLiteralsIn(text: string): string[] {
  const decoded: string[] = [];
  for (const literal of text.matchAll(A_DOUBLE_QUOTED_LITERAL)) {
    let content: unknown;
    try {
      content = JSON.parse(literal[0]);
    } catch {
      continue;
    }
    if (typeof content !== "string" || !content.includes("{") || !A_PRICE_KEY.test(content)) continue;
    decoded.push(content);
  }
  return decoded;
}

export function balancedObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open: number[] = [];
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (inString) {
      if (character === "\\") at += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") open.push(at);
    else if (character === "}") {
      const from = open.pop();
      if (from !== undefined) spans.push([from, at]);
    }
  }
  return spans;
}

function periodOf(field: string): string | null {
  if (A_MONTHLY_PRICE_KEY.test(field)) return "month";
  if (A_YEARLY_PRICE_KEY.test(field)) return "year";
  return null;
}

function nameIn(entries: Array<[string, unknown]>): string | null {
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !A_PLAN_NAME_KEY.test(key)) continue;
    const named = value.trim();
    if (named !== "" && named.length <= LONGEST_NAME) return named;
  }
  return null;
}

function currencyIn(entries: Array<[string, unknown]>): string | null {
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== "currency") continue;
    if (typeof value === "string" && A_CURRENCY_CODE.test(value.trim())) return value.trim();
  }
  return null;
}

function plansWithin(value: unknown, into: PricedPlan[], reading: number): void {
  if (Array.isArray(value)) {
    for (const item of value) plansWithin(item, into, reading);
    return;
  }
  if (!value || typeof value !== "object") return;
  const entries = Object.entries(value as Record<string, unknown>);
  const name = nameIn(entries);
  if (name !== null) {
    const currency = currencyIn(entries);
    for (const [key, item] of entries) {
      if (typeof item !== "number" || !Number.isFinite(item)) continue;
      if (!A_PRICE_KEY.test(key)) continue;
      into.push({ name, amount: item, field: key, currency, period: periodOf(key), reading });
    }
  }
  for (const [, item] of entries) plansWithin(item, into, reading);
}

export function readingsOf(html: string): string[] {
  const readings = [html];
  let frontier = [...html.matchAll(SCRIPT_BODY)].map((block) => block[1] ?? "");
  for (let level = 0; level < ESCAPING_LEVELS_WE_FOLLOW && frontier.length > 0; level += 1) {
    const next = frontier.flatMap(decodedLiteralsIn);
    readings.push(...next);
    frontier = next;
  }
  return readings;
}

export function pricedPlansIn(html: string): PricedPlan[] {
  const readings = readingsOf(html);

  const found: PricedPlan[] = [];
  const already = new Set<string>();
  for (const [at, reading] of readings.entries()) {
    for (const [from, to] of balancedObjectSpans(reading)) {
      if (to - from > LONGEST_OBJECT_WE_PARSE) continue;
      const slice = reading.slice(from, to + 1);
      if (!A_PRICE_KEY.test(slice)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(slice);
      } catch {
        continue;
      }
      const plans: PricedPlan[] = [];
      plansWithin(parsed, plans, at);
      for (const plan of plans) {
        const key = `${plan.name} ${plan.field} ${plan.amount}`;
        if (already.has(key)) continue;
        already.add(key);
        found.push(plan);
      }
    }
  }
  return found;
}

export function planIsOfferedOutright(plan: PricedPlan): boolean {
  return !A_TRIAL_A_CREDIT_OR_A_DISCOUNT.test(plan.name) && !DENIES_A_FREE_PLAN.test(plan.name);
}

export function aPlanPricedAtNothing(plans: readonly PricedPlan[]): PricedPlan | null {
  return plans.find((plan) => plan.amount === 0 && planIsOfferedOutright(plan)) ?? null;
}

export function readingOf(plan: PricedPlan): string {
  const money = plan.currency ? `${plan.amount} ${plan.currency}` : String(plan.amount);
  const per = plan.period ? ` per ${plan.period}` : "";
  return `${plan.name}: ${money}${per}, read from ${plan.field}`;
}

export function ladderNamesIn(plans: readonly PricedPlan[]): string[] {
  return [...new Set(plans.map((plan) => plan.name))];
}
