export interface VendorKeyedData {
  path: string;
  arrayKey: string;
}

export const VENDOR_KEYED_DATA: readonly VendorKeyedData[] = [
  { path: "data/index.json", arrayKey: "offers" },
  { path: "data/deal_changes.json", arrayKey: "changes" },
  { path: "data/change_refusals.json", arrayKey: "refusals" },
  { path: "data/verification_state.json", arrayKey: "records" },
];

export const DERIVED_FROM_THE_VENDOR_DATA: readonly string[] = [
  "data/quality_budgets.json",
  "data/page-lastmod.json",
  "artifacts/free-llm-api-index/README.md",
];

export const FAILING_TESTS_MARKER = "failing tests:";

export interface VendorRow {
  vendor?: unknown;
}

export function vendorKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function rowsOf(doc: unknown, arrayKey: string): VendorRow[] {
  if (doc === null || typeof doc !== "object") return [];
  const rows = (doc as Record<string, unknown>)[arrayKey];
  return Array.isArray(rows) ? (rows as VendorRow[]) : [];
}

function byVendor(rows: VendorRow[]): Map<string, VendorRow[]> {
  const out = new Map<string, VendorRow[]>();
  for (const row of rows) {
    const key = vendorKey(row.vendor);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

function displayName(rows: VendorRow[] | undefined): string {
  const named = rows?.find((r) => typeof r.vendor === "string" && r.vendor.trim().length > 0);
  return named ? (named.vendor as string).trim() : "";
}

export function vendorsMoved(before: unknown, after: unknown, arrayKey: string): string[] {
  const was = byVendor(rowsOf(before, arrayKey));
  const now = byVendor(rowsOf(after, arrayKey));
  const moved: string[] = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    if (key === "") continue;
    if (JSON.stringify(was.get(key) ?? null) === JSON.stringify(now.get(key) ?? null)) continue;
    const name = displayName(now.get(key)) || displayName(was.get(key));
    if (name !== "") moved.push(name);
  }
  return moved.sort((a, b) => a.localeCompare(b));
}

export function withVendorsAsTheyWereBefore(
  before: unknown,
  after: unknown,
  arrayKey: string,
  held: Iterable<string>,
): unknown {
  const heldKeys = new Set([...held].map(vendorKey).filter((k) => k !== ""));
  if (heldKeys.size === 0) return after;
  const restored = new Map<string, VendorRow[]>();
  for (const row of rowsOf(before, arrayKey)) {
    const key = vendorKey(row.vendor);
    if (!heldKeys.has(key)) continue;
    const list = restored.get(key);
    if (list) list.push(row);
    else restored.set(key, [row]);
  }
  const out: VendorRow[] = [];
  const placed = new Set<string>();
  for (const row of rowsOf(after, arrayKey)) {
    const key = vendorKey(row.vendor);
    if (!heldKeys.has(key)) {
      out.push(row);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    for (const was of restored.get(key) ?? []) out.push(was);
  }
  for (const [key, rows] of restored) {
    if (placed.has(key)) continue;
    for (const was of rows) out.push(was);
  }
  return { ...(after as Record<string, unknown>), [arrayKey]: out };
}

export function failingSection(log: string): string {
  const at = log.lastIndexOf(FAILING_TESTS_MARKER);
  return at === -1 ? "" : log.slice(at);
}

export function namesTheVendor(text: string, vendor: string): boolean {
  const name = vendor.trim();
  if (name === "") return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function vendorsNamedInFailure(log: string, candidates: Iterable<string>): string[] {
  const section = failingSection(log);
  if (section === "") return [];
  const named: string[] = [];
  const seen = new Set<string>();
  for (const vendor of candidates) {
    const key = vendorKey(vendor);
    if (key === "" || seen.has(key)) continue;
    if (!namesTheVendor(section, vendor)) continue;
    seen.add(key);
    named.push(vendor.trim());
  }
  return named.sort((a, b) => a.localeCompare(b));
}

export type HoldbackDecision = "hold-back" | "refuse-the-batch";

export interface HoldbackVerdict {
  decision: HoldbackDecision;
  vendors: string[];
  reason: string;
}

export function holdbackVerdict(named: string[], moved: string[]): HoldbackVerdict {
  const movedKeys = new Set(moved.map(vendorKey));
  const attributable = named.filter((v) => movedKeys.has(vendorKey(v)));
  if (moved.length === 0) {
    return {
      decision: "refuse-the-batch",
      vendors: [],
      reason: "this run moved no vendor's data, so the refusal is about something other than a vendor",
    };
  }
  if (attributable.length === 0) {
    return {
      decision: "refuse-the-batch",
      vendors: [],
      reason: `the failing tests name none of the ${moved.length} vendor(s) this run moved, so there is nothing to attribute the refusal to`,
    };
  }
  if (attributable.length >= moved.length) {
    return {
      decision: "refuse-the-batch",
      vendors: attributable,
      reason: `every one of the ${moved.length} vendor(s) this run moved is named by a failing test, so holding them back would leave nothing to push`,
    };
  }
  return {
    decision: "hold-back",
    vendors: attributable,
    reason: `${attributable.length} of the ${moved.length} vendor(s) this run moved are named by a failing test: ${attributable.join(", ")}`,
  };
}

export function serializeVendorData(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
