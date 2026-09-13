const RANKING_SUPERLATIVES: Record<string, "max" | "min"> = {
  highest: "max",
  most: "max",
  largest: "max",
  biggest: "max",
  greatest: "max",
  max: "max",
  maximum: "max",
  longest: "max",
  cheapest: "min",
  lowest: "min",
  smallest: "min",
  shortest: "min",
  fewest: "min",
};

const UNRANKED_SUPERLATIVES = ["best", "fastest", "simplest", "leader", "leading", "widest"];

export type ClaimDirection = "max" | "min";

export interface SuperlativeClaim {
  kind: "card" | "badge";
  label: string;
  direction: ClaimDirection | null;
  dimension: string;
  subject: string;
  value: string;
  tableIndex: number | null;
}

export interface TableRow {
  subject: string;
  cells: string[];
  badges: string[];
}

export interface PageTable {
  heading: string;
  headers: string[];
  rows: TableRow[];
}

const TABLE = /<table\b[\s\S]*?<\/table>/g;
const TABLE_ROW = /<tr\b[\s\S]*?<\/tr>/g;
const ROW_CELL = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g;
const STAT_CARD =
  /<div\b[^>]*class="[^"]*\bstat-card\b[^"]*"[^>]*>\s*<div\b[^>]*class="[^"]*\bstat-(?:number|value)\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class="[^"]*\bstat-label\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
const BADGE_SPAN = /<span\b[^>]*class="[^"]*\b(?:winner-badge|pick-badge)\b[^"]*"[^>]*>([^<]*)<\/span>/g;
const DECORATION_SPAN =
  /<(a|span)\b[^>]*class="[^"]*\b(?:record-source|unsourced-tag|winner-badge|pick-badge|change-flag|row-flag)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g;

export function plainText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(fragment: string): string {
  return plainText(fragment.replace(new RegExp(DECORATION_SPAN.source, "g"), " "));
}

const SECTION_HEADING = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/g;
const LEADING_VENDOR_ANCHOR = /^\s*<a\b[^>]*href="\/vendor\/[a-z0-9][a-z0-9-]*"[^>]*>([^<]*)<\/a>/;
const CELL_OPENING_TAG = /^<t[dh]\b[^>]*>/;

function headingBefore(html: string, at: number): string {
  const scan = new RegExp(SECTION_HEADING.source, "g");
  let heading = "";
  for (let found = scan.exec(html); found !== null && found.index < at; found = scan.exec(html)) {
    heading = plainText(found[1]!);
  }
  return heading;
}

function subjectOf(cell: string): string {
  const inner = cell.replace(CELL_OPENING_TAG, "");
  const linked = inner.match(LEADING_VENDOR_ANCHOR);
  if (linked) return plainText(linked[1]!);
  const leading = plainText(inner.split(/<(?:span|a)\b/)[0]!);
  return leading || cellText(cell);
}

function badgesIn(fragment: string): string[] {
  const badges: string[] = [];
  const scan = new RegExp(BADGE_SPAN.source, "g");
  for (let found = scan.exec(fragment); found !== null; found = scan.exec(fragment)) {
    badges.push(plainText(found[1]!));
  }
  return badges;
}

export function pageTables(html: string): PageTable[] {
  const tables: PageTable[] = [];
  const scan = new RegExp(TABLE.source, "g");
  for (let found = scan.exec(html); found !== null; found = scan.exec(html)) {
    const rows = found[0].match(TABLE_ROW) ?? [];
    if (rows.length < 2) continue;
    const headers = (rows[0]!.match(ROW_CELL) ?? []).map(cellText);
    const body: TableRow[] = [];
    for (const row of rows.slice(1)) {
      const cells = row.match(ROW_CELL) ?? [];
      if (cells.length === 0) continue;
      body.push({
        subject: subjectOf(cells[0]!),
        cells: cells.map(cellText),
        badges: badgesIn(row),
      });
    }
    if (headers.length > 1 && body.length > 0) {
      tables.push({ heading: headingBefore(html, found.index), headers, rows: body });
    }
  }
  return tables;
}

function superlativeIn(label: string): { word: string; direction: ClaimDirection | null } | null {
  const words = label.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const word of words) {
    if (word in RANKING_SUPERLATIVES) return { word, direction: RANKING_SUPERLATIVES[word]! };
  }
  for (const word of words) {
    if (UNRANKED_SUPERLATIVES.includes(word)) return { word, direction: null };
  }
  return null;
}

function splitLabel(label: string): { dimension: string; subject: string } {
  const parenthesised = label.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const subject = parenthesised ? parenthesised[2]!.trim() : "";
  const head = parenthesised ? parenthesised[1]! : label;
  const dimension = head
    .toLowerCase()
    .replace(/[a-z]+/g, word => (word in RANKING_SUPERLATIVES || UNRANKED_SUPERLATIVES.includes(word) ? " " : word))
    .replace(/[^a-z0-9 /-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { dimension, subject };
}

function looksLikeQuantity(text: string): boolean {
  return /\d/.test(text) || /^\s*(unlimited|none|n\/a)\b/i.test(text);
}

export function superlativeClaims(html: string): SuperlativeClaim[] {
  const claims: SuperlativeClaim[] = [];
  const cards = new RegExp(STAT_CARD.source, "g");
  for (let found = cards.exec(html); found !== null; found = cards.exec(html)) {
    const label = plainText(found[2]!);
    const superlative = superlativeIn(label);
    if (!superlative) continue;
    const { dimension, subject } = splitLabel(label);
    const value = plainText(found[1]!);
    claims.push({
      kind: "card",
      label,
      direction: superlative.direction,
      dimension,
      subject: subject || (looksLikeQuantity(value) ? "" : value),
      value: looksLikeQuantity(value) ? value : "",
      tableIndex: null,
    });
  }
  pageTables(html).forEach((table, tableIndex) => {
    for (const row of table.rows) {
      for (const badge of row.badges) {
        const superlative = superlativeIn(badge);
        if (!superlative) continue;
        claims.push({
          kind: "badge",
          label: badge,
          direction: superlative.direction,
          dimension: splitLabel(badge).dimension,
          subject: row.subject,
          value: "",
          tableIndex,
        });
      }
    }
  });
  return claims;
}

export type QuantityUnit = "count" | "bytes" | "currency" | "duration";

export interface Quantity {
  amount: number;
  unit: QuantityUnit;
  monthly: boolean;
  unbounded: boolean;
}

const UNBOUNDED = /\bunlimited\b/i;
const MAGNITUDE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
const BYTES: Record<string, number> = {
  mb: 1 / 1024,
  mib: 1 / 1024,
  gb: 1,
  gib: 1,
  tb: 1024,
  tib: 1024,
  pb: 1024 * 1024,
};
const DURATION: Record<string, number> = { min: 1, mins: 1, minute: 1, minutes: 1, hr: 60, hrs: 60, hour: 60, hours: 60 };
const UNIT_TOKEN = "bn|[kmb]|mib|gib|tib|mb|gb|tb|pb|mins?|minutes?|hrs?|hours?";
const QUANTITY = new RegExp(
  `(\\$|€|£)?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:(?!(?:${UNIT_TOKEN})\\b)[a-z]+\\s+)?(?:(${UNIT_TOKEN})\\b)?`,
  "gi",
);
const NORMALISED_PARENTHETICAL = /\(\s*~\s*([^)]*?)\s*\)/;
const PER_MONTH = /\/\s*(?:mo\b|month|30 days)|per month|\bmonthly\b/i;
const A_SPAN_RATHER_THAN_A_RATE = /^\s*\d[\d,]*\s*(?:days?|months?|years?)\s*$/i;
const PER_DAY = /\/\s*day\b|per day|\bdaily\b/i;
const PER_YEAR = /\/\s*(?:yr\b|year)|per year|\bannually\b/i;

function periodMultiplier(text: string): number | null {
  if (A_SPAN_RATHER_THAN_A_RATE.test(text)) return null;
  if (PER_MONTH.test(text)) return 1;
  if (PER_DAY.test(text)) return 30;
  if (PER_YEAR.test(text)) return 1 / 12;
  return null;
}

function withoutThePeriod(text: string): string {
  return text
    .replace(new RegExp(PER_MONTH.source, "gi"), " ")
    .replace(new RegExp(PER_DAY.source, "gi"), " ")
    .replace(new RegExp(PER_YEAR.source, "gi"), " ");
}

export function parseQuantity(raw: string): Quantity | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const normalised = text.match(NORMALISED_PARENTHETICAL);
  if (normalised && /\d/.test(normalised[1]!)) return parseQuantity(normalised[1]!);
  const unbounded = UNBOUNDED.test(text);
  if (unbounded && !/\d/.test(text)) {
    return { amount: Number.POSITIVE_INFINITY, unit: "count", monthly: false, unbounded: true };
  }
  if (unbounded) return null;
  const scan = new RegExp(QUANTITY.source, "gi");
  const readings: Quantity[] = [];
  const period = periodMultiplier(text);
  const stated = period === null ? text : withoutThePeriod(text);
  for (let found = scan.exec(stated); found !== null; found = scan.exec(stated)) {
    const currency = found[1];
    const digits = Number(found[2]!.replace(/,/g, ""));
    if (!Number.isFinite(digits)) continue;
    const suffix = (found[3] ?? "").toLowerCase().trim();
    let unit: QuantityUnit = "count";
    let amount = digits;
    if (suffix in BYTES) {
      unit = "bytes";
      amount = digits * BYTES[suffix]!;
    } else if (suffix in DURATION) {
      unit = "duration";
      amount = digits * DURATION[suffix]!;
    } else if (suffix in MAGNITUDE) {
      amount = digits * MAGNITUDE[suffix]!;
    }
    if (currency) unit = "currency";
    readings.push({ amount, unit, monthly: period !== null, unbounded: false });
  }
  if (readings.length !== 1) return null;
  const only = readings[0]!;
  return { ...only, amount: period === null ? only.amount : only.amount * period };
}

export function outranks(candidate: Quantity, held: Quantity, direction: ClaimDirection): boolean | null {
  if (candidate.unbounded && held.unbounded) return false;
  if (candidate.unbounded) return direction === "max";
  if (held.unbounded) return direction === "min";
  if (candidate.unit !== held.unit) return null;
  if (candidate.monthly !== held.monthly) return null;
  return direction === "max" ? candidate.amount > held.amount : candidate.amount < held.amount;
}

const UNINFORMATIVE_WORDS = new Set([
  "the", "and", "for", "per", "your", "with", "tier", "plan", "overall", "generous", "each", "all", "any", "our",
]);

function singular(word: string): string {
  if (!word.endsWith("s") || word.length <= 3) return word;
  if (/(?:ss|us|is)$/.test(word)) return word;
  return word.slice(0, -1);
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter(word => word.length > 2 && !UNINFORMATIVE_WORDS.has(word))
    .map(singular);
}

export interface ResolvedColumn {
  tableIndex: number;
  columnIndex: number;
  header: string;
}

export function resolveColumn(claim: SuperlativeClaim, tables: PageTable[]): ResolvedColumn | null {
  const wanted = contentWords(claim.dimension);
  if (wanted.length === 0) return null;
  const candidates: ResolvedColumn[] = [];
  const searched = claim.tableIndex === null ? tables.map((_, index) => index) : [claim.tableIndex];
  for (const tableIndex of searched) {
    const table = tables[tableIndex];
    if (!table) continue;
    const headingWords = contentWords(table.heading);
    table.headers.forEach((header, columnIndex) => {
      if (columnIndex === 0) return;
      const words = contentWords(header);
      if (words.length === 0) return;
      if (!wanted.some(word => words.includes(word))) return;
      if (!wanted.every(word => words.includes(word) || headingWords.includes(word))) return;
      candidates.push({ tableIndex, columnIndex, header });
    });
  }
  if (candidates.length === 0) return null;
  if (claim.tableIndex !== null) return candidates[0]!;
  const subject = claim.subject.toLowerCase();
  const naming = candidates.filter(({ tableIndex }) =>
    tables[tableIndex]!.rows.some(row => namesSubject(row.subject, subject)),
  );
  return (naming[0] ?? candidates[0])!;
}

function namesSubject(rowSubject: string, subject: string): boolean {
  if (!subject) return false;
  const row = rowSubject.toLowerCase();
  if (row === subject) return true;
  return new RegExp(`(^|[^a-z0-9])${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(row);
}

function claimSubjects(claim: SuperlativeClaim): string[] {
  const subject = claim.subject.toLowerCase().trim();
  if (!subject) return [];
  const withoutSuffix = subject.replace(/\s+(from|on|in|at|with|by)\s+.*$/, "").trim();
  return withoutSuffix && withoutSuffix !== subject ? [subject, withoutSuffix] : [subject];
}

export function subjectRow(claim: SuperlativeClaim, table: PageTable): TableRow | null {
  for (const subject of claimSubjects(claim)) {
    const row = table.rows.find(candidate => namesSubject(candidate.subject, subject));
    if (row) return row;
  }
  return null;
}

function denominatedBy(claim: SuperlativeClaim, table: PageTable, columnIndex: number): string | null {
  for (const word of contentWords(claim.dimension)) {
    const carrying = table.rows.filter(row => {
      const cell = row.cells[columnIndex];
      return cell !== undefined && contentWords(cell).includes(word);
    });
    if (carrying.length >= 2) return word;
  }
  return null;
}

export interface RefutedClaim {
  claim: SuperlativeClaim;
  column: ResolvedColumn;
  held: string;
  beatenBy: string;
  beatingCell: string;
}

export interface UngradedClaim {
  claim: SuperlativeClaim;
  reason: string;
}

export interface UpheldClaim {
  claim: SuperlativeClaim;
  column: ResolvedColumn;
  held: string;
  subject: string;
  comparands: number;
}

export interface GradedPage {
  refuted: RefutedClaim[];
  unattained: RefutedClaim[];
  ungraded: UngradedClaim[];
  upheld: UpheldClaim[];
  graded: number;
}

export function gradeSuperlatives(html: string): GradedPage {
  const tables = pageTables(html);
  const refuted: RefutedClaim[] = [];
  const unattained: RefutedClaim[] = [];
  const ungraded: UngradedClaim[] = [];
  const upheld: UpheldClaim[] = [];
  let graded = 0;
  for (const claim of superlativeClaims(html)) {
    if (claim.direction === null) {
      ungraded.push({ claim, reason: "the label ranks nothing a column can settle" });
      continue;
    }
    const column = resolveColumn(claim, tables);
    if (!column) {
      ungraded.push({ claim, reason: "no column on the page carries the dimension the label names" });
      continue;
    }
    const table = tables[column.tableIndex]!;
    const row = subjectRow(claim, table);
    const ownCell = row ? row.cells[column.columnIndex] ?? "" : "";
    const heldText = parseQuantity(ownCell) ? ownCell : ownCell && claim.value ? claim.value : ownCell || claim.value;
    const held = parseQuantity(heldText);
    if (!held) {
      ungraded.push({ claim, reason: `the value being claimed reads "${heldText}", which is not a quantity` });
      continue;
    }
    const denomination = denominatedBy(claim, table, column.columnIndex);
    let comparands = 0;
    let beaten: RefutedClaim | null = null;
    let attained = false;
    for (const candidate of table.rows) {
      if (row && candidate === row) continue;
      const cell = candidate.cells[column.columnIndex];
      if (cell === undefined) continue;
      if (denomination && !contentWords(cell).includes(denomination)) continue;
      const other = parseQuantity(cell);
      if (!other) continue;
      const verdict = outranks(other, held, claim.direction);
      if (verdict === null) continue;
      comparands += 1;
      if (verdict && !beaten) {
        beaten = { claim, column, held: heldText, beatenBy: candidate.subject, beatingCell: cell };
      }
      if (!verdict && outranks(held, other, claim.direction) === false) attained = true;
    }
    if (comparands === 0) {
      ungraded.push({ claim, reason: "no other row in that column states a comparable quantity" });
      continue;
    }
    graded += 1;
    if (beaten) {
      refuted.push(beaten);
      continue;
    }
    if (!row && !attained) {
      unattained.push({ claim, column, held: heldText, beatenBy: "", beatingCell: "" });
      continue;
    }
    upheld.push({ claim, column, held: heldText, subject: row ? row.subject : claim.subject, comparands });
  }
  return { refuted, unattained, ungraded, upheld, graded };
}

export function outrankedElsewhere(upheld: UpheldClaim, tables: PageTable[]): boolean {
  const held = parseQuantity(upheld.held);
  if (!held) return true;
  const wanted = upheld.column.header.trim().toLowerCase();
  for (const [tableIndex, table] of tables.entries()) {
    for (const [columnIndex, header] of table.headers.entries()) {
      if (header.trim().toLowerCase() !== wanted) continue;
      const denomination = denominatedBy(upheld.claim, table, columnIndex);
      for (const row of table.rows) {
        if (tableIndex === upheld.column.tableIndex && row.subject === upheld.subject) continue;
        const cell = row.cells[columnIndex];
        if (cell === undefined) continue;
        if (denomination && !contentWords(cell).includes(denomination)) continue;
        const other = parseQuantity(cell);
        if (other && outranks(other, held, "max")) return true;
      }
    }
  }
  return false;
}

export function measuresTheFreeTier(upheld: UpheldClaim, tables: PageTable[]): boolean {
  const table = tables[upheld.column.tableIndex];
  return /\bfree\b/i.test(upheld.column.header) || /\bfree\b/i.test(table?.heading ?? "");
}

export interface ContradictorySuperlative {
  header: string;
  direction: ClaimDirection;
  subjects: string[];
  labels: string[];
}

export function contradictorySuperlatives(html: string): ContradictorySuperlative[] {
  const tables = pageTables(html);
  const byColumn = new Map<string, { subjects: Map<string, string>; labels: Set<string>; header: string }>();
  for (const claim of superlativeClaims(html)) {
    if (claim.direction === null) continue;
    const column = resolveColumn(claim, tables);
    if (!column) continue;
    const row = subjectRow(claim, tables[column.tableIndex]!);
    const named = row ? row.subject : claim.subject;
    if (!named) continue;
    const key = `${column.header.toLowerCase()}|${claim.direction}`;
    const group = byColumn.get(key) ?? { subjects: new Map(), labels: new Set(), header: column.header };
    group.subjects.set(named.toLowerCase(), named);
    group.labels.add(claim.label);
    byColumn.set(key, group);
  }
  const found: ContradictorySuperlative[] = [];
  for (const [key, group] of byColumn) {
    if (group.subjects.size < 2) continue;
    found.push({
      header: group.header,
      direction: key.endsWith("min") ? "min" : "max",
      subjects: [...group.subjects.values()].sort(),
      labels: [...group.labels].sort(),
    });
  }
  return found.sort((a, b) => a.header.localeCompare(b.header));
}

export interface StatCard {
  value: string;
  label: string;
}

export function statCards(html: string): StatCard[] {
  const cards: StatCard[] = [];
  const scan = new RegExp(STAT_CARD.source, "g");
  for (let found = scan.exec(html); found !== null; found = scan.exec(html)) {
    cards.push({ value: plainText(found[1]!), label: plainText(found[2]!) });
  }
  return cards;
}

const NAV_ENTRY = /<li><a href="#[^"]*">([^<]*)<\/a>\s*\((\d[\d,]*)\s+([a-z]+)\)<\/li>/g;
const SECTION_QUALIFIER = /\s+[—–-]\s+.*$/;

function sectionKey(label: string): string {
  return label
    .replace(SECTION_QUALIFIER, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface SectionCount {
  label: string;
  counted: number;
  noun: string;
}

export function navigatedSections(html: string): Map<string, SectionCount> {
  const sections = new Map<string, SectionCount>();
  const scan = new RegExp(NAV_ENTRY.source, "g");
  for (let found = scan.exec(html); found !== null; found = scan.exec(html)) {
    const label = plainText(found[1]!);
    sections.set(sectionKey(label), {
      label,
      counted: Number(found[2]!.replace(/,/g, "")),
      noun: found[3]!,
    });
  }
  return sections;
}

export interface MiscountedCard {
  label: string;
  carded: number;
  section: SectionCount;
}

export function miscountedCards(html: string): MiscountedCard[] {
  const sections = navigatedSections(html);
  const found: MiscountedCard[] = [];
  for (const card of statCards(html)) {
    if (!/^\d[\d,]*$/.test(card.value)) continue;
    const section = sections.get(sectionKey(card.label.replace(/\s*\([^)]*\)\s*$/, "")));
    if (!section) continue;
    const carded = Number(card.value.replace(/,/g, ""));
    if (carded !== section.counted) found.push({ label: card.label, carded, section });
  }
  return found;
}

export function unresolvedStatCardSubjects(html: string, resolver: {
  slugsFor: (phrase: string) => string[];
  isNonVendor: (phrase: string) => boolean;
}): string[] {
  const tables = pageTables(html);
  const unresolved = new Set<string>();
  for (const claim of superlativeClaims(html)) {
    if (claim.kind !== "card") continue;
    const subject = claim.subject.trim();
    if (!subject) continue;
    if (resolver.isNonVendor(subject)) continue;
    if (claimSubjects(claim).some(candidate => resolver.slugsFor(candidate).length > 0)) continue;
    const tabulated = tables.map(table => subjectRow(claim, table)).find(row => row !== null);
    if (tabulated && resolver.slugsFor(tabulated.subject).length > 0) continue;
    unresolved.add(subject);
  }
  return [...unresolved].sort();
}
