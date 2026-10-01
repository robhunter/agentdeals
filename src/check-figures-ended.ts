import type { DealChange } from "./types.js";
import { statedQuantities } from "./quoted-figures.js";
import { isTrackedChange } from "./change-census.js";
import { CHANGE_IS_A_CONDITION } from "./data.js";

const FIGURES_FOLLOW = " and states ";
const QUOTED = /"([^"]*)"/g;

export function figuresOurCheckQuotes(finding: string): string[] {
  const at = finding.indexOf(FIGURES_FOLLOW);
  if (at < 0) return [];
  return [...finding.slice(at + FIGURES_FOLLOW.length).matchAll(QUOTED)].map(match => match[1]!);
}

export type EndingRecord = Pick<
  DealChange,
  "change_type" | "date" | "date_source" | "recorded_date" | "reports" | "previous_state" | "current_state" | "resolution"
>;

export interface FiguresWhoseTermsEnded<T extends EndingRecord = EndingRecord> {
  figures: string[];
  record: T;
}

function states(text: string | undefined, quantity: string): boolean {
  return statedQuantities(text ?? "").includes(quantity);
}

function recordEndingTheQuantity<T extends EndingRecord>(quantity: string, records: readonly T[]): T | null {
  const stating = records.filter(record => states(record.previous_state, quantity) || states(record.current_state, quantity));
  if (stating.length === 0) return null;
  const latest = stating.reduce((day, record) => (record.date > day ? record.date : day), "");
  const deciding = stating.filter(record => record.date === latest);
  if (deciding.some(record => states(record.current_state, quantity))) return null;
  return deciding.find(record => CHANGE_IS_A_CONDITION.has(record.change_type)) ?? null;
}

function recordEndingTheFigure<T extends EndingRecord>(figure: string, records: readonly T[]): T | null {
  const quantities = statedQuantities(figure);
  if (quantities.length === 0) return null;
  const endings = quantities.map(quantity => recordEndingTheQuantity(quantity, records));
  if (endings.some(record => record === null)) return null;
  return (endings as T[]).reduce((latest, record) => (record.date > latest.date ? record : latest));
}

export function quotedFiguresWhoseTermsEnded<T extends EndingRecord>(
  finding: string,
  vendorChanges: readonly T[],
  servedOn: string,
): FiguresWhoseTermsEnded<T>[] {
  const records = vendorChanges.filter(record => isTrackedChange(record) && record.date <= servedOn);
  const byRecord = new Map<T, string[]>();
  for (const figure of figuresOurCheckQuotes(finding)) {
    const record = recordEndingTheFigure(figure, records);
    if (record === null) continue;
    byRecord.set(record, [...(byRecord.get(record) ?? []), figure]);
  }
  return [...byRecord].map(([record, figures]) => ({ figures, record }));
}
