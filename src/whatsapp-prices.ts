import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { columnTableProblems, isCalendarDay, isText, linkedWordsProblems, textFieldProblems, type ColumnTable, type LabelledRow, type LinkedWords } from "./guide-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WHATSAPP_PRICES_SLUG = "whatsapp-business-api-pricing-2026";
export const WHATSAPP_PRICES_PATH = `/${WHATSAPP_PRICES_SLUG}`;

export interface LabelledTable {
  columns: string[];
  rows: LabelledRow[];
}

export interface WhatsAppMarket {
  name: string;
  marketing: string;
  utility: string;
  authentication: string;
  service: string;
  marketing_note?: LinkedWords;
}

export interface CostExampleRow {
  label: string;
  market: string;
}

export interface WhatsAppPrices {
  published: string;
  title: string;
  meta_description: string;
  lead: string;
  read_line: string;
  free_service_messages_per_number: number;
  changes: ColumnTable;
  rates: {
    heading: string;
    intro: string;
    columns: string[];
    markets: WhatsAppMarket[];
    business_agent: LabelledTable;
    note: string;
  };
  cost_example: {
    heading: string;
    intro: string;
    columns: string[];
    replies: number;
    rows: CostExampleRow[];
  };
  free_messages: { heading: string } & LabelledTable;
  deadlines: { heading: string; text: string; calendar: LabelledTable };
  other_pages: { heading: string; text: string; sources: LinkedWords };
}

export interface CostExampleLine {
  label: string;
  rate: string;
  cost: string;
}

const RATE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const RATE_CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;
const COST_EXAMPLE_FIGURES = ["replies", "charged", "free"] as const;
const FIGURE_PLACEHOLDER = /\{([a-z_]+)\}/g;

export function whatsAppPricesPath(): string {
  return process.env.AGENTDEALS_WHATSAPP_PRICES_PATH || path.join(__dirname, "..", "data", "whatsapp_prices.json");
}

export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function dollars(rate: string): string {
  return `$${rate}`;
}

export function chargedMessages(prices: WhatsAppPrices): number {
  return Math.max(0, prices.cost_example.replies - prices.free_service_messages_per_number);
}

export function centsFor(messages: number, rate: string): bigint {
  const [whole, fraction = ""] = rate.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const hundredths = BigInt(messages) * BigInt(`${whole}${fraction}`) * 100n;
  return (hundredths * 2n + scale) / (scale * 2n);
}

export function dollarsAndCents(cents: bigint): string {
  return `$${formatCount(Number(cents / 100n))}.${String(cents % 100n).padStart(2, "0")}`;
}

export function costExampleFigures(prices: WhatsAppPrices): Record<(typeof COST_EXAMPLE_FIGURES)[number], string> {
  return {
    replies: formatCount(prices.cost_example.replies),
    charged: formatCount(chargedMessages(prices)),
    free: formatCount(prices.free_service_messages_per_number),
  };
}

export function withCostExampleFigures(prices: WhatsAppPrices, text: string): string {
  const figures = costExampleFigures(prices);
  return text.replace(FIGURE_PLACEHOLDER, (placeholder, name: string) => (name in figures ? figures[name as keyof typeof figures] : placeholder));
}

export function costExampleLines(prices: WhatsAppPrices): CostExampleLine[] {
  const charged = chargedMessages(prices);
  return prices.cost_example.rows.map((row) => {
    const market = prices.rates.markets.find((candidate) => candidate.name === row.market);
    if (!market) throw new Error(`cost_example names ${row.market}, which the rates table does not list`);
    return { label: row.label, rate: dollars(market.service), cost: dollarsAndCents(centsFor(charged, market.service)) };
  });
}

export function whatsAppPageUrls(prices: WhatsAppPrices): string[] {
  return [
    ...prices.rates.markets.flatMap((market) => market.marketing_note?.links.map((link) => link.url) ?? []),
    ...prices.other_pages.sources.links.map((link) => link.url),
  ];
}

export function readWhatsAppPrices(file: string = whatsAppPricesPath()): WhatsAppPrices {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the WhatsApp prices at ${file}: ${(err as Error).message}`);
  }
  return parseWhatsAppPrices(text, file);
}

export function parseWhatsAppPrices(text: string, file: string): WhatsAppPrices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = whatsAppPricesProblems(parsed);
  if (problems.length > 0) throw new Error(`${file} ${problems.join("; ")}`);
  return parsed as WhatsAppPrices;
}

function isWholeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function labelledTableProblems(value: unknown, at: string): string[] {
  const table = value as Partial<LabelledTable> | undefined;
  if (!table || !Array.isArray(table.columns) || table.columns.length < 2 || !Array.isArray(table.rows)) {
    return [`${at} needs columns, at least two, and rows`];
  }
  const { columns, rows } = table;
  const problems: string[] = [];
  if (!isText(columns[0])) problems.push(`${at}.columns[0] is missing`);
  columns.forEach((column, n) => {
    if (typeof column !== "string") problems.push(`${at}.columns[${n}] is not text`);
  });
  rows.forEach((row, n) => {
    if (!isText(row?.label)) problems.push(`${at}.rows[${n}].label is missing`);
    if (!Array.isArray(row?.cells) || row.cells.length !== columns.length - 1 || row.cells.some((cell) => typeof cell !== "string")) {
      problems.push(`${at}.rows[${n}] needs one cell for each of the ${columns.length - 1} columns after the first`);
    }
  });
  return problems;
}

function stringsWithin(value: unknown, at: string): Array<[string, string]> {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, n) => stringsWithin(item, `${at}[${n}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => stringsWithin(item, at ? `${at}.${key}` : key));
  return [];
}

function marketProblems(market: Partial<WhatsAppMarket> | undefined, at: string): string[] {
  const problems: string[] = [];
  if (!isText(market?.name)) problems.push(`${at}.name is missing`);
  for (const category of RATE_CATEGORIES) {
    const rate = market?.[category];
    if (typeof rate !== "string" || !RATE.test(rate)) problems.push(`${at}.${category} is not a rate in dollars, such as "0.0034"`);
  }
  if (market && RATE_CATEGORIES.every((category) => typeof market[category] === "string")) {
    const shared = [market.utility, market.authentication, market.service];
    if (new Set(shared).size > 1) problems.push(`${at} gives utility, authentication and service different rates, but the rates table prints one column for all three`);
  }
  if (market?.marketing_note !== undefined) problems.push(...linkedWordsProblems(market.marketing_note, `${at}.marketing_note`, false));
  return problems;
}

export function whatsAppPricesProblems(data: unknown): string[] {
  const prices = (data ?? {}) as Partial<WhatsAppPrices>;
  const problems: string[] = [];
  if (!isCalendarDay(prices.published)) problems.push("published is not a calendar day");
  for (const field of ["title", "meta_description", "lead", "read_line"] as const) {
    if (!isText(prices[field])) problems.push(`${field} is missing`);
  }
  if (!isWholeCount(prices.free_service_messages_per_number)) problems.push("free_service_messages_per_number is not a whole number");

  problems.push(...columnTableProblems(prices.changes, "changes"));
  if (prices.changes && Array.isArray(prices.changes.rows)) {
    stringsWithin(prices.changes, "changes")
      .filter(([, text]) => (text.match(/`/g) ?? []).length % 2 === 1)
      .forEach(([at]) => problems.push(`${at} opens a code span it does not close`));
  }

  const rates = prices.rates;
  if (!rates || !Array.isArray(rates.markets) || rates.markets.length === 0) {
    problems.push("rates needs markets");
  } else {
    problems.push(...textFieldProblems(rates, ["heading", "intro", "note"], "rates"));
    if (!Array.isArray(rates.columns) || rates.columns.length !== 3 || !rates.columns.every(isText)) {
      problems.push("rates.columns needs three: the market, the marketing rate, and the one rate for utility, authentication and service");
    }
    rates.markets.forEach((market, n) => problems.push(...marketProblems(market, `rates.markets[${n}]`)));
    const names = rates.markets.map((market) => market?.name);
    names.forEach((name, n) => {
      if (names.indexOf(name) !== n) problems.push(`rates.markets[${n}] repeats the market ${name}`);
    });
    problems.push(...labelledTableProblems(rates.business_agent, "rates.business_agent"));
  }

  const example = prices.cost_example;
  if (!example || !Array.isArray(example.rows) || example.rows.length === 0) {
    problems.push("cost_example needs rows");
  } else {
    problems.push(...textFieldProblems(example, ["heading", "intro"], "cost_example"));
    if (!Array.isArray(example.columns) || example.columns.length !== 3 || !example.columns.every(isText)) {
      problems.push("cost_example.columns needs three: who the users are, the service rate, and the cost");
    }
    if (!isWholeCount(example.replies)) problems.push("cost_example.replies is not a whole number");
    const marketNames = new Set(Array.isArray(rates?.markets) ? rates.markets.map((market) => market?.name) : []);
    example.rows.forEach((row, n) => {
      if (!isText(row?.label)) problems.push(`cost_example.rows[${n}].label is missing`);
      if (!marketNames.has(row?.market)) problems.push(`cost_example.rows[${n}].market names no market in rates.markets`);
    });
    stringsWithin({ heading: example.heading, intro: example.intro, columns: example.columns }, "cost_example").forEach(([at, text]) => {
      for (const [, name] of text.matchAll(FIGURE_PLACEHOLDER)) {
        if (!(COST_EXAMPLE_FIGURES as readonly string[]).includes(name)) problems.push(`${at} asks for {${name}}, which is not one of {${COST_EXAMPLE_FIGURES.join("}, {")}}`);
      }
    });
  }
  stringsWithin({ ...prices, cost_example: undefined }, "")
    .filter(([, text]) => /\{[a-z_]+\}/.test(text))
    .forEach(([at]) => problems.push(`${at} holds a {figure}, which only cost_example's heading, intro and columns fill`));

  const free = prices.free_messages;
  if (!free) {
    problems.push("free_messages needs a heading, columns and rows");
  } else {
    problems.push(...textFieldProblems(free, ["heading"], "free_messages"));
    problems.push(...labelledTableProblems(free, "free_messages"));
  }

  const deadlines = prices.deadlines;
  if (!deadlines) {
    problems.push("deadlines needs a heading, text and a calendar");
  } else {
    problems.push(...textFieldProblems(deadlines, ["heading", "text"], "deadlines"));
    problems.push(...labelledTableProblems(deadlines.calendar, "deadlines.calendar"));
  }

  const other = prices.other_pages;
  if (!other) {
    problems.push("other_pages needs a heading, text and sources");
  } else {
    problems.push(...textFieldProblems(other, ["heading", "text"], "other_pages"));
    problems.push(...linkedWordsProblems(other.sources, "other_pages.sources", true));
  }
  return problems;
}
