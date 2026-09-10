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

function argumentsAt(source: string, open: number): string[] {
  const found: string[] = [];
  let depth = 0;
  let from = open + 1;
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
      if (depth === 0) {
        found.push(source.slice(from, at));
        return found;
      }
    } else if (char === "," && depth === 1) {
      found.push(source.slice(from, at));
      from = at + 1;
    }
  }
  return found;
}

function conditionAt(source: string, open: number): string {
  return argumentsAt(source, open)[0] ?? "";
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

export interface Population {
  size: number;
  read: string;
}

function catalogueOffers(): Array<{ vendor: string; category: string }> {
  const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const at = process.env.AGENTDEALS_INDEX_PATH || path.join(REPO, "data", "index.json");
  return JSON.parse(readFileSync(at, "utf-8")).offers;
}

export function vendorsInTheCatalogue(): Population {
  const vendors = new Set(catalogueOffers().map((offer) => offer.vendor.trim().toLowerCase()));
  return { size: vendors.size, read: "vendors the catalogue holds" };
}

export function categoriesInTheCatalogue(): Population {
  const categories = new Set(catalogueOffers().map((offer) => offer.category.trim()));
  return { size: categories.size, read: "categories the catalogue holds an offer under" };
}

export function recordsInTheCatalogue(): Population {
  return { size: catalogueOffers().length, read: "records the catalogue holds" };
}

const POPULATION_READER = /^[A-Za-z_$][\w$]*\(\s*\)$/;

export const POPULATION_ASSERTIONS = ["assertCoversPopulation", "assertSharesPopulation"] as const;

export type PassedPopulation = { line: number; argument: string };

export function passedPopulationsIn(source: string): PassedPopulation[] {
  const found: PassedPopulation[] = [];
  for (const name of POPULATION_ASSERTIONS) {
    for (const call of source.matchAll(new RegExp(`(?<!function )${name}\\(`, "g"))) {
      const argument = (argumentsAt(source, call.index + name.length)[1] ?? "").trim();
      if (POPULATION_READER.test(argument)) continue;
      found.push({ line: source.slice(0, call.index).split("\n").length, argument });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

export function assertPopulationFloor(observed: number, floor: number, subject: string): void {
  const log = process.env.POPULATION_FLOOR_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ site: callSite(), subject, floor, observed })}\n`);
  assert.ok(observed >= floor, `only ${observed} ${subject}, under a floor of ${floor}`);
  assert.ok(
    floorClearsHeadroom(floor, observed),
    `a floor of ${floor} leaves under ${Math.round(HEADROOM * 100)}% headroom over the ${observed} it measured — ${subject}. It goes red when this data shrinks and stays green when this data is wrong. Lower it, or state the property relative to the population it reads with assertCoversPopulation.`,
  );
}

export function assertCoversPopulation(observed: number, population: Population, subject: string): void {
  const log = process.env.POPULATION_FLOOR_LOG;
  if (log) {
    appendFileSync(
      log,
      `${JSON.stringify({ site: callSite(), subject, covers: population.read, population: population.size, observed })}\n`,
    );
  }
  assert.ok(
    observed >= population.size,
    `${observed} ${subject}, against ${population.size} ${population.read} — the sweep does not cover the population it is read against`,
  );
}

export function asShare(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function shareClearsHeadroom(share: number, observed: number, population: number): boolean {
  return share * 4 <= (observed / population) * 3;
}

export function assertSharesPopulation(
  observed: number,
  population: Population,
  share: number,
  subject: string,
): void {
  const log = process.env.POPULATION_FLOOR_LOG;
  if (log) {
    appendFileSync(
      log,
      `${JSON.stringify({ site: callSite(), subject, filteredFrom: population.read, population: population.size, share, observed })}\n`,
    );
  }
  assert.ok(
    population.size > 0,
    `there are no ${population.read}, so no share of them says anything about ${subject}`,
  );
  assert.ok(
    observed >= population.size * share,
    `${observed} ${subject}, which is ${asShare(observed / population.size)} of the ${population.size} ${population.read} it was filtered from, under a floor of ${asShare(share)}`,
  );
  assert.ok(
    shareClearsHeadroom(share, observed, population.size),
    `a share of ${asShare(share)} leaves under ${Math.round(HEADROOM * 100)}% headroom over the ${asShare(observed / population.size)} it measured — ${subject}. A share does not drift as the data grows or shrinks, so one set this close to what it measures is a tripwire on the filter rather than a guard against it returning nothing.`,
  );
}
