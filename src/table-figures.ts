import { statedQuantities } from "./quoted-figures.js";

const TABLE = /<table\b[\s\S]*?<\/table>/g;
const CELL = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g;
const HEADING_OR_TABLE = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<table\b[\s\S]*?<\/table>/g;
const CAPTION = /<caption\b[^>]*>([\s\S]*?)<\/caption>/;

function cellText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ");
}

export function tableCellTexts(html: string): string[] {
  return (withoutScripts(html).match(TABLE) ?? []).flatMap(table => (table.match(CELL) ?? []).map(cellText));
}

export function tableFigures(html: string): string[] {
  return tableCellTexts(html).flatMap(statedQuantities);
}

function figuresIn(table: string): string[] {
  return (table.match(CELL) ?? []).map(cellText).flatMap(statedQuantities);
}

export function tableLabels(html: string): (string | null)[] {
  const body = withoutScripts(html);
  const labels: (string | null)[] = [];
  let heading: string | null = null;
  let match: RegExpExecArray | null;
  HEADING_OR_TABLE.lastIndex = 0;
  while ((match = HEADING_OR_TABLE.exec(body)) !== null) {
    if (match[1]) heading = cellText(match[2]) || null;
    else {
      const caption = match[0].match(CAPTION);
      labels.push(caption ? cellText(caption[1]) || heading : heading);
    }
  }
  return labels;
}

import type { TableFigureCensus } from "./page-reviews.js";

export function censusTableFigures(served: string, servedWithoutTheCatalogue: string): TableFigureCensus {
  const surviving = new Map<string, number>();
  for (const figure of tableFigures(servedWithoutTheCatalogue)) {
    surviving.set(figure, (surviving.get(figure) ?? 0) + 1);
  }
  const labels = tableLabels(served);
  const tables = (withoutScripts(served).match(TABLE) ?? []).map((table, position) => {
    const figures = figuresIn(table);
    let unmoved = 0;
    for (const figure of figures) {
      const left = surviving.get(figure) ?? 0;
      if (left > 0) {
        surviving.set(figure, left - 1);
        unmoved += 1;
      }
    }
    return { label: labels[position] ?? null, figures: figures.length, from_records: figures.length - unmoved };
  });
  return {
    table_figures: tables.reduce((sum, table) => sum + table.figures, 0),
    table_figures_from_records: tables.reduce((sum, table) => sum + table.from_records, 0),
    tables,
  };
}
