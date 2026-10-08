import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCalendarDay, isPageAddress, isText, linkedWordsProblems, textFieldProblems, type LinkedWords } from "./guide-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BANKING_FEES_SLUG = "business-bank-account-fees-2026";
export const BANKING_FEES_PATH = `/${BANKING_FEES_SLUG}`;

export interface BankSource {
  url: string;
  covers: string;
}

export interface Bank {
  name: string;
  read_on: string;
  sources: BankSource[];
}

export interface FreeAccountRow {
  label: string;
  cells: string[];
}

export interface BankChange {
  bank: string;
  change: string;
  before: string;
  after: string;
  when: string;
  source: LinkedWords;
}

export interface PaidPlan {
  bank: string;
  plan: string;
  per_month: string;
  notes: string;
}

export interface BankingFees {
  published: string;
  title: string;
  meta_description: string;
  lead: string;
  read_line: string;
  free_accounts: { heading: string; intro: string; columns: string[]; rows: FreeAccountRow[] };
  changes: { heading: string; intro: string; rows: BankChange[] };
  paid_plans: { heading: string; intro: string; rows: PaidPlan[] };
  checked_claim: { heading: string } & LinkedWords;
  banks: Bank[];
}

export function bankingFeesPath(): string {
  return process.env.AGENTDEALS_BANKING_FEES_PATH || path.join(__dirname, "..", "data", "banking_fees.json");
}

export function bankingPageUrls(fees: BankingFees): string[] {
  return [
    ...fees.changes.rows.flatMap((row) => row.source.links.map((link) => link.url)),
    ...fees.checked_claim.links.map((link) => link.url),
  ];
}

export function readBankingFees(file: string = bankingFeesPath()): BankingFees {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the business bank account fees at ${file}: ${(err as Error).message}`);
  }
  return parseBankingFees(text, file);
}

export function parseBankingFees(text: string, file: string): BankingFees {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = bankingFeesProblems(parsed);
  if (problems.length > 0) throw new Error(`${file} ${problems.join("; ")}`);
  return parsed as BankingFees;
}

export function bankingFeesProblems(data: unknown): string[] {
  const fees = (data ?? {}) as Partial<BankingFees>;
  const problems: string[] = [];
  if (!isCalendarDay(fees.published)) problems.push("published is not a calendar day");
  for (const field of ["title", "meta_description", "lead", "read_line"] as const) {
    if (!isText(fees[field])) problems.push(`${field} is missing`);
  }

  const free = fees.free_accounts;
  if (!free || !Array.isArray(free.columns) || free.columns.length < 2 || !Array.isArray(free.rows)) {
    problems.push("free_accounts needs columns, at least two, and rows");
  } else {
    problems.push(...textFieldProblems(free, ["heading", "intro"], "free_accounts"));
    free.columns.forEach((column, n) => {
      if (!isText(column)) problems.push(`free_accounts.columns[${n}] is missing`);
    });
    free.rows.forEach((row, n) => {
      if (!isText(row?.label)) problems.push(`free_accounts.rows[${n}].label is missing`);
      if (!Array.isArray(row?.cells) || row.cells.length !== free.columns.length - 1 || row.cells.some((cell) => typeof cell !== "string")) {
        problems.push(`free_accounts.rows[${n}] needs one cell for each of the ${free.columns.length - 1} columns after the first`);
      }
    });
  }

  const changes = fees.changes;
  if (!changes || !Array.isArray(changes.rows)) {
    problems.push("changes needs rows");
  } else {
    problems.push(...textFieldProblems(changes, ["heading", "intro"], "changes"));
    changes.rows.forEach((row, n) => {
      problems.push(...textFieldProblems(row, ["bank", "change", "before", "after", "when"], `changes.rows[${n}]`));
      problems.push(...linkedWordsProblems(row?.source, `changes.rows[${n}].source`, true));
    });
  }

  const paid = fees.paid_plans;
  if (!paid || !Array.isArray(paid.rows)) {
    problems.push("paid_plans needs rows");
  } else {
    problems.push(...textFieldProblems(paid, ["heading", "intro"], "paid_plans"));
    paid.rows.forEach((row, n) => problems.push(...textFieldProblems(row, ["bank", "plan", "per_month", "notes"], `paid_plans.rows[${n}]`)));
  }

  const claim = fees.checked_claim;
  if (!claim) {
    problems.push("checked_claim needs a heading, text and links");
  } else {
    problems.push(...textFieldProblems(claim, ["heading"], "checked_claim"));
    problems.push(...linkedWordsProblems(claim, "checked_claim", false));
  }

  if (!Array.isArray(fees.banks) || fees.banks.length === 0) {
    problems.push("banks is empty");
  } else {
    fees.banks.forEach((bank, n) => {
      if (!isText(bank?.name)) problems.push(`banks[${n}].name is missing`);
      if (!isCalendarDay(bank?.read_on)) problems.push(`banks[${n}].read_on is not a calendar day`);
      if (!Array.isArray(bank?.sources) || bank.sources.length === 0) {
        problems.push(`banks[${n}].sources is empty`);
        return;
      }
      bank.sources.forEach((source, m) => {
        if (!isPageAddress(source?.url)) problems.push(`banks[${n}].sources[${m}].url is not an https address`);
        if (!isText(source?.covers)) problems.push(`banks[${n}].sources[${m}].covers is missing`);
      });
    });
  }
  return problems;
}
