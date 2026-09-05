export type Quantity = { quantity: number; unit: string; per: string | null; text: string; index: number };

export type Figure = {
  vendor: string;
  plan: string | null;
  dimension: string | null;
  clause: string;
  block: string;
  quantity: Quantity;
  source: "table-column" | "table-row" | "sentence";
};

export type RecordClause = {
  text: string;
  plan: string | null;
  dimension: string | null;
  quantity: Quantity;
};

export type Disagreement = {
  route: string;
  vendor: string;
  plan: string | null;
  dimension: string;
  published: string;
  publishedFigure: string;
  recordClause: string;
  recordFigure: string;
  source: Figure["source"];
};

const NON_VENDOR_COLUMNS =
  /^(notes?|best for|why|details?|comments?|verdict|use case|feature|usage scenario|platform|provider|service|tier|category|winner|stability|what changed|when you)/i;

const PER_UNIT = /^\s*(?:\/|per\s+)([a-z][a-z-]*)/i;

const UNIT_FAMILIES: Array<{ unit: string; pattern: RegExp; scale: (raw: number, m: RegExpMatchArray) => number }> = [
  {
    unit: "bytes",
    pattern: /(\d[\d,]*(?:\.\d+)?)\s*(TB|TiB|GB|GiB|MB|MiB|KB)\b/gi,
    scale: (raw, m) =>
      raw * ({ tb: 1e12, tib: 2 ** 40, gb: 1e9, gib: 2 ** 30, mb: 1e6, mib: 2 ** 20, kb: 1e3 }[m[2].toLowerCase()] ?? 1),
  },
  { unit: "usd", pattern: /\$\s?(\d[\d,]*(?:\.\d+)?)/g, scale: (raw) => raw },
  { unit: "hours", pattern: /(\d[\d,]*(?:\.\d+)?)\s*(?:hrs?|hours)\b/gi, scale: (raw) => raw },
  { unit: "credits", pattern: /(\d[\d,]*)\s*credits?\b/gi, scale: (raw) => raw },
  {
    unit: "count",
    pattern:
      /(\d[\d,]*(?:\.\d+)?)\s*(M|K)?\s*(?:requests?|req|invocations?|builds?|deploys?|users?|MAU|services?|projects?|seats?|domains?|sites?|replicas?|environments?|vCPUs?)\b/gi,
    scale: (raw, m) => raw * (m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1),
  },
];

const DIMENSIONS: Array<{ name: string; pattern: RegExp }> = [
  { name: "database-size", pattern: /\b(database size|db size|database storage|postgres storage|rows?)\b/i },
  { name: "file-storage", pattern: /\b(file storage|object storage|blob storage|cloud storage|bucket)\b/i },
  { name: "cached-bandwidth", pattern: /\bcached\s+(?:egress|bandwidth)\b/i },
  { name: "bandwidth", pattern: /\b(bandwidth|egress|transfer|outbound)\b/i },
  { name: "cpu", pattern: /\b(cpu|vcpu|compute time)\b/i },
  { name: "memory", pattern: /\b(ram|memory)\b/i },
  { name: "storage", pattern: /\b(storage|disk|volume)\b/i },
  { name: "build", pattern: /\b(builds?|build mins?|build minutes?|deploys?)\b/i },
  { name: "requests", pattern: /\b(requests?|invocations?)\b/i },
  { name: "users", pattern: /\b(mau|monthly active users?|seats?|members?)\b/i },
  { name: "environments", pattern: /\benvironments?\b/i },
  { name: "services", pattern: /\b(services?|projects?|sites?|replicas?)\b/i },
  { name: "price", pattern: /\b(price|cost|paid|starting at|per month|per seat)\b/i },
];

const HISTORICAL =
  /\b(previously|prior to|legacy|formerly|used to|no longer|retired|removed|down from|up from|was\s+\d|before:)\b/i;

const BINARY_DECIMAL_SLACK = 0.1;

export function agree(a: number, b: number): boolean {
  if (a === b) return true;
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger === 0) return true;
  return Math.abs(a - b) / larger <= BINARY_DECIMAL_SLACK;
}

export function classifyDimension(label: string): string | null {
  for (const d of DIMENSIONS) if (d.pattern.test(label)) return d.name;
  return null;
}

export function quantitiesIn(text: string): Quantity[] {
  const found: Quantity[] = [];
  for (const family of UNIT_FAMILIES) {
    for (const m of text.matchAll(new RegExp(family.pattern.source, family.pattern.flags))) {
      const raw = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(raw)) continue;
      const trailing = text.slice(m.index! + m[0].length, m.index! + m[0].length + 14).match(PER_UNIT);
      found.push({
        quantity: family.scale(raw, m),
        unit: family.unit,
        per: trailing ? trailing[1].toLowerCase() : null,
        text: m[0].trim() + (trailing ? trailing[0].replace(/\s+/g, " ") : ""),
        index: m.index!,
      });
    }
  }
  return found;
}

function clauseAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf(",", index) + 1, text.lastIndexOf(";", index) + 1);
  const commaAfter = text.indexOf(",", index);
  const semiAfter = text.indexOf(";", index);
  const ends = [commaAfter, semiAfter].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/&#10003;|&#10007;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PLAN_NAMES = /\b(Hobby|Starter|Free|Pro|Launch|Scale|Business|Team|Enterprise|Individual|Personal|Developer|Legacy)\b/i;

export function planIn(label: string): string | null {
  const named = label.match(PLAN_NAMES);
  return named ? named[1] : null;
}

export function vendorIn(label: string, vendors: string[]): string | null {
  let best: string | null = null;
  for (const v of vendors) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`, "i").test(label)) continue;
    if (best === null || v.length > best.length) best = v;
  }
  return best;
}

function figuresIn(
  block: string,
  vendor: string,
  fallbackLabel: string,
  headerPlan: string | null,
  source: Figure["source"],
): Figure[] {
  const quantities = quantitiesIn(block);
  const FLATTENED_TABLE_ROW = 3;
  return quantities.map((q) => {
    const clause = clauseAround(block, q.index);
    const crowded = source === "sentence" && quantitiesIn(clause).length >= FLATTENED_TABLE_ROW;
    const labelApplies = source !== "sentence" || quantities.length === 1;
    const dimension = crowded
      ? null
      : classifyDimension(clause) ?? (labelApplies ? classifyDimension(fallbackLabel) : null);
    return {
      vendor,
      plan: planIn(clause) ?? headerPlan,
      dimension,
      clause,
      block,
      quantity: q,
      source,
    };
  });
}

export function figuresInTables(html: string, vendors: string[]): Figure[] {
  const figures: Figure[] = [];
  for (const table of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const block = table[0];
    const head = block.match(/<thead\b[\s\S]*?<\/thead>/i);
    const headers = head ? [...head[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1])) : [];
    const columnVendors = headers.map((h) => (NON_VENDOR_COLUMNS.test(h) ? null : vendorIn(h, vendors)));
    const vendorInHeader = columnVendors.filter(Boolean).length >= 2;

    for (const row of block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1]));
      if (cells.length < 2) continue;
      const rowVendor = vendorIn(cells[0], vendors);

      for (let i = 1; i < cells.length; i++) {
        const cell = cells[i];
        if (!cell) continue;
        const header = headers[i] ?? "";
        if (NON_VENDOR_COLUMNS.test(header)) continue;

        if (vendorInHeader && columnVendors[i]) {
          figures.push(...figuresIn(cell, columnVendors[i]!, cells[0], planIn(header), "table-column"));
        } else if (!vendorInHeader && rowVendor) {
          figures.push(...figuresIn(cell, rowVendor, header, planIn(cells[0]), "table-row"));
        }
      }
    }
  }
  return figures;
}

export function figuresInSentences(text: string, vendors: string[]): Figure[] {
  const figures: Figure[] = [];
  for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
    if (sentence.length > 600) continue;
    const named = vendors.filter((v) => {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`, "i").test(sentence);
    });
    if (named.length !== 1) continue;
    figures.push(...figuresIn(sentence.trim(), named[0], sentence, null, "sentence"));
  }
  return figures;
}

export function clausesInRecord(description: string): RecordClause[] {
  const clauses: RecordClause[] = [];
  let currentPlan: string | null = null;
  for (const segment of description.split(/(?<=[.;])\s+/)) {
    const declared = segment.match(/\b(Hobby|Starter|Free|Pro|Launch|Scale|Business|Team|Enterprise|Individual|Legacy)\s+plan\s*:/i);
    if (declared) currentPlan = declared[1];
    for (const q of quantitiesIn(segment)) {
      const clause = clauseAround(segment, q.index);
      clauses.push({ text: clause, plan: currentPlan, dimension: classifyDimension(clause), quantity: q });
    }
  }
  return clauses;
}

const FREE_TIER_ALIAS = /^(free|starter|hobby|personal|individual|developer)$/i;

export function planMatchesRecord(plan: string, record: { tier: string; description: string }): boolean {
  if (new RegExp(`\\b${plan}\\b`, "i").test(record.tier)) return true;
  if (new RegExp(`\\b${plan}\\s+(?:plan|tier)\\b`, "i").test(record.description)) return false;
  return FREE_TIER_ALIAS.test(plan) && FREE_TIER_ALIAS.test(record.tier.trim());
}

function sumsTheRecordsParts(figure: Figure, record: { tier: string; description: string }): boolean {
  if (!/\btotal\b/i.test(figure.clause)) return false;
  const family = clausesInRecord(record.description).filter(
    (c) =>
      c.quantity.unit === figure.quantity.unit &&
      c.quantity.per === figure.quantity.per &&
      c.dimension !== null &&
      figure.dimension !== null &&
      (c.dimension === figure.dimension || c.dimension.endsWith(`-${figure.dimension}`)),
  );
  const total = family.reduce((sum, c) => sum + c.quantity.quantity, 0);
  return agree(total, figure.quantity.quantity);
}

export function disagreements(
  route: string,
  figures: Figure[],
  recordsByVendor: Map<string, { tier: string; description: string }>,
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const figure of figures) {
    if (!figure.dimension) continue;
    if (HISTORICAL.test(figure.clause)) continue;
    const record = recordsByVendor.get(figure.vendor.toLowerCase());
    if (!record) continue;
    if (record.description.includes(figure.clause)) continue;

    const plan = figure.plan;
    if (plan && !planMatchesRecord(plan, record)) continue;
    const comparable = clausesInRecord(record.description).filter((c) => {
      if (c.dimension !== figure.dimension) return false;
      if (c.quantity.unit !== figure.quantity.unit) return false;
      if (c.quantity.per !== figure.quantity.per) return false;
      if (HISTORICAL.test(c.text)) return false;
      if (plan && c.plan && !new RegExp(plan, "i").test(c.plan)) return false;
      return true;
    });
    if (comparable.length === 0) continue;
    if (comparable.some((c) => agree(c.quantity.quantity, figure.quantity.quantity))) continue;
    if (sumsTheRecordsParts(figure, record)) continue;

    const closest = comparable.reduce((a, b) =>
      Math.abs(Math.log((b.quantity.quantity || 1) / (figure.quantity.quantity || 1))) <
      Math.abs(Math.log((a.quantity.quantity || 1) / (figure.quantity.quantity || 1)))
        ? b
        : a,
    );
    out.push({
      route,
      vendor: figure.vendor,
      plan: figure.plan,
      dimension: figure.dimension,
      published: figure.clause.slice(0, 150),
      publishedFigure: figure.quantity.text,
      recordClause: closest.text.slice(0, 150),
      recordFigure: closest.quantity.text,
      source: figure.source,
    });
  }
  return out;
}
