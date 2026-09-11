import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface PageLastmodHash {
  hash: string;
  changed: string;
}

export interface PageLastmodDaily {
  daily: true;
}

export type PageLastmodEntry = PageLastmodHash | PageLastmodDaily;

export interface PageLastmodLedger {
  version: 1;
  generated: string;
  pages: Record<string, PageLastmodEntry>;
}

export interface PageLastmodUpdate {
  ledger: PageLastmodLedger;
  moved: string[];
  added: string[];
  dropped: string[];
  daily: string[];
}

export function isDailyEntry(entry: PageLastmodEntry): entry is PageLastmodDaily {
  return (entry as PageLastmodDaily).daily === true;
}

export function entryDay(entry: PageLastmodEntry | undefined, today: string): string | null {
  if (!entry) return null;
  return isDailyEntry(entry) ? today : entry.changed;
}

export function pageLastmodPath(): string {
  return process.env.AGENTDEALS_PAGE_LASTMOD_PATH || path.join(__dirname, "..", "data", "page-lastmod.json");
}

export function hashPageBody(body: string, origin: string): string {
  const stripped = origin ? body.split(origin).join("") : body;
  return createHash("sha256").update(stripped).digest("hex").slice(0, 16);
}

export function parsePageLastmod(text: string, source: string): PageLastmodLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`${source} is not an object`);
  const file = raw as { version?: unknown; generated?: unknown; pages?: unknown };
  if (file.version !== 1) throw new Error(`${source} has version ${String(file.version)}, expected 1`);
  if (typeof file.generated !== "string" || !DAY_PATTERN.test(file.generated)) {
    throw new Error(`${source} gives generated as ${JSON.stringify(file.generated)}, expected a YYYY-MM-DD day`);
  }
  if (typeof file.pages !== "object" || file.pages === null || Array.isArray(file.pages)) {
    throw new Error(`${source} carries no pages object`);
  }
  const pages: Record<string, PageLastmodEntry> = {};
  for (const [pagePath, value] of Object.entries(file.pages as Record<string, unknown>)) {
    if (!pagePath.startsWith("/")) throw new Error(`${source} keys a page as ${JSON.stringify(pagePath)}, expected a path beginning with /`);
    if (typeof value !== "object" || value === null) throw new Error(`${source} gives ${pagePath} as ${JSON.stringify(value)}, expected an object`);
    const entry = value as { hash?: unknown; changed?: unknown; daily?: unknown };
    if (entry.daily !== undefined) {
      if (entry.daily !== true) {
        throw new Error(`${source} gives ${pagePath} a daily flag of ${JSON.stringify(entry.daily)}, expected true or no flag at all`);
      }
      if (entry.hash !== undefined || entry.changed !== undefined) {
        throw new Error(`${source} gives ${pagePath} both a daily flag and a stored hash, and a page dated from the day it is served stores neither`);
      }
      pages[pagePath] = { daily: true };
      continue;
    }
    if (typeof entry.hash !== "string" || entry.hash.length === 0) {
      throw new Error(`${source} gives ${pagePath} a hash of ${JSON.stringify(entry.hash)}, expected a non-empty string`);
    }
    if (typeof entry.changed !== "string" || !DAY_PATTERN.test(entry.changed)) {
      throw new Error(`${source} gives ${pagePath} a changed date of ${JSON.stringify(entry.changed)}, expected a YYYY-MM-DD day`);
    }
    pages[pagePath] = { hash: entry.hash, changed: entry.changed };
  }
  return { version: 1, generated: file.generated, pages };
}

export function readPageLastmod(file: string = pageLastmodPath()): PageLastmodLedger {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the page lastmod ledger at ${file}: ${(err as Error).message}`);
  }
  return parsePageLastmod(text, file);
}

export function emptyPageLastmod(generated: string): PageLastmodLedger {
  return { version: 1, generated, pages: {} };
}

export function serializePageLastmod(ledger: PageLastmodLedger): string {
  const pages: Record<string, PageLastmodEntry> = {};
  for (const pagePath of Object.keys(ledger.pages).sort()) {
    pages[pagePath] = ledger.pages[pagePath];
  }
  return JSON.stringify({ version: 1, generated: ledger.generated, pages }, null, 2) + "\n";
}

export function updatePageLastmod(
  previous: PageLastmodLedger,
  hashes: Map<string, string>,
  today: string,
  datedFromTheDay: Iterable<string> = [],
): PageLastmodUpdate {
  if (!DAY_PATTERN.test(today)) throw new Error(`updatePageLastmod needs a YYYY-MM-DD day, got ${JSON.stringify(today)}`);
  const daily = new Set(datedFromTheDay);
  for (const pagePath of daily) {
    if (!hashes.has(pagePath)) throw new Error(`${pagePath} is dated from the day it is served but was not read this run`);
  }
  const pages: Record<string, PageLastmodEntry> = {};
  const moved: string[] = [];
  const added: string[] = [];
  for (const [pagePath, hash] of hashes) {
    const before = previous.pages[pagePath];
    const next: PageLastmodEntry = daily.has(pagePath) ? { daily: true } : { hash, changed: today };
    if (!before) {
      pages[pagePath] = next;
      added.push(pagePath);
    } else if (isDailyEntry(before) && isDailyEntry(next)) {
      pages[pagePath] = before;
    } else if (!isDailyEntry(before) && !isDailyEntry(next) && before.hash === hash) {
      pages[pagePath] = before;
    } else {
      pages[pagePath] = next;
      moved.push(pagePath);
    }
  }
  const dropped = Object.keys(previous.pages).filter(pagePath => !hashes.has(pagePath));
  return {
    ledger: { version: 1, generated: today, pages },
    moved: moved.sort(),
    added: added.sort(),
    dropped: dropped.sort(),
    daily: [...daily].sort(),
  };
}

export function lastmodFor(ledger: PageLastmodLedger, pagePath: string, fallback: string, today: string): string {
  return entryDay(ledger.pages[pagePath], today) ?? fallback;
}

export function newestLastmod(ledger: PageLastmodLedger, paths: Iterable<string>, fallback: string, today: string): string {
  let newest = "";
  for (const pagePath of paths) {
    const day = lastmodFor(ledger, pagePath, fallback, today);
    if (day > newest) newest = day;
  }
  return newest || fallback;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function httpDate(day: string): string | null {
  if (!DAY_PATTERN.test(day)) return null;
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${WEEKDAYS[at.getUTCDay()]}, ${dd} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} 00:00:00 GMT`;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

export function buildDay(modulePath: string, fallback: string): string {
  try {
    return new Date(fs.statSync(modulePath).mtime).toISOString().slice(0, 10);
  } catch {
    return fallback;
  }
}

export function fallbackDay(build: string, ledgerGenerated: string): string {
  return build > ledgerGenerated ? build : ledgerGenerated;
}
