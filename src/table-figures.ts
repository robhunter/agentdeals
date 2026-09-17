import { statedQuantities } from "./quoted-figures.js";

const TABLE = /<table\b[\s\S]*?<\/table>/g;
const CELL = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g;

function cellText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tableCellTexts(html: string): string[] {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ");
  return (body.match(TABLE) ?? []).flatMap(table => (table.match(CELL) ?? []).map(cellText));
}

export function tableFigures(html: string): string[] {
  return tableCellTexts(html).flatMap(statedQuantities);
}

import type { TableFigureCensus } from "./page-reviews.js";

export function censusTableFigures(served: string, servedWithoutTheCatalogue: string): TableFigureCensus {
  const surviving = new Map<string, number>();
  for (const figure of tableFigures(servedWithoutTheCatalogue)) {
    surviving.set(figure, (surviving.get(figure) ?? 0) + 1);
  }
  const figures = tableFigures(served);
  let unmoved = 0;
  for (const figure of figures) {
    const left = surviving.get(figure) ?? 0;
    if (left > 0) {
      surviving.set(figure, left - 1);
      unmoved += 1;
    }
  }
  return { table_figures: figures.length, table_figures_from_records: figures.length - unmoved };
}
