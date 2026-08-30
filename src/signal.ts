import { createHash, randomBytes } from "node:crypto";
import { resolveVendorSlug, toSlug, vendorSlugMap } from "./vendor-slug.js";
import {
  normalizeRoutePath,
  recordSignal,
  SIGNAL_EVENTS,
  type SignalRecord,
  type SignalTransport,
} from "./stats.js";

export const SIGNAL_PATH = "/api/signal";
export const SIGNAL_DOC_PATH = "/signal";

export const NOTE_MAX = 200;
const IDENT_MAX = 60;
const SOURCE_MAX = 120;
export const SIGNAL_BODY_MAX = 4096;

const PII_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: "[redacted-email]" },
  { pattern: /\b(?:bearer|token|api[_-]?key|secret|password)\s*[:=]?\s*\S+/gi, label: "[redacted-credential]" },
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, label: "[redacted-credential]" },
  { pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g, label: "[redacted-credential]" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, label: "[redacted-credential]" },
  { pattern: /\bAKIA[0-9A-Z]{12,}/g, label: "[redacted-credential]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, label: "[redacted-credential]" },
  { pattern: /\b[A-Za-z0-9_-]{40,}\b/g, label: "[redacted-token]" },
];

function stripControlChars(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

export function scrubNote(raw: unknown): { note: string | null; redacted: boolean } {
  if (typeof raw !== "string") return { note: null, redacted: false };
  let text = stripControlChars(raw).trim();
  if (!text) return { note: null, redacted: false };
  let redacted = false;
  for (const { pattern, label } of PII_PATTERNS) {
    text = text.replace(pattern, () => {
      redacted = true;
      return label;
    });
  }
  text = text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  return { note: text || null, redacted };
}

export function sanitizeIdentifier(raw: unknown, max = IDENT_MAX): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return clean || null;
}

export const RATE_LIMIT_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const RATE_KEYS_MAX = 5000;

const RATE_SALT = randomBytes(16).toString("hex");

export function rateKey(address: string): string {
  return createHash("sha256").update(RATE_SALT).update(address).digest("hex").slice(0, 16);
}

interface Bucket {
  count: number;
  windowStart: number;
}
const rateBuckets = new Map<string, Bucket>();

export interface RateDecision {
  allowed: boolean;
  retryAfter: number;
}

export function checkRateLimit(address: string, now = Date.now()): RateDecision {
  const key = rateKey(address);
  const existing = rateBuckets.get(key);
  let bucket: Bucket;
  if (!existing || now - existing.windowStart >= RATE_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
  } else {
    bucket = existing;
    rateBuckets.delete(key);
  }
  bucket.count++;
  rateBuckets.set(key, bucket);
  while (rateBuckets.size > RATE_KEYS_MAX) {
    const oldest = rateBuckets.keys().next();
    if (oldest.done) break;
    rateBuckets.delete(oldest.value);
  }
  const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + RATE_WINDOW_MS - now) / 1000));
  return { allowed: bucket.count <= RATE_LIMIT_PER_MINUTE, retryAfter };
}

export function resetRateLimiter(): void {
  rateBuckets.clear();
}

export function clientAddress(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = raw?.split(",")[0]?.trim();
  return first || remoteAddress || "unknown";
}

export interface SignalInput {
  event?: unknown;
  vendor?: unknown;
  source?: unknown;
  agent?: unknown;
  agent_id?: unknown;
  note?: unknown;
}

export interface SignalOutcome {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function resolveSignalVendor(raw: unknown): { vendor: string | null; unresolved: string | null } {
  if (typeof raw !== "string" || !raw.trim()) return { vendor: null, unresolved: null };
  const slug = toSlug(raw.trim());
  if (!slug) return { vendor: null, unresolved: sanitizeIdentifier(raw) };
  if (vendorSlugMap.has(slug)) return { vendor: slug, unresolved: null };
  const resolution = resolveVendorSlug(slug);
  if (resolution.type === "exact" || resolution.type === "redirect") {
    return { vendor: resolution.slug, unresolved: null };
  }
  return { vendor: null, unresolved: sanitizeIdentifier(slug) };
}

export function acceptSignal(
  input: SignalInput,
  ctx: { transport: SignalTransport; client_class: string },
): SignalOutcome {
  const eventRaw = typeof input.event === "string" ? input.event.trim().toLowerCase() : "";
  const event = sanitizeIdentifier(eventRaw, 40) ?? "";
  const { vendor, unresolved } = resolveSignalVendor(input.vendor);

  if (!vendor && !unresolved) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "vendor is required",
        hint: `${SIGNAL_PATH} {"event":"recommended","vendor":"<slug>"} — see ${SIGNAL_DOC_PATH}`,
        valid_events: [...SIGNAL_EVENTS],
      },
    };
  }
  if (!event) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "event is required",
        hint: `${SIGNAL_PATH} {"event":"recommended","vendor":"<slug>"} — see ${SIGNAL_DOC_PATH}`,
        valid_events: [...SIGNAL_EVENTS],
      },
    };
  }

  const agent = sanitizeIdentifier(input.agent);
  const { note, redacted } = scrubNote(input.note);
  const source =
    typeof input.source === "string" && input.source.trim()
      ? normalizeRoutePath(input.source.trim().split("?")[0].slice(0, SOURCE_MAX))
      : null;
  const record: SignalRecord = {
    event,
    vendor,
    unresolved,
    agent,
    source,
    note,
    note_redacted: redacted,
    transport: ctx.transport,
    client_class: ctx.client_class,
  };
  recordSignal(record);

  const recognized = (SIGNAL_EVENTS as readonly string[]).includes(event);
  return {
    status: 202,
    body: {
      ok: true,
      recorded: event,
      vendor: vendor ?? null,
      ...(unresolved ? { vendor_resolved: false, unresolved_name: unresolved } : {}),
      ...(recognized ? {} : { event_recognized: false, valid_events: [...SIGNAL_EVENTS] }),
      ...(note ? { note_received: true, note_redacted: redacted, note_published: false } : {}),
      ...(input.agent_id ? { agent_id_reserved: true } : {}),
      self_reported: true,
      affects_ranking: false,
      docs: SIGNAL_DOC_PATH,
    },
  };
}

export const SIGNAL_ACK_PARAM = "ack";
export function ackMissing(): SignalOutcome {
  return {
    status: 400,
    body: {
      ok: false,
      error: "GET requires ack=1",
      why:
        "A GET that changes state is a URL that crawlers, prefetchers and link unfurlers " +
        "follow without meaning to. The acknowledgement parameter is what separates a " +
        "deliberate report from a followed link. Add &ack=1, or POST instead.",
      hint: `${SIGNAL_PATH}?event=recommended&vendor=<slug>&ack=1`,
      docs: SIGNAL_DOC_PATH,
    },
  };
}
