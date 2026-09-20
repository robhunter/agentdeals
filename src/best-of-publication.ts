import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface BestOfPublishedLedger {
  version: 1;
  generated: string;
  slugs: string[];
}

export interface BestOfPublishedUpdate {
  ledger: BestOfPublishedLedger;
  added: string[];
}

export function bestOfPublishedPath(): string {
  return process.env.AGENTDEALS_BEST_OF_PUBLISHED_PATH
    || path.join(__dirname, "..", "data", "best-of-published.json");
}

export function emptyBestOfPublished(generated: string): BestOfPublishedLedger {
  return { version: 1, generated, slugs: [] };
}

export function parseBestOfPublished(text: string, source: string): BestOfPublishedLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`${source} is not an object`);
  const file = raw as { version?: unknown; generated?: unknown; slugs?: unknown };
  if (file.version !== 1) throw new Error(`${source} has version ${String(file.version)}, expected 1`);
  if (typeof file.generated !== "string" || !DAY_PATTERN.test(file.generated)) {
    throw new Error(`${source} gives generated as ${JSON.stringify(file.generated)}, expected a YYYY-MM-DD day`);
  }
  if (!Array.isArray(file.slugs)) throw new Error(`${source} carries no slugs array`);
  const slugs: string[] = [];
  for (const slug of file.slugs) {
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(`${source} lists ${JSON.stringify(slug)} as a slug, expected a non-empty string`);
    }
    if (slug.startsWith("/")) throw new Error(`${source} lists ${JSON.stringify(slug)} as a slug, expected the slug alone and not a path`);
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return { version: 1, generated: file.generated, slugs: slugs.sort() };
}

export function readBestOfPublished(file: string = bestOfPublishedPath()): BestOfPublishedLedger {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the best-of publication ledger at ${file}: ${(err as Error).message}`);
  }
  return parseBestOfPublished(text, file);
}

export function serializeBestOfPublished(ledger: BestOfPublishedLedger): string {
  return JSON.stringify({ version: 1, generated: ledger.generated, slugs: [...ledger.slugs].sort() }, null, 2) + "\n";
}

export function recordBestOfPublished(
  previous: BestOfPublishedLedger,
  servingNow: Iterable<string>,
  today: string,
): BestOfPublishedUpdate {
  if (!DAY_PATTERN.test(today)) {
    throw new Error(`recordBestOfPublished needs a YYYY-MM-DD day, got ${JSON.stringify(today)}`);
  }
  const held = new Set(previous.slugs);
  const added: string[] = [];
  for (const slug of servingNow) {
    if (held.has(slug)) continue;
    held.add(slug);
    added.push(slug);
  }
  return {
    ledger: { version: 1, generated: today, slugs: [...held].sort() },
    added: added.sort(),
  };
}

export interface BestOfPublicationInput {
  qualified: number;
  minPicks: number;
  publishedBefore: boolean;
}

export function bestOfPathResolves(input: BestOfPublicationInput): boolean {
  return input.qualified >= input.minPicks || input.publishedBefore;
}

export function bestOfMeetsThePicksFloor(input: BestOfPublicationInput): boolean {
  return input.qualified >= input.minPicks;
}
