import { CLIENT_CLASSES } from "./client-class.js";

export const OUTBOUND_PATH_PREFIX = "/go/";
export const OUTBOUND_STORE_KEY = "agentdeals:outbound";
export const OUTBOUND_SCHEMA = 1;

export type OutboundCounts = Record<string, Record<string, number>>;

export interface OutboundRecord {
  schema: number;
  counts: OutboundCounts;
  first_recorded_at: string;
  updated_at: string;
}

export interface OutboundStore {
  get(key: string): Promise<{ ok: boolean; value: unknown; error?: string }>;
  set(key: string, value: unknown): Promise<{ ok: boolean; error?: string }>;
}

export function outboundSlug(pathname: string, isVendorSlug: (slug: string) => boolean): string | null {
  if (typeof pathname !== "string" || !pathname.startsWith(OUTBOUND_PATH_PREFIX)) return null;
  const rest = pathname.slice(OUTBOUND_PATH_PREFIX.length).replace(/\/$/, "");
  if (!rest || rest.includes("/")) return null;
  const slug = rest.toLowerCase();
  return isVendorSlug(slug) ? slug : null;
}

export function outboundPath(slug: string): string {
  return `${OUTBOUND_PATH_PREFIX}${slug}`;
}

function emptyRecord(): OutboundRecord {
  return { schema: OUTBOUND_SCHEMA, counts: {}, first_recorded_at: "", updated_at: "" };
}

function positiveCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function parseOutboundRecord(raw: unknown): OutboundRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyRecord();
  const obj = raw as Record<string, unknown>;
  const counts: OutboundCounts = {};
  const storedCounts = obj.counts;
  if (storedCounts && typeof storedCounts === "object" && !Array.isArray(storedCounts)) {
    for (const [slug, byClass] of Object.entries(storedCounts as Record<string, unknown>)) {
      if (!byClass || typeof byClass !== "object" || Array.isArray(byClass)) continue;
      for (const [clientClass, value] of Object.entries(byClass as Record<string, unknown>)) {
        const count = positiveCount(value);
        if (count > 0) (counts[slug] ??= {})[clientClass] = count;
      }
    }
  }
  return {
    schema: positiveCount(obj.schema) || OUTBOUND_SCHEMA,
    counts,
    first_recorded_at: typeof obj.first_recorded_at === "string" ? obj.first_recorded_at : "",
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : "",
  };
}

function addCounts(into: OutboundCounts, from: OutboundCounts): void {
  for (const [slug, byClass] of Object.entries(from)) {
    const target = (into[slug] ??= {});
    for (const [clientClass, count] of Object.entries(byClass)) {
      target[clientClass] = (target[clientClass] ?? 0) + count;
    }
  }
}

function copyCounts(counts: OutboundCounts): OutboundCounts {
  const copy: OutboundCounts = {};
  addCounts(copy, counts);
  return copy;
}

export function mergeOutboundRecord(base: OutboundRecord, delta: OutboundCounts, deltaSince: string, now: string): OutboundRecord {
  const counts = copyCounts(base.counts);
  addCounts(counts, delta);
  return {
    schema: OUTBOUND_SCHEMA,
    counts,
    first_recorded_at: base.first_recorded_at || deltaSince || now,
    updated_at: now,
  };
}

let pending: OutboundCounts = {};
let pendingSince = "";
let stored: OutboundRecord = emptyRecord();
let storedRead = false;
let store: OutboundStore | null = null;
let lastWriteAt: string | null = null;
let lastWriteError: string | null = null;
let writeFailures = 0;

export function configureOutboundStore(next: OutboundStore | null): void {
  store = next;
}

export function recordOutboundClick(slug: string, clientClass: string): void {
  if (!slug || !clientClass) return;
  const byClass = (pending[slug] ??= {});
  byClass[clientClass] = (byClass[clientClass] ?? 0) + 1;
  if (!pendingSince) pendingSince = new Date().toISOString();
}

function hasPendingClicks(): boolean {
  return Object.keys(pending).length > 0;
}

export async function loadOutbound(): Promise<boolean> {
  if (!store) return false;
  const read = await store.get(OUTBOUND_STORE_KEY);
  if (!read.ok) return false;
  stored = parseOutboundRecord(read.value);
  storedRead = true;
  return true;
}

function returnBatch(batch: OutboundCounts, batchSince: string): void {
  const restored = copyCounts(batch);
  addCounts(restored, pending);
  pending = restored;
  if (batchSince && (!pendingSince || batchSince < pendingSince)) pendingSince = batchSince;
}

async function runOutboundFlush(): Promise<boolean> {
  if (!store || !hasPendingClicks()) return false;
  const batch = pending;
  const batchSince = pendingSince;
  pending = {};
  pendingSince = "";

  const read = await store.get(OUTBOUND_STORE_KEY);
  if (!read.ok) {
    noteWriteFailure(read.error ?? "read-failed");
    returnBatch(batch, batchSince);
    return false;
  }
  const now = new Date().toISOString();
  const merged = mergeOutboundRecord(parseOutboundRecord(read.value), batch, batchSince, now);
  const write = await store.set(OUTBOUND_STORE_KEY, merged);
  if (!write.ok) {
    noteWriteFailure(write.error ?? "write-failed");
    returnBatch(batch, batchSince);
    return false;
  }
  stored = merged;
  storedRead = true;
  lastWriteAt = now;
  lastWriteError = null;
  return true;
}

function noteWriteFailure(message: string): void {
  lastWriteError = message;
  writeFailures++;
}

let flushChain: Promise<boolean> = Promise.resolve(false);

export function flushOutbound(): Promise<boolean> {
  flushChain = flushChain.then(runOutboundFlush, runOutboundFlush);
  return flushChain;
}

function currentCounts(): OutboundCounts {
  const counts = copyCounts(stored.counts);
  addCounts(counts, pending);
  return counts;
}

function classTotals(counts: OutboundCounts): Record<string, number> {
  const byClass: Record<string, number> = Object.fromEntries(CLIENT_CLASSES.map(c => [c, 0]));
  for (const perClass of Object.values(counts)) {
    for (const [clientClass, count] of Object.entries(perClass)) {
      byClass[clientClass] = (byClass[clientClass] ?? 0) + count;
    }
  }
  return byClass;
}

function sumOf(values: Record<string, number>): number {
  return Object.values(values).reduce((a, b) => a + b, 0);
}

export interface OutboundTotals {
  total: number;
  by_class: Record<string, number>;
  recording_since: string | null;
  durable: boolean;
  stored_total_read: boolean;
  pending_flush: boolean;
  last_write_at: string | null;
  last_write_error: string | null;
  write_failures: number;
}

export function outboundTotals(): OutboundTotals {
  const byClass = classTotals(currentCounts());
  return {
    total: sumOf(byClass),
    by_class: byClass,
    recording_since: stored.first_recorded_at || pendingSince || null,
    durable: store !== null,
    stored_total_read: storedRead,
    pending_flush: hasPendingClicks(),
    last_write_at: lastWriteAt,
    last_write_error: lastWriteError,
    write_failures: writeFailures,
  };
}

export interface OutboundVendorRow {
  slug: string;
  total: number;
  by_class: Record<string, number>;
}

export function outboundByVendor(): OutboundVendorRow[] {
  return Object.entries(currentCounts())
    .map(([slug, byClass]) => ({ slug, total: sumOf(byClass), by_class: { ...byClass } }))
    .sort((a, b) => b.total - a.total || a.slug.localeCompare(b.slug));
}

export function resetOutbound(): void {
  pending = {};
  pendingSince = "";
  stored = emptyRecord();
  storedRead = false;
  store = null;
  lastWriteAt = null;
  lastWriteError = null;
  writeFailures = 0;
  flushChain = Promise.resolve(false);
}
