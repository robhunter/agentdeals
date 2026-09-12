import ts from "typescript";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PAGE_SOURCE = path.join(REPO, "src", "serve.ts");

export interface HardcodedRow {
  array: string | null;
  builder: string | null;
  line: number;
  slug: string;
  fields: Record<string, string>;
}

function declaredName(node: ts.Node): string | null {
  let at: ts.Node | undefined = node.parent;
  while (at) {
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isPropertyAssignment(at) && (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))) return at.name.text;
    at = at.parent;
  }
  return null;
}

function enclosingBuilder(node: ts.Node): string | null {
  let at: ts.Node | undefined = node.parent;
  while (at) {
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
    at = at.parent;
  }
  return null;
}

function stringFields(object: ts.ObjectLiteralExpression): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const named = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
    if (!named) continue;
    if (ts.isStringLiteralLike(property.initializer)) fields[named] = property.initializer.text;
  }
  return fields;
}

export function hardcodedRowsCarryingASlug(source?: string): HardcodedRow[] {
  const text = source ?? readFileSync(PAGE_SOURCE, "utf-8");
  const parsed = ts.createSourceFile("serve.ts", text, ts.ScriptTarget.ES2022, true);
  const rows: HardcodedRow[] = [];

  const read = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        const fields = stringFields(element);
        if (!fields.slug) continue;
        rows.push({
          array: declaredName(node),
          builder: enclosingBuilder(node),
          line: parsed.getLineAndCharacterOfPosition(element.getStart(parsed)).line + 1,
          slug: fields.slug,
          fields,
        });
      }
    }
    ts.forEachChild(node, read);
  };
  read(parsed);

  return rows;
}

export function arraysHoldingASlug(rows: HardcodedRow[]): string[] {
  return [...new Set(rows.map(row => `${row.builder ?? "module"}.${row.array ?? "anonymous"}`))].sort();
}

export function buildersHoldingASlug(rows: HardcodedRow[]): string[] {
  return [...new Set(rows.map(row => row.builder).filter((name): name is string => name !== null))].sort();
}

const NAMES_THE_FREE_TIER = /^free/i;

const DENIES_IT = /^\s*(?:no\b|non-existent|none\b|n\/?a\b|not\b|never\b|zero\b|removed\b|retired\b|ended\b|discontinued\b|withdrawn\b|unavailable\b|[—–-]\s*$)/i;

const STATES_FREENESS = /\bfree\b|\bno cost\b|\$0(?![.,\d])/i;

const ENDED = "removed|retired|retirement|ended|withdrawn|discontinued|eliminated|sunset";

const STATES_THERE_IS_NO_FREE_TIER = new RegExp(
  [
    "\\bno free (?:tier|plan|allowance)\\b",
    "\\bnone free\\b",
    `\\bfree\\b[^.]{0,30}\\b(?:${ENDED})\\b`,
    `\\b(?:${ENDED})\\b[^.]{0,30}\\bfree\\b`,
    "\\bno longer\\b[^.]{0,30}\\bfree\\b",
    "\\b(?:retired|discontinued|sunset|withdrawn)\\b",
  ].join("|"),
  "i",
);

export function fieldNamesTheFreeTier(field: string): boolean {
  return NAMES_THE_FREE_TIER.test(field);
}

export function deniesTheFreeTier(value: string): boolean {
  return DENIES_IT.test(value) || STATES_THERE_IS_NO_FREE_TIER.test(value);
}

export function statesThereIsNoFreeTier(value: string): boolean {
  return STATES_THERE_IS_NO_FREE_TIER.test(value);
}

export function affirmsAFreeTier(field: string, value: string): boolean {
  if (field === "slug" || field === "name" || value.trim() === "") return false;
  if (deniesTheFreeTier(value)) return false;
  if (fieldNamesTheFreeTier(field)) return true;
  return STATES_FREENESS.test(value);
}

export function freeTierClaimsIn(row: HardcodedRow): string[] {
  return Object.entries(row.fields)
    .filter(([field, value]) => affirmsAFreeTier(field, value))
    .map(([field]) => field)
    .sort();
}

export function fieldsDenyingTheFreeTier(row: HardcodedRow): string[] {
  return Object.entries(row.fields)
    .filter(([, value]) => statesThereIsNoFreeTier(value))
    .map(([field]) => field)
    .sort();
}

export function rowAt(rows: HardcodedRow[], builder: string, array: string, slug: string): HardcodedRow | null {
  return rows.find(row => row.builder === builder && row.array === array && row.slug === slug) ?? null;
}
