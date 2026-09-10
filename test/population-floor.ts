import assert from "node:assert";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HEADROOM = 0.25;

export const REGISTERED_FROM = 100;

export type BareFloor = { line: number; literal: number; text: string };

const ASSERTION = /assert\.ok\(/g;
const FLOOR = /(?<![<>=!])(?:>=|>)\s*([\dA-Za-z_$][\w$]*)\b/g;
const CEILING = /(?<![-=])(?:<=|<)\s*[\dA-Za-z_$]/;
const NAMED_NUMBER = /^const\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*;/gm;

function conditionAt(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let at = open; at < source.length; at++) {
    const char = source[at]!;
    if (quote) {
      if (char === "\\") at++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, at);
    } else if (char === "," && depth === 1) return source.slice(open + 1, at);
  }
  return "";
}

export function bareFloorsIn(source: string): BareFloor[] {
  const named = new Map<string, number>();
  for (const declaration of source.matchAll(NAMED_NUMBER)) {
    named.set(declaration[1]!, Number(declaration[2]!.replace(/_/g, "")));
  }
  const valueOf = (operand: string): number | undefined =>
    /^\d/.test(operand) ? Number(operand.replace(/_/g, "")) : named.get(operand);

  const found: BareFloor[] = [];
  for (const assertion of source.matchAll(ASSERTION)) {
    const condition = conditionAt(source, assertion.index + "assert.ok".length);
    if (CEILING.test(condition)) continue;
    for (const floor of condition.matchAll(FLOOR)) {
      const literal = valueOf(floor[1]!);
      if (literal === undefined || literal < REGISTERED_FROM) continue;
      found.push({
        line: source.slice(0, assertion.index).split("\n").length,
        literal,
        text: `assert.ok(${condition.replace(/\s+/g, " ").trim()})`,
      });
    }
  }
  return found;
}

export function floorClearsHeadroom(floor: number, observed: number): boolean {
  return floor <= 1 || floor * 4 <= observed * 3;
}

const callSite = (): string => {
  const frame = new Error().stack?.split("\n")[3] ?? "";
  const at = frame.match(/([^()\s]+\.ts):(\d+):\d+/);
  if (!at) return "unknown";
  return `${at[1].replace("file://", "").replace(`${process.cwd()}/`, "")}:${at[2]}`;
};

export function vendorsInTheCatalogue(): number {
  const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offers: Array<{ vendor: string }> = JSON.parse(
    readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
  ).offers;
  return new Set(offers.map((offer) => offer.vendor.trim().toLowerCase())).size;
}

export function assertPopulationFloor(observed: number, floor: number, subject: string): void {
  const log = process.env.POPULATION_FLOOR_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ site: callSite(), subject, floor, observed })}\n`);
  assert.ok(observed >= floor, `only ${observed} ${subject}, under a floor of ${floor}`);
  assert.ok(
    floorClearsHeadroom(floor, observed),
    `a floor of ${floor} leaves under ${Math.round(HEADROOM * 100)}% headroom over the ${observed} it measured — ${subject}. It goes red when this data shrinks and stays green when this data is wrong. Lower it, or state the property relative to the population it reads.`,
  );
}
