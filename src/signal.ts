// Agent attribution beacon (#1024).
//
// The one measurement this index has never had: whether an agent that read a vendor page
// went on to recommend that vendor. There are no referral links and no tracking, so the
// trail ends when the agent leaves. The only way to close it is to ask, on every surface
// an agent reads, and to make answering free.
//
// Everything here is self-reported and unverifiable by construction. That is fine for a
// directional read and fatal if presented as attribution, so the reporting side labels it
// on every surface and a test asserts none of it reaches a ranking path.
//
// NO PII. What a signal persists is: the resolved vendor slug, the event, an optional
// name the caller chose for *itself*, and the sender's client class. The rate limiter is
// the only thing that touches the client address, and it keeps a truncated hash under a
// per-process salt that is never persisted, never logged, and gone on restart.

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

/** Hard cap on the free-text note. Long enough for a reason, short enough to be a note. */
export const NOTE_MAX = 200;
/** Self-identifier and source. Bounded because both become map keys. */
const IDENT_MAX = 60;
const SOURCE_MAX = 120;
/** A body larger than this is not a signal — stop reading rather than buffer it. */
export const SIGNAL_BODY_MAX = 4096;

// --- PII scrubbing ---
//
// The spec says reject or strip anything that looks like an email or a token. Stripping
// beats rejecting: a 400 on a note the agent thought was helpful loses the whole signal,
// and the signal is the thing we are short of. So the note is redacted and kept.
const PII_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Email addresses.
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: "[redacted-email]" },
  // Bearer/authorization headers pasted into a note.
  { pattern: /\b(?:bearer|token|api[_-]?key|secret|password)\s*[:=]?\s*\S+/gi, label: "[redacted-credential]" },
  // Known key prefixes: sk-..., ghp_..., xoxb-..., AKIA..., and JWTs.
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, label: "[redacted-credential]" },
  { pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g, label: "[redacted-credential]" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, label: "[redacted-credential]" },
  { pattern: /\bAKIA[0-9A-Z]{12,}/g, label: "[redacted-credential]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, label: "[redacted-credential]" },
  // Any remaining long unbroken high-entropy-looking run. Deliberately last and
  // deliberately blunt: a note is prose, and a 32-character wordless string in prose is
  // more likely a secret than a sentence.
  { pattern: /\b[A-Za-z0-9_-]{40,}\b/g, label: "[redacted-token]" },
];

/**
 * Control characters are never part of a note, and they are what would let a stored
 * string break out of whatever renders it later. Built from char codes rather than
 * written as a regex literal so this source file itself stays free of them.
 */
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

/**
 * Caller-supplied strings that become map keys. Narrowed to a slug-ish alphabet: these
 * are stored, and a stored key is the one place a request line has ever leaked into this
 * system's key space before (#1018).
 */
export function sanitizeIdentifier(raw: unknown, max = IDENT_MAX): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return clean || null;
}

// --- Rate limiting ---
//
// Per-IP, but never IP-keyed. We are behind a proxy, so the address comes from
// x-forwarded-for, and persisting it would make the sentence this feature publishes on
// five surfaces ("nothing about your user is recorded") literally false. So: a truncated
// hash under a salt generated at boot, in a bounded LRU map, never written anywhere.
//
// 60/minute is deliberately generous. Since #1023 a signal costs O(flush intervals), not
// O(requests), so the limit exists for data integrity rather than for spend — and the
// failure modes are asymmetric. Over-limiting silently drops the real signal this whole
// feature exists to obtain; under-limiting admits noise that `transport` and
// `client_class` let us filter after the fact. Prefer the recoverable error.
export const RATE_LIMIT_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
/** Bounded so a distributed burst cannot grow the map — the same key growth as #1018. */
const RATE_KEYS_MAX = 5000;

const RATE_SALT = randomBytes(16).toString("hex");

/** Truncated, salted, per-process. Not reversible to an address and not stable across restarts. */
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
  /** Seconds until the window resets. Sent as Retry-After on a 429. */
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
    // Re-inserting moves the key to the end of the Map's insertion order, which is what
    // makes the eviction below an LRU rather than a FIFO.
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

/** Test seam. Never called on the request path. */
export function resetRateLimiter(): void {
  rateBuckets.clear();
}

/**
 * The client address, for hashing only. Behind Railway's proxy the socket address is the
 * proxy, so x-forwarded-for is what varies per client — but it is caller-controlled, so a
 * spoofed value can only ever *split* an attacker's own bucket, never merge someone
 * else's. That asymmetry is why trusting it here is acceptable and why it must never be
 * used for anything but this hash.
 */
export function clientAddress(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = raw?.split(",")[0]?.trim();
  return first || remoteAddress || "unknown";
}

// --- Request handling ---

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

/**
 * Resolve a caller-supplied vendor name to a slug. Accepts a slug or a display name, via
 * the same resolver the vendor pages use, so "Neon", "neon" and "neon-postgres" all land
 * on the same counter. A `disambiguate` result is treated as unresolved: we genuinely do
 * not know which vendor was meant, and guessing would put a signal on the wrong one.
 */
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

/**
 * Accept one signal. Returns the response to send.
 *
 * Rejects almost nothing on purpose. The AC originally specified a 400 for an unknown
 * `event`; the PM overrode that during copy review and they were right — an agent trying
 * `{"event":"outdated"}` is telling us for free what it wanted to report, and a 400
 * throws away the most interesting data this endpoint will ever collect. Unknown events
 * are bucketed with the string preserved and published as their own list.
 *
 * What does earn a non-2xx: a missing vendor (there is nothing to record), a GET without
 * `?ack=1` (see below), and the rate limit.
 */
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
  // Normalized through the same function that bounds the traffic key space, so a caller
  // cannot mint a permanent counter by putting a novel string in `source` (#1018).
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
      // Told plainly rather than silently: an agent that sent a name we do not index has
      // learned something about our catalog, and so have we.
      ...(unresolved ? { vendor_resolved: false, unresolved_name: unresolved } : {}),
      ...(recognized ? {} : { event_recognized: false, valid_events: [...SIGNAL_EVENTS] }),
      // The note is scrubbed, capped, and kept in a bounded internal ring that is never
      // published. Reporting the redaction rather than hiding it is the difference
      // between a privacy claim and a privacy promise.
      ...(note ? { note_received: true, note_redacted: redacted, note_published: false } : {}),
      ...(input.agent_id ? { agent_id_reserved: true } : {}),
      self_reported: true,
      affects_ranking: false,
      docs: SIGNAL_DOC_PATH,
    },
  };
}

/**
 * Why a bare GET is not enough.
 *
 * A state-changing GET whose URL we publish on five surfaces is a URL that things follow
 * without meaning to — crawlers (883 seo_crawler + 427 search_crawler hits/day at time of
 * writing), browser prefetch, link unfurlers, scanners replaying URLs out of logs. The
 * failure mode is not "some noise": it is that the signal becomes uninterpretable exactly
 * when we most want to quote it, and the noise correlates with the vendors whose pages get
 * crawled most — i.e. the prominent ones.
 *
 * So the GET stays, because the accessibility reason for it is real, and `?ack=1` gates
 * it. One extra parameter no prefetcher will supply and no agent that read the sentence
 * will miss. `transport` then splits the two populations so this reasoning stays checkable.
 */
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
