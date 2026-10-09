import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { columnTableProblems, isCalendarDay, isPageAddress, isText, linkedWordsProblems, textFieldProblems, type ColumnTable, type LinkedWords } from "./guide-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const COMPANY_FORMATION_SLUG = "company-formation-pricing-2026";
export const COMPANY_FORMATION_PATH = `/${COMPANY_FORMATION_SLUG}`;

export interface FormationSourcePage {
  url: string;
  covers: string;
}

export interface FormationSource {
  name: string;
  read_on: string;
  sources: FormationSourcePage[];
}

export interface FormationChange {
  who: string;
  change: string;
  before: string;
  after: string;
  when: string;
  source: LinkedWords;
}

export interface CompanyFormationPrices {
  published: string;
  title: string;
  meta_description: string;
  lead: string;
  read_line: string;
  services: ColumnTable & { note: string };
  changes: { heading: string; intro: string; rows: FormationChange[] };
  delaware_costs: ColumnTable;
  checked_claim: { heading: string } & LinkedWords;
  sources: FormationSource[];
}

export function companyFormationPricesPath(): string {
  return process.env.AGENTDEALS_COMPANY_FORMATION_PRICES_PATH || path.join(__dirname, "..", "data", "company_formation_prices.json");
}

export function companyFormationPageUrls(prices: CompanyFormationPrices): string[] {
  return [
    ...prices.changes.rows.flatMap((row) => row.source.links.map((link) => link.url)),
    ...prices.checked_claim.links.map((link) => link.url),
  ];
}

export function readCompanyFormationPrices(file: string = companyFormationPricesPath()): CompanyFormationPrices {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the company formation prices at ${file}: ${(err as Error).message}`);
  }
  return parseCompanyFormationPrices(text, file);
}

export function parseCompanyFormationPrices(text: string, file: string): CompanyFormationPrices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = companyFormationPricesProblems(parsed);
  if (problems.length > 0) throw new Error(`${file} ${problems.join("; ")}`);
  return parsed as CompanyFormationPrices;
}

export function companyFormationPricesProblems(data: unknown): string[] {
  const prices = (data ?? {}) as Partial<CompanyFormationPrices>;
  const problems: string[] = [];
  if (!isCalendarDay(prices.published)) problems.push("published is not a calendar day");
  for (const field of ["title", "meta_description", "lead", "read_line"] as const) {
    if (!isText(prices[field])) problems.push(`${field} is missing`);
  }

  problems.push(...columnTableProblems(prices.services, "services"));
  if (prices.services) problems.push(...textFieldProblems(prices.services, ["note"], "services"));

  const changes = prices.changes;
  if (!changes || !Array.isArray(changes.rows)) {
    problems.push("changes needs rows");
  } else {
    problems.push(...textFieldProblems(changes, ["heading", "intro"], "changes"));
    changes.rows.forEach((row, n) => {
      problems.push(...textFieldProblems(row, ["who", "change", "before", "after", "when"], `changes.rows[${n}]`));
      problems.push(...linkedWordsProblems(row?.source, `changes.rows[${n}].source`, true));
    });
  }

  problems.push(...columnTableProblems(prices.delaware_costs, "delaware_costs"));

  const claim = prices.checked_claim;
  if (!claim) {
    problems.push("checked_claim needs a heading, text and links");
  } else {
    problems.push(...textFieldProblems(claim, ["heading"], "checked_claim"));
    problems.push(...linkedWordsProblems(claim, "checked_claim", false));
  }

  if (!Array.isArray(prices.sources) || prices.sources.length === 0) {
    problems.push("sources is empty");
  } else {
    prices.sources.forEach((source, n) => {
      if (!isText(source?.name)) problems.push(`sources[${n}].name is missing`);
      if (!isCalendarDay(source?.read_on)) problems.push(`sources[${n}].read_on is not a calendar day`);
      if (!Array.isArray(source?.sources) || source.sources.length === 0) {
        problems.push(`sources[${n}].sources is empty`);
        return;
      }
      source.sources.forEach((page, m) => {
        if (!isPageAddress(page?.url)) problems.push(`sources[${n}].sources[${m}].url is not an https address`);
        if (typeof page?.covers !== "string") problems.push(`sources[${n}].sources[${m}].covers is missing`);
      });
    });
  }
  return problems;
}
