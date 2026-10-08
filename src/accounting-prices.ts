import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ACCOUNTING_PRICES_SLUG = "accounting-software-pricing-2026";
export const ACCOUNTING_PRICES_PATH = `/${ACCOUNTING_PRICES_SLUG}`;

export interface AccountingSource {
  label: string;
  urls: string[];
}

export interface AccountingVendorSource {
  url: string;
  covers: string;
}

export interface AccountingVendor {
  name: string;
  read_on: string;
  sources: AccountingVendorSource[];
}

export interface AccountingFreePlanRow {
  label: string;
  cells: string[];
}

export interface AccountingPriceChange {
  vendor: string;
  plan: string;
  old: string;
  new: string;
  who: string;
  from: string;
  source: AccountingSource;
}

export interface AccountingListPrice {
  vendor: string;
  plan: string;
  per_month: string;
  notes: string;
}

export interface AccountingPaymentFee {
  vendor: string;
  card: string;
  ach: string;
}

export interface AccountingLinkedWords {
  text: string;
  url: string;
}

export interface AccountingPrices {
  published: string;
  title: string;
  meta_description: string;
  lead: string;
  read_line: string;
  free_plans: { heading: string; intro: string; plans: string[]; rows: AccountingFreePlanRow[]; sources: AccountingSource[][] };
  price_changes: { heading: string; intro: string; rows: AccountingPriceChange[]; note: string };
  list_prices: { heading: string; intro: string; rows: AccountingListPrice[]; offers: string };
  payment_fees: { heading: string; rows: AccountingPaymentFee[] };
  checked_claim: { heading: string; text: string; links: AccountingLinkedWords[] };
  vendors: AccountingVendor[];
}

const ARCHIVE_CAPTURE = /^https:\/\/web\.archive\.org\/web\/(\d{4})(\d{2})(\d{2})\d{6}\/(https?:\/\/.+)$/;

export function archiveCaptureDate(url: string): string | null {
  const match = url.match(ARCHIVE_CAPTURE);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function archivedAddress(url: string): string | null {
  return url.match(ARCHIVE_CAPTURE)?.[4] ?? null;
}

export function accountingPricesPath(): string {
  return process.env.AGENTDEALS_ACCOUNTING_PRICES_PATH || path.join(__dirname, "..", "data", "accounting_prices.json");
}

export function accountingPageUrls(prices: AccountingPrices): string[] {
  return [
    ...prices.free_plans.sources.flat().flatMap((source) => source.urls),
    ...prices.price_changes.rows.flatMap((row) => row.source.urls),
    ...prices.checked_claim.links.map((link) => link.url),
  ];
}

export function readAccountingPrices(file: string = accountingPricesPath()): AccountingPrices {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the accounting software prices at ${file}: ${(err as Error).message}`);
  }
  return parseAccountingPrices(text, file);
}

export function parseAccountingPrices(text: string, file: string): AccountingPrices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = accountingPricesProblems(parsed);
  if (problems.length > 0) throw new Error(`${file} ${problems.join("; ")}`);
  return parsed as AccountingPrices;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(value: unknown): boolean {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPageAddress(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/[^\s]+$/.test(value);
}

function sourceProblems(source: unknown, at: string): string[] {
  const { label, urls } = (source ?? {}) as Partial<AccountingSource>;
  const problems: string[] = [];
  if (!isText(label)) problems.push(`${at}.label is missing`);
  if (!Array.isArray(urls) || urls.length === 0) return [...problems, `${at}.urls is empty`];
  urls.forEach((url, n) => {
    if (!isPageAddress(url)) problems.push(`${at}.urls[${n}] is not an https address`);
  });
  if (urls.length > 1 && urls.some((url) => archiveCaptureDate(url) === null)) {
    problems.push(`${at} gives several addresses, which is allowed only for Internet Archive captures`);
  }
  return problems;
}

function textFieldProblems(record: unknown, fields: readonly string[], at: string): string[] {
  const values = (record ?? {}) as Record<string, unknown>;
  return fields.filter((field) => typeof values[field] !== "string").map((field) => `${at}.${field} is missing`);
}

export function accountingPricesProblems(data: unknown): string[] {
  const prices = (data ?? {}) as Partial<AccountingPrices>;
  const problems: string[] = [];
  if (!isCalendarDay(prices.published)) problems.push("published is not a calendar day");
  for (const field of ["title", "meta_description", "lead", "read_line"] as const) {
    if (!isText(prices[field])) problems.push(`${field} is missing`);
  }

  const free = prices.free_plans;
  if (!free || !Array.isArray(free.plans) || free.plans.length === 0 || !Array.isArray(free.rows) || !Array.isArray(free.sources)) {
    problems.push("free_plans needs plans, rows and sources");
  } else {
    problems.push(...textFieldProblems(free, ["heading", "intro"], "free_plans"));
    free.rows.forEach((row, n) => {
      if (!isText(row?.label)) problems.push(`free_plans.rows[${n}].label is missing`);
      if (!Array.isArray(row?.cells) || row.cells.length !== free.plans.length || row.cells.some((cell) => typeof cell !== "string")) {
        problems.push(`free_plans.rows[${n}] needs one cell for each of the ${free.plans.length} plans`);
      }
    });
    if (free.sources.length !== free.plans.length) problems.push(`free_plans.sources needs one list for each of the ${free.plans.length} plans`);
    free.sources.forEach((list, n) => {
      if (!Array.isArray(list) || list.length === 0) problems.push(`free_plans.sources[${n}] is empty`);
      else list.forEach((source, m) => problems.push(...sourceProblems(source, `free_plans.sources[${n}][${m}]`)));
    });
  }

  const changes = prices.price_changes;
  if (!changes || !Array.isArray(changes.rows)) {
    problems.push("price_changes needs rows");
  } else {
    problems.push(...textFieldProblems(changes, ["heading", "intro", "note"], "price_changes"));
    changes.rows.forEach((row, n) => {
      problems.push(...textFieldProblems(row, ["vendor", "plan", "old", "new", "who", "from"], `price_changes.rows[${n}]`));
      problems.push(...sourceProblems(row?.source, `price_changes.rows[${n}].source`));
    });
  }

  const list = prices.list_prices;
  if (!list || !Array.isArray(list.rows)) {
    problems.push("list_prices needs rows");
  } else {
    problems.push(...textFieldProblems(list, ["heading", "intro", "offers"], "list_prices"));
    list.rows.forEach((row, n) => problems.push(...textFieldProblems(row, ["vendor", "plan", "per_month", "notes"], `list_prices.rows[${n}]`)));
  }

  const fees = prices.payment_fees;
  if (!fees || !Array.isArray(fees.rows)) {
    problems.push("payment_fees needs rows");
  } else {
    problems.push(...textFieldProblems(fees, ["heading"], "payment_fees"));
    fees.rows.forEach((row, n) => problems.push(...textFieldProblems(row, ["vendor", "card", "ach"], `payment_fees.rows[${n}]`)));
  }

  const claim = prices.checked_claim;
  if (!claim || !isText(claim.text) || !Array.isArray(claim.links)) {
    problems.push("checked_claim needs text and links");
  } else {
    problems.push(...textFieldProblems(claim, ["heading"], "checked_claim"));
    claim.links.forEach((link, n) => {
      if (!isText(link?.text) || !claim.text.includes(link.text)) problems.push(`checked_claim.links[${n}].text is not words of checked_claim.text`);
      if (!isPageAddress(link?.url)) problems.push(`checked_claim.links[${n}].url is not an https address`);
    });
  }

  if (!Array.isArray(prices.vendors) || prices.vendors.length === 0) {
    problems.push("vendors is empty");
  } else {
    prices.vendors.forEach((vendor, n) => {
      if (!isText(vendor?.name)) problems.push(`vendors[${n}].name is missing`);
      if (!isCalendarDay(vendor?.read_on)) problems.push(`vendors[${n}].read_on is not a calendar day`);
      if (!Array.isArray(vendor?.sources) || vendor.sources.length === 0) {
        problems.push(`vendors[${n}].sources is empty`);
        return;
      }
      vendor.sources.forEach((source, m) => {
        if (!isPageAddress(source?.url)) problems.push(`vendors[${n}].sources[${m}].url is not an https address`);
        if (!isText(source?.covers)) problems.push(`vendors[${n}].sources[${m}].covers is missing`);
      });
    });
  }
  return problems;
}
