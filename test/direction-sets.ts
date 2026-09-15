import { CHANGE_DIRECTION } from "../dist/change-direction.js";

const CHANGE_TYPES = new Set(Object.keys(CHANGE_DIRECTION));

const DIRECTIONS = new Set(["negative", "positive", "neutral"]);

const CLAIMS_A_DIRECTION = /(^|[^a-z])(neg|negative|pos|positive)/i;

export interface DirectionCopy {
  identifier: string;
  shape: "collection" | "map" | "comparison chain";
  members: string[];
}

function changeTypesIn(literal: string): string[] {
  const quoted = [...literal.matchAll(/["']([a-z_]+)["']/g)].map(m => m[1]);
  return quoted.filter(q => CHANGE_TYPES.has(q));
}

function collectionCopies(source: string): DirectionCopy[] {
  const found: DirectionCopy[] = [];
  const declaration = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,80})?=\s*(?:new Set\(\s*)?\[([^\]]*)\]/g;
  for (const match of source.matchAll(declaration)) {
    const [, identifier, literal] = match;
    if (!CLAIMS_A_DIRECTION.test(identifier)) continue;
    const members = changeTypesIn(literal);
    if (members.length < 2) continue;
    found.push({ identifier, shape: "collection", members });
  }
  return found;
}

function mapCopies(source: string): DirectionCopy[] {
  const found: DirectionCopy[] = [];
  for (const match of source.matchAll(/\{([^{}]*)\}/g)) {
    const entries = [...match[1].matchAll(/([a-z_]+)\s*:\s*["'](negative|positive|neutral)["']/g)];
    const typed = entries.filter(e => CHANGE_TYPES.has(e[1]) && DIRECTIONS.has(e[2]));
    if (typed.length < 2) continue;
    found.push({ identifier: "object literal", shape: "map", members: typed.map(e => `${e[1]}: ${e[2]}`) });
  }
  return found;
}

function comparisonChains(source: string): DirectionCopy[] {
  const found: DirectionCopy[] = [];
  const declaration = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,80})?=\s*([^;]{0,400});/g;
  for (const match of source.matchAll(declaration)) {
    const [, identifier, expression] = match;
    if (!CLAIMS_A_DIRECTION.test(identifier)) continue;
    const compared = [...expression.matchAll(/change_type\s*===\s*["']([a-z_]+)["']/g)].map(m => m[1]);
    const members = compared.filter(c => CHANGE_TYPES.has(c));
    if (members.length < 2) continue;
    found.push({ identifier, shape: "comparison chain", members });
  }
  return found;
}

export function directionCopiesIn(source: string): DirectionCopy[] {
  return [...collectionCopies(source), ...mapCopies(source), ...comparisonChains(source)];
}

export function describeCopy(file: string, copy: DirectionCopy): string {
  return `${file}: ${copy.identifier} (${copy.shape}) — ${copy.members.join(", ")}`;
}
