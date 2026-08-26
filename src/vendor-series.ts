import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const VENDOR_SERIES_PATH = "/api/analytics/vendors";
export const MIN_EXPORT_TOKEN_LENGTH = 16;

export function vendorExportAuthorized(header: string | string[] | undefined): boolean {
  const expected = process.env.ANALYTICS_EXPORT_TOKEN;
  if (typeof expected !== "string" || expected.length < MIN_EXPORT_TOKEN_LENGTH) return false;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return false;
  const match = /^Bearer[ \t]+(\S.*)$/i.exec(raw.trim());
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export const VENDOR_SERIES_SCHEMA = 1;
export const VENDOR_SERIES_KEY_PREFIX = "vendorseries:";
export const OVERFLOW_VENDOR_KEY = "__other_vendors__";
export const VENDOR_SERIES_RETENTION_DAYS = 90;
export const VENDOR_SERIES_TTL_SECONDS = 100 * 86400;
export const MAX_VENDOR_SLUGS_PER_DAY = 400;
export const MAX_CLIENTS_PER_VENDOR_PER_DAY = 2000;
export const MAX_TRACKED_CLIENT_KEYS = 50000;
const CLIENT_KEY_LENGTH = 12;

export interface VendorDay {
  schema: number;
  date: string;
  counts: Record<string, number>;
  process_starts: number;
  slug_overflow: number;
  capped_slugs: number;
  dedup_suppressed: number;
  first_recorded_at: string;
  updated_at: string;
}

export function vendorSeriesKey(date: string): string {
  return `${VENDOR_SERIES_KEY_PREFIX}${date}`;
}

export function emptyVendorDay(date: string): VendorDay {
  return {
    schema: VENDOR_SERIES_SCHEMA,
    date,
    counts: {},
    process_starts: 0,
    slug_overflow: 0,
    capped_slugs: 0,
    dedup_suppressed: 0,
    first_recorded_at: "",
    updated_at: "",
  };
}

function numericMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

function numberAt(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringAt(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

export function parseVendorDay(raw: unknown, date: string): VendorDay {
  if (!raw || typeof raw !== "object") return emptyVendorDay(date);
  const obj = raw as Record<string, unknown>;
  const stored = stringAt(obj, "date");
  return {
    schema: numberAt(obj, "schema") || VENDOR_SERIES_SCHEMA,
    date: stored || date,
    counts: numericMap(obj.counts),
    process_starts: numberAt(obj, "process_starts"),
    slug_overflow: numberAt(obj, "slug_overflow"),
    capped_slugs: numberAt(obj, "capped_slugs"),
    dedup_suppressed: numberAt(obj, "dedup_suppressed"),
    first_recorded_at: stringAt(obj, "first_recorded_at"),
    updated_at: stringAt(obj, "updated_at"),
  };
}

function addBounded(counts: Record<string, number>, slug: string, amount: number): number {
  if (amount <= 0) return 0;
  if (counts[slug] !== undefined || slug === OVERFLOW_VENDOR_KEY) {
    counts[slug] = (counts[slug] ?? 0) + amount;
    return 0;
  }
  if (Object.keys(counts).length >= MAX_VENDOR_SLUGS_PER_DAY) {
    counts[OVERFLOW_VENDOR_KEY] = (counts[OVERFLOW_VENDOR_KEY] ?? 0) + amount;
    return amount;
  }
  counts[slug] = amount;
  return 0;
}

export function mergeVendorDay(base: VendorDay, delta: VendorDay, now: string): VendorDay {
  const merged = emptyVendorDay(base.date || delta.date);
  merged.counts = { ...base.counts };
  let overflowed = 0;
  for (const [slug, count] of Object.entries(delta.counts)) {
    overflowed += addBounded(merged.counts, slug, count);
  }
  merged.process_starts = base.process_starts + delta.process_starts;
  merged.slug_overflow = base.slug_overflow + delta.slug_overflow + overflowed;
  merged.capped_slugs = Math.max(base.capped_slugs, delta.capped_slugs);
  merged.dedup_suppressed = base.dedup_suppressed + delta.dedup_suppressed;
  merged.first_recorded_at = base.first_recorded_at || delta.first_recorded_at || now;
  merged.updated_at = now;
  return merged;
}

const CLIENT_SALT = randomBytes(16).toString("hex");

export function clientKey(address: string): string {
  return createHash("sha256").update(CLIENT_SALT).update(address).digest("hex").slice(0, CLIENT_KEY_LENGTH);
}

interface RecordingDay {
  date: string;
  delta: VendorDay;
  seen: Map<string, Set<string>>;
  trackedKeys: number;
  countedTotal: number;
  suppressedTotal: number;
  overflowTotal: number;
}

let recording: RecordingDay | null = null;
let lastWriteAt: string | null = null;
let lastWriteError: string | null = null;
let writeFailures = 0;
let daysWritten = 0;

function startDay(date: string): RecordingDay {
  const delta = emptyVendorDay(date);
  delta.process_starts = 1;
  return { date, delta, seen: new Map(), trackedKeys: 0, countedTotal: 0, suppressedTotal: 0, overflowTotal: 0 };
}

export interface VendorRequest {
  slug: string | null;
  client_class: string;
  address: string;
  status: number;
  date: string;
}

export function recordVendorRequest(input: VendorRequest): void {
  if (input.client_class === "internal") return;
  if (!(input.status >= 200 && input.status < 300)) return;

  if (!recording || recording.date !== input.date) {
    if (recording && hasPendingVendorCounts()) carry({ date: recording.date, delta: recording.delta });
    recording = startDay(input.date);
  }
  const day = recording;
  const slug = input.slug ?? OVERFLOW_VENDOR_KEY;

  let clients = day.seen.get(slug);
  if (!clients) {
    clients = new Set();
    day.seen.set(slug, clients);
  }

  const key = clientKey(input.address);
  if (clients.has(key)) return;

  if (clients.size >= MAX_CLIENTS_PER_VENDOR_PER_DAY) {
    day.delta.capped_slugs = countCapped(day);
    day.delta.dedup_suppressed++;
    day.suppressedTotal++;
    return;
  }
  if (day.trackedKeys >= MAX_TRACKED_CLIENT_KEYS) {
    day.delta.dedup_suppressed++;
    day.suppressedTotal++;
    return;
  }

  clients.add(key);
  day.trackedKeys++;
  day.countedTotal++;
  const overflowed = addBounded(day.delta.counts, slug, 1);
  day.delta.slug_overflow += overflowed;
  day.overflowTotal += overflowed;
  if (!day.delta.first_recorded_at) day.delta.first_recorded_at = new Date().toISOString();
}

function countCapped(day: RecordingDay): number {
  let capped = 0;
  for (const clients of day.seen.values()) {
    if (clients.size >= MAX_CLIENTS_PER_VENDOR_PER_DAY) capped++;
  }
  return capped;
}

export function hasPendingVendorCounts(): boolean {
  if (!recording) return false;
  const { delta } = recording;
  return Object.keys(delta.counts).length > 0 || delta.process_starts > 0 || delta.dedup_suppressed > 0;
}

export interface PendingVendorWrite {
  date: string;
  delta: VendorDay;
}

export const MAX_CARRY_OVER_DAYS = 5;
const carryOver: PendingVendorWrite[] = [];
let droppedDays = 0;

function carry(write: PendingVendorWrite): void {
  const existing = carryOver.find(entry => entry.date === write.date);
  if (existing) {
    existing.delta = mergeVendorDay(existing.delta, write.delta, "");
    existing.delta.updated_at = "";
    return;
  }
  carryOver.push(write);
  while (carryOver.length > MAX_CARRY_OVER_DAYS) {
    carryOver.shift();
    droppedDays++;
  }
}

export function takeVendorWrites(): PendingVendorWrite[] {
  const writes = carryOver.splice(0, carryOver.length);
  if (recording && hasPendingVendorCounts()) {
    writes.push({ date: recording.date, delta: recording.delta });
    recording.delta = emptyVendorDay(recording.date);
  }
  return writes;
}

export function returnVendorWrites(writes: PendingVendorWrite[]): void {
  for (const write of writes) {
    if (recording && recording.date === write.date) {
      recording.delta = mergeVendorDay(write.delta, recording.delta, "");
      recording.delta.updated_at = "";
    } else {
      carry(write);
    }
  }
}

export interface VendorSeriesStore {
  get(key: string): Promise<{ ok: boolean; value: unknown; error?: string }>;
  mget(keys: string[]): Promise<{ ok: boolean; values: unknown[]; error?: string }>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<{ ok: boolean; error?: string }>;
}

let store: VendorSeriesStore | null = null;
let lastAttemptMs = 0;

export const DEFAULT_WRITE_INTERVAL_SECONDS = 300;
export const MIN_WRITE_INTERVAL_SECONDS = 1;

export function vendorWriteIntervalSeconds(): number {
  const raw = Number(process.env.VENDOR_SERIES_WRITE_INTERVAL_SECONDS);
  return raw > 0 ? Math.max(MIN_WRITE_INTERVAL_SECONDS, raw) : DEFAULT_WRITE_INTERVAL_SECONDS;
}

export function configureVendorSeries(next: VendorSeriesStore | null): void {
  store = next;
}

export function vendorSeriesConfigured(): boolean {
  return store !== null;
}

let flushChain: Promise<number> = Promise.resolve(0);

export function flushVendorSeries(force = false, now = new Date()): Promise<number> {
  if (!store) return Promise.resolve(0);
  const run = () => runVendorFlush(force, now);
  flushChain = flushChain.then(run, run);
  return flushChain;
}

async function runVendorFlush(force: boolean, now: Date): Promise<number> {
  if (!store) return 0;
  const nowMs = now.getTime();
  const due = force || carryOver.length > 0 || nowMs - lastAttemptMs >= vendorWriteIntervalSeconds() * 1000;
  if (!due) return 0;

  const writes = takeVendorWrites();
  if (writes.length === 0) {
    lastAttemptMs = nowMs;
    return 0;
  }
  lastAttemptMs = nowMs;

  const stamp = now.toISOString();
  const failed: PendingVendorWrite[] = [];
  let written = 0;

  for (const write of writes) {
    const key = vendorSeriesKey(write.date);
    const read = await store.get(key);
    if (!read.ok) {
      noteVendorWriteFailure(read.error ?? "read-failed");
      failed.push(write);
      continue;
    }
    const merged = mergeVendorDay(parseVendorDay(read.value, write.date), write.delta, stamp);
    const result = await store.set(key, merged, VENDOR_SERIES_TTL_SECONDS);
    if (!result.ok) {
      noteVendorWriteFailure(result.error ?? "write-failed");
      failed.push(write);
      continue;
    }
    noteVendorWrite(stamp);
    written++;
  }

  if (failed.length > 0) returnVendorWrites(failed);
  return written;
}

export async function readVendorSeries(dates: string[]): Promise<{ ok: boolean; days: VendorDay[]; error?: string }> {
  if (!store) return { ok: false, days: [], error: "not-configured" };
  if (dates.length === 0) return { ok: true, days: [] };
  const read = await store.mget(dates.map(vendorSeriesKey));
  if (!read.ok) return { ok: false, days: [], error: read.error ?? "read-failed" };
  const days: VendorDay[] = [];
  for (let i = 0; i < dates.length; i++) {
    const value = read.values[i];
    if (value === null || value === undefined) continue;
    days.push(parseVendorDay(value, dates[i]));
  }
  return { ok: true, days };
}

function noteVendorWrite(at: string): void {
  lastWriteAt = at;
  lastWriteError = null;
  daysWritten++;
}

function noteVendorWriteFailure(message: string): void {
  lastWriteError = message;
  writeFailures++;
}

export interface VendorSeriesGauge {
  recording_date: string | null;
  slugs_today: number;
  clients_today: number;
  dedup_tracked: number;
  dedup_suppressed: number;
  slug_overflow: number;
  capped_slugs: number;
  pending_write: boolean;
  last_write_at: string | null;
  last_write_error: string | null;
  write_failures: number;
  writes: number;
  carry_over_days: number;
  dropped_days: number;
  configured: boolean;
  write_interval_seconds: number;
  retention_days: number;
  published: boolean;
}

export function vendorSeriesGauge(): VendorSeriesGauge {
  return {
    recording_date: recording?.date ?? null,
    slugs_today: recording ? recording.seen.size : 0,
    clients_today: recording?.countedTotal ?? 0,
    dedup_tracked: recording?.trackedKeys ?? 0,
    dedup_suppressed: recording?.suppressedTotal ?? 0,
    slug_overflow: recording?.overflowTotal ?? 0,
    capped_slugs: recording ? countCapped(recording) : 0,
    pending_write: hasPendingVendorCounts(),
    last_write_at: lastWriteAt,
    last_write_error: lastWriteError,
    write_failures: writeFailures,
    writes: daysWritten,
    carry_over_days: carryOver.length,
    dropped_days: droppedDays,
    configured: store !== null,
    write_interval_seconds: vendorWriteIntervalSeconds(),
    retention_days: VENDOR_SERIES_RETENTION_DAYS,
    published: false,
  };
}

export function resetVendorSeries(): void {
  recording = null;
  lastWriteAt = null;
  lastWriteError = null;
  writeFailures = 0;
  daysWritten = 0;
  droppedDays = 0;
  lastAttemptMs = 0;
  carryOver.length = 0;
  store = null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isSeriesDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

export function seriesDateRange(from: string, to: string, maxDays = VENDOR_SERIES_RETENTION_DAYS): string[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start; t <= end && out.length < maxDays; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export const VENDOR_SERIES_NOTES: readonly string[] = [
  "`counts` is distinct clients per vendor per day, not requests. A client is counted once per vendor per day per server process.",
  "Deduplication is in-memory and per-process: the salted client hash is generated at startup and never written to storage, so a restart mid-day can count a client a second time. `process_starts` is the upper bound on that multiple.",
  "Only 2xx responses to paths that name exactly one catalogued vendor are counted. Requests classified `internal` are excluded.",
  "A slug we do not publish cannot mint a key: unknown slugs land in `__other_vendors__`, and `slug_overflow` counts what the per-day slug cap folded there.",
  "The client address comes from `x-forwarded-for`, which is caller-supplied, so a caller able to vary it can inflate its own vendor's distinct count. This series must not be used as a placement metric without an independent check.",
  "This series is never written to the public rollup in `data/analytics/`, which keeps `vendors: null`.",
];
