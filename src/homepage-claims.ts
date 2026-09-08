export interface ClaimRecord {
  vendor: string;
  description?: string | null;
}

export interface NamedVendor {
  name: string;
  slug: string;
}

const CEILING = /up to \$\s?([\d][\d,]*(?:\.\d+)?)\s?([KMB])?/i;

export function programCeiling(record: ClaimRecord | undefined | null, program: string): string | null {
  const description = record?.description ?? "";
  const at = description.toLowerCase().indexOf(`${program.toLowerCase()}:`);
  if (at === -1) return null;
  const clause = description.slice(at, description.indexOf(".", at) === -1 ? undefined : description.indexOf(".", at));
  const found = clause.match(CEILING);
  if (!found) return null;
  return `$${found[1]}${found[2] ?? ""}`;
}

export const ACCELERATOR_CREDIT_VENDOR = "AWS Activate";

export const ACCELERATOR_CREDIT_PROGRAM = "Portfolio";

export function acceleratorCreditClause(ceiling: string | null): string {
  return ceiling === null
    ? "your accelerator batch comes with cloud credits"
    : `your accelerator batch gets up to ${ceiling} in AWS credits`;
}

const FIGURE = /\$\s?[\d][\d,]*(?:\.\d+)?\s?[KMB]?/g;

export function figuresIn(text: string): string[] {
  return [...text.matchAll(FIGURE)].map((m) => m[0]);
}

export function normaliseFigure(figure: string): string {
  let digits = figure.replace(/[\s$,]/g, "").toUpperCase();
  if (digits.endsWith("K")) digits = `${digits.slice(0, -1)}000`;
  else if (digits.endsWith("M")) digits = `${digits.slice(0, -1)}000000`;
  else if (digits.endsWith("B")) digits = `${digits.slice(0, -1)}000000000`;
  return String(Number(digits));
}

export function figureIsHeldBy(figure: string, corpus: readonly string[]): boolean {
  const wanted = normaliseFigure(figure);
  return corpus.some((text) => figuresIn(text).some((held) => normaliseFigure(held) === wanted));
}
