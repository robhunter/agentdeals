export type NameMatchParameter = "vendor" | "vendors" | "categories";

export type NameMatchField = "vendor" | "category";

export type NameMatchHow = "exact" | "contains";

export interface AskedByName {
  parameter: NameMatchParameter;
  field: NameMatchField;
  terms: string[];
}

export interface MatchedName {
  name: string;
  records: number;
  how: NameMatchHow;
}

export interface NameMatchFilter {
  parameter: NameMatchParameter;
  field: NameMatchField;
  asked: string[];
  matched: MatchedName[];
  matched_names_omitted: number;
  records_under_a_name_you_asked_for: number;
  records_under_another_name: number;
  note: string;
}

export interface NameMatch {
  applied: boolean;
  rule: "case_insensitive_substring" | null;
  filters: NameMatchFilter[];
  note: string;
}

export interface NameBearingRecord {
  vendor: string;
  category?: string;
}

const MAX_MATCHED_NAMES = 25;
const MAX_NAMES_IN_NOTE = 6;

export const NAME_MATCH_SENTENCE =
  "Matched by case-insensitive substring, not by exact name: vendor=Pilot returns GitHub Copilot's records and "
  + "category=ai returns Email's. Nothing is narrowed on your behalf, so read name_match, which every response "
  + "carries: it names what this filter matched and whether each match was exact.";

function fieldValue(record: NameBearingRecord, field: NameMatchField): string {
  return (field === "vendor" ? record.vendor : record.category) || "";
}

function joined(parts: readonly string[], last: string): string {
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} ${last} ${parts[parts.length - 1]}`;
}

function listForNote(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES_IN_NOTE);
  const rest = names.length - shown.length;
  if (rest === 0) return joined(shown, "and");
  return `${shown.join(", ")} and ${rest} more`;
}

function askedFor(field: NameMatchField, terms: readonly string[]): string {
  return `You asked for a ${field} matching ${joined(terms.map((t) => `"${t}"`), "or")}.`;
}

function filterNote(
  field: NameMatchField,
  asked: readonly string[],
  own: number,
  foreign: number,
  foreignNames: readonly string[],
): string {
  const request = askedFor(field, asked);
  const total = own + foreign;
  if (total === 0) {
    return `${request} No record matched, under that ${field} name or any other containing it.`;
  }
  if (foreign === 0) {
    return (
      `${request} All ${total} of these records are under a ${field} name you asked for. `
      + `This filter matches any ${field} whose name contains your text, so a longer name would have been returned `
      + `here too; none is in the change log today.`
    );
  }
  if (own === 0) {
    return (
      `${request} Not one of these ${total} records is under a ${field} name you asked for — `
      + `every one is under ${listForNote(foreignNames)}, returned because this filter matches any ${field} whose `
      + `name contains your text.`
    );
  }
  return (
    `${request} ${own} of these ${total} records are under a ${field} name you asked for; the other `
    + `${foreign} are under ${listForNote(foreignNames)}, returned because this filter matches any ${field} whose `
    + `name contains your text.`
  );
}

function describeFilter(asked: AskedByName, records: readonly NameBearingRecord[]): NameMatchFilter {
  const wanted = new Set(asked.terms.map((t) => t.toLowerCase()));

  const counts = new Map<string, number>();
  for (const record of records) {
    const name = fieldValue(record, asked.field);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const ranked: MatchedName[] = [...counts.entries()]
    .map(([name, count]) => ({
      name,
      records: count,
      how: (wanted.has(name.toLowerCase()) ? "exact" : "contains") as NameMatchHow,
    }))
    .sort(
      (a, b) =>
        Number(b.how === "exact") - Number(a.how === "exact")
        || b.records - a.records
        || a.name.localeCompare(b.name),
    );

  const own = ranked.filter((m) => m.how === "exact");
  const foreign = ranked.filter((m) => m.how === "contains");
  const ownRecords = own.reduce((sum, m) => sum + m.records, 0);
  const foreignRecords = foreign.reduce((sum, m) => sum + m.records, 0);

  return {
    parameter: asked.parameter,
    field: asked.field,
    asked: [...asked.terms],
    matched: ranked.slice(0, MAX_MATCHED_NAMES),
    matched_names_omitted: Math.max(0, ranked.length - MAX_MATCHED_NAMES),
    records_under_a_name_you_asked_for: ownRecords,
    records_under_another_name: foreignRecords,
    note: filterNote(
      asked.field,
      asked.terms,
      ownRecords,
      foreignRecords,
      foreign.map((m) => m.name),
    ),
  };
}

export const NO_NAME_FILTER_NOTE =
  "No vendor or category filter was applied, so no name matching narrowed this response.";

export const NAME_MATCH_APPLIED_NOTE =
  "Name filters match by case-insensitive substring, so this response can carry records under a name you did not ask "
  + "for. Each filter below names what it matched and whether the match was exact. Counts are over total, not over "
  + "the records on this page.";

export function nameMatchDisclosure(
  asked: readonly AskedByName[],
  records: readonly NameBearingRecord[],
): NameMatch {
  if (asked.length === 0) {
    return { applied: false, rule: null, filters: [], note: NO_NAME_FILTER_NOTE };
  }
  return {
    applied: true,
    rule: "case_insensitive_substring",
    filters: asked.map((a) => describeFilter(a, records)),
    note: NAME_MATCH_APPLIED_NOTE,
  };
}
