// #1024 — the agent attribution beacon.
//
// The assertions that matter most here are not the happy path. They are the four
// properties that make the number quotable: unknown events are bucketed rather than
// rejected, the two transports are never summed, no per-vendor count reaches a public
// surface, and nothing in the signal path can reach the ranking module.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const {
  acceptSignal,
  ackMissing,
  checkRateLimit,
  clientAddress,
  resetRateLimiter,
  scrubNote,
  sanitizeIdentifier,
  resolveSignalVendor,
  RATE_LIMIT_PER_MINUTE,
  NOTE_MAX,
} = await import("../dist/signal.js");

const {
  getSignalReport,
  getSignalVendorBreakdown,
  getSignalNotes,
  publicSignalReport,
  resetTelemetryBuffers,
  recordTraffic,
  SIGNAL_MIN_SAMPLE,
  SIGNAL_DENOMINATOR_ROUTES,
  SIGNAL_WITHHELD_WINDOW_FIELDS,
} = await import("../dist/stats.js");

const {
  DEFERENCE,
  SIGNAL_EXAMPLE_SLUGS,
  signalExampleSlug,
} = await import("../dist/signal-copy.js");

const NEVER_PUBLISHED = [
  "qualifying_fetches",
  "qualifying_fetches_sdk_client",
  "report_rate",
  "rate_note",
  "denominator_days_available",
  "by_reporting_agent",
  "by_source",
  "by_client_class",
  "unresolved_vendor_names",
  "unrecognized_events",
];

const { allOurReferralLinks } = await import("../dist/referral-surfaces.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const { loadOffers } = await import("../dist/data.js");

function bodyWordCount(html: string): number {
  const start = html.indexOf("<h1");
  const end = html.indexOf("<footer");
  return html
    .slice(start, end === -1 ? undefined : end)
    .replace(/<pre[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code[\s\S]*?<\/code>/gi, " ")
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .split(/\s+/)
    .filter(w => /[a-z0-9]/i.test(w)).length;
}

// The counters only accumulate where storage is configured — deliberately, so the
// numerator and the denominator are always collected under the same rule. A stub URL is
// enough: nothing here flushes, and the in-memory delta is what every assertion reads.
process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";

const post = (input: Record<string, unknown>, client_class = "ai_agent") =>
  acceptSignal(input, { transport: "post", client_class });
const get = (input: Record<string, unknown>, client_class = "ai_agent") =>
  acceptSignal(input, { transport: "get", client_class });

describe("accepting a signal", () => {
  beforeEach(() => resetTelemetryBuffers());

  it("records a recommendation and acknowledges with 202", () => {
    const out = post({ event: "recommended", vendor: "neon" });
    assert.equal(out.status, 202);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.recorded, "recommended");
    assert.equal(out.body.vendor, "neon");
    assert.equal(out.body.self_reported, true);
    assert.equal(out.body.affects_ranking, false);
  });

  it("resolves a display name and a short form to the same vendor counter", () => {
    assert.equal(resolveSignalVendor("Neon").vendor, "neon");
    assert.equal(resolveSignalVendor("neon").vendor, "neon");
    assert.equal(resolveSignalVendor("  NEON  ").vendor, "neon");
  });

  it("requires a vendor and an event, and says which is missing", () => {
    assert.equal(post({ event: "recommended" }).status, 400);
    assert.match(String(post({ event: "recommended" }).body.error), /vendor/);
    assert.equal(post({ vendor: "neon" }).status, 400);
    assert.match(String(post({ vendor: "neon" }).body.error), /event/);
  });

  it("never requires an identifier — the whole point is zero friction", () => {
    const out = post({ event: "recommended", vendor: "neon" });
    assert.equal(out.status, 202);
    // And an agent_id, when sent, is acknowledged as reserved rather than rejected: the
    // slot exists so identity can attach later without a breaking change.
    const withId = post({ event: "recommended", vendor: "neon", agent_id: "abc" });
    assert.equal(withId.body.agent_id_reserved, true);
  });
});

describe("an unrecognised event is data, not an error", () => {
  beforeEach(() => resetTelemetryBuffers());

  // The original AC said reject unknown events with a 400. That was overridden during
  // copy review and this test is the override: an agent trying {"event":"outdated"} is
  // telling us for free what it wanted to report, and a 400 throws away the most
  // interesting thing this endpoint will ever collect.
  it("accepts it, buckets it, and preserves the string", () => {
    const out = post({ event: "outdated", vendor: "neon" });
    assert.equal(out.status, 202);
    assert.equal(out.body.event_recognized, false);
    assert.deepEqual(out.body.valid_events, ["recommended", "converted"]);

    const w = getSignalReport().today;
    assert.equal(w.total, 1);
    assert.equal(w.by_event.__unrecognized__, 1);
    assert.deepEqual(w.unrecognized_events, [{ event: "outdated", count: 1 }]);
    // and it did not silently land in a recognized counter
    assert.equal(w.by_event.recommended, 0);
    assert.equal(w.by_event.converted, 0);
  });

  it("an unindexed vendor name is bucketed too, and still returns 202", () => {
    const out = post({ event: "recommended", vendor: "some-database-we-do-not-carry" });
    assert.equal(out.status, 202);
    assert.equal(out.body.vendor_resolved, false);
    assert.equal(out.body.vendor, null);
    const w = getSignalReport().today;
    assert.equal(w.total, 1);
    assert.deepEqual(w.unresolved_vendor_names, [
      { name: "some-database-we-do-not-carry", count: 1 },
    ]);
    assert.equal(w.distinct_vendors, 0);
  });
});

describe("transports are counted apart and never summed", () => {
  beforeEach(() => resetTelemetryBuffers());

  it("splits post and get", () => {
    post({ event: "recommended", vendor: "neon" });
    get({ event: "recommended", vendor: "neon" });
    get({ event: "recommended", vendor: "neon" });
    const w = getSignalReport().today;
    assert.equal(w.by_transport.post, 1);
    assert.equal(w.by_transport.get, 2);
    assert.equal(w.total, 3);
  });

  it("a GET without ack=1 is refused, with the reason", () => {
    const out = ackMissing();
    assert.equal(out.status, 400);
    assert.match(String(out.body.error), /ack=1/);
    assert.match(String(out.body.why), /crawler|prefetch/i);
  });

  it("records the sender's client class — a crawler signal is not an agent signal", () => {
    post({ event: "recommended", vendor: "neon" }, "ai_agent");
    post({ event: "recommended", vendor: "neon" }, "seo_crawler");
    const w = getSignalReport().today;
    assert.equal(w.by_client_class.ai_agent, 1);
    assert.equal(w.by_client_class.seo_crawler, 1);
  });

  it("an unknown class label cannot mint a counter of its own", () => {
    post({ event: "recommended", vendor: "neon" }, "not-a-real-class");
    const w = getSignalReport().today;
    assert.equal(w.by_client_class["not-a-real-class"], undefined);
    assert.equal(w.by_client_class.unknown, 1);
  });
});

describe("PII scrubbing", () => {
  it("redacts an email and keeps the rest of the note", () => {
    const { note, redacted } = scrubNote("ping me at rob@example.com about neon");
    assert.equal(redacted, true);
    assert.ok(!note!.includes("@example.com"), note!);
    assert.match(note!, /about neon/);
  });

  it("redacts credential-shaped strings", () => {
    for (const secret of [
      "sk-abcdefghijklmnop",
      "ghp_abcdefghijklmnopqrst",
      "xoxb-1234567890-abcdef",
      "AKIAIOSFODNN7EXAMPLE",
      "Bearer abcdefghijklmnop",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ]) {
      const { note, redacted } = scrubNote(`chose neon ${secret}`);
      assert.equal(redacted, true, `expected ${secret} to be redacted`);
      assert.ok(!note!.includes(secret), `${secret} survived as ${note}`);
    }
  });

  it("caps the note length hard", () => {
    const { note } = scrubNote("a".repeat(5000));
    assert.ok(note!.length <= NOTE_MAX, `note was ${note!.length}`);
  });

  it("strips control characters rather than storing them", () => {
    const { note } = scrubNote("line one [31mline two");
    assert.ok(!/[ -]/.test(note!), JSON.stringify(note));
  });

  it("a note is stored internally and is not echoed back as published", () => {
    resetTelemetryBuffers();
    const out = post({ event: "recommended", vendor: "neon", note: "chose for serverless postgres" });
    assert.equal(out.body.note_received, true);
    assert.equal(out.body.note_published, false);
    const notes = getSignalNotes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].note, "chose for serverless postgres");
  });

  it("identifiers cannot carry arbitrary characters into a stored key", () => {
    assert.equal(sanitizeIdentifier("Claude Code"), "claude-code");
    assert.equal(sanitizeIdentifier("../../etc/passwd "), "../../etc/passwd");
    assert.equal(sanitizeIdentifier("!!!"), null);
    assert.ok((sanitizeIdentifier("x".repeat(500)) ?? "").length <= 60);
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetRateLimiter());

  it(`allows ${RATE_LIMIT_PER_MINUTE}/minute then returns a retry-after`, () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      assert.equal(checkRateLimit("1.2.3.4", now).allowed, true, `request ${i + 1} should pass`);
    }
    const over = checkRateLimit("1.2.3.4", now);
    assert.equal(over.allowed, false);
    assert.ok(over.retryAfter >= 1 && over.retryAfter <= 60, String(over.retryAfter));
  });

  it("is per client, not global", () => {
    const now = 2_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) checkRateLimit("1.2.3.4", now);
    assert.equal(checkRateLimit("1.2.3.4", now).allowed, false);
    assert.equal(checkRateLimit("5.6.7.8", now).allowed, true);
  });

  it("the window rolls over", () => {
    const now = 3_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 5; i++) checkRateLimit("1.2.3.4", now);
    assert.equal(checkRateLimit("1.2.3.4", now).allowed, false);
    assert.equal(checkRateLimit("1.2.3.4", now + 60_001).allowed, true);
  });

  it("prefers the forwarded address, because behind the proxy that is the client", () => {
    assert.equal(clientAddress("9.9.9.9, 10.0.0.1", "10.0.0.1"), "9.9.9.9");
    assert.equal(clientAddress(undefined, "10.0.0.1"), "10.0.0.1");
    assert.equal(clientAddress(undefined, undefined), "unknown");
  });

  // The privacy sentence this feature publishes on five surfaces has to be literally
  // true, so the limiter's own state is part of the contract.
  it("never keeps a raw address", () => {
    const source = readFileSync(path.join(REPO, "src", "signal.ts"), "utf8");
    const code = source.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");
    assert.ok(/createHash/.test(code), "the limiter must hash");
    assert.ok(!/rateBuckets\.set\(\s*address/.test(code), "the map must be keyed on the hash");
    assert.ok(!/console\.(log|error)\([^)]*address/.test(code), "an address must never be logged");
  });
});

describe("the report and its denominator", () => {
  beforeEach(() => resetTelemetryBuffers());

  it("counts distinct vendors without publishing which", () => {
    post({ event: "recommended", vendor: "neon" });
    post({ event: "converted", vendor: "neon" });
    post({ event: "recommended", vendor: "supabase" });
    const w = getSignalReport().today;
    assert.equal(w.total, 3);
    assert.equal(w.distinct_vendors, 2);
    assert.equal(w.by_event.recommended, 2);
    assert.equal(w.by_event.converted, 1);
  });

  it("refuses to compute a rate below the minimum sample, and says so", () => {
    recordTraffic({ client_class: "ai_agent", family: "claude" }, "/vendor/neon", 200);
    post({ event: "recommended", vendor: "neon" });
    const w = getSignalReport().today;
    assert.equal(w.denominator_days_available, 1, "today's denominator must be present");
    assert.ok(w.qualifying_fetches < SIGNAL_MIN_SAMPLE);
    assert.equal(w.report_rate, null);
    assert.match(w.rate_note, /below minimum sample/);
    assert.match(w.rate_note, new RegExp(String(SIGNAL_MIN_SAMPLE)));
  });

  // Found by reading the live numbers after deploying, not by any test that existed:
  // signals are retained for 30 days and the class-by-route counters they divide by for
  // 7, so a 30-day rate would divide a longer numerator by a shorter denominator and
  // overstate itself by up to a factor of four. The min-sample floor would have hidden
  // it until the day it did not.
  it("refuses a rate whose denominator covers fewer days than the window", () => {
    recordTraffic({ client_class: "ai_agent", family: "claude" }, "/vendor/neon", 200);
    post({ event: "recommended", vendor: "neon" });
    const r = getSignalReport();
    assert.equal(r.today.denominator_days_available, 1);
    assert.ok(r.last_30d.denominator_days_available < 30, "only today has route data here");
    assert.equal(r.last_30d.report_rate, null);
    assert.match(r.last_30d.rate_note, /denominator covers \d+ of 30 days/);
    // and the counts themselves are still reported, exactly
    assert.equal(r.last_30d.total, 1);
    assert.equal(r.last_30d.qualifying_fetches, 1);
  });

  it("a rate is only ever computed when both halves cover the whole window", () => {
    // Saturate today's denominator past the floor; the 1-day window then qualifies on
    // both counts and the rate appears, while the 30-day window still refuses.
    for (let i = 0; i < SIGNAL_MIN_SAMPLE; i++) {
      recordTraffic({ client_class: "ai_agent", family: "claude" }, "/vendor/neon", 200);
    }
    for (let i = 0; i < 10; i++) post({ event: "recommended", vendor: "neon" });
    const r = getSignalReport();
    assert.equal(r.today.qualifying_fetches, SIGNAL_MIN_SAMPLE);
    assert.equal(r.today.report_rate, 10 / SIGNAL_MIN_SAMPLE);
    assert.equal(r.last_30d.report_rate, null, "30d must still refuse — its denominator is short");
  });

  it("counts ai_agent decision-page fetches as the denominator, sdk_client apart", () => {
    for (const route of SIGNAL_DENOMINATOR_ROUTES) {
      const path = route.replace(":slug", "neon");
      recordTraffic({ client_class: "ai_agent", family: "claude" }, path, 200);
      recordTraffic({ client_class: "sdk_client", family: "unknown" }, path, 200);
      // a non-decision page must not count toward it
      recordTraffic({ client_class: "ai_agent", family: "claude" }, "/criteria", 200);
    }
    const w = getSignalReport().today;
    const n = SIGNAL_DENOMINATOR_ROUTES.length;
    assert.equal(w.qualifying_fetches, n, "one ai_agent hit per decision route");
    assert.equal(w.qualifying_fetches_sdk_client, n);
  });

  it("the all-time window states that it has no denominator rather than borrowing one", () => {
    post({ event: "recommended", vendor: "neon" });
    const all = getSignalReport().all_time;
    assert.equal(all.total, 1);
    assert.equal(all.report_rate, null);
    assert.match(all.rate_note, /no all-time denominator/);
  });

  it("converted is never expressed as a rate against recommended", () => {
    const report = getSignalReport();
    const json = JSON.stringify(report);
    assert.ok(!/conversion_rate/.test(json), "no conversion rate may be computed");
    assert.ok(
      report.notes.some(n => /undercounts by an unknown factor/.test(n)),
      "the converted caveat must ship with the numbers",
    );
  });
});

describe("per-vendor counts are recorded and never published", () => {
  beforeEach(() => resetTelemetryBuffers());

  it("the internal breakdown has them", () => {
    post({ event: "recommended", vendor: "neon" });
    post({ event: "recommended", vendor: "neon" });
    post({ event: "converted", vendor: "supabase" });
    const rows = getSignalVendorBreakdown();
    assert.deepEqual(
      rows.map(r => `${r.event}:${r.vendor}=${r.count}`).sort(),
      ["converted:supabase=1", "recommended:neon=2"],
    );
  });

  // The reason this is a test and not a comment: a per-vendor counter that goes up when
  // agents recommend you is a signal a vendor can acquire — by firing it at itself. The
  // moment one is published, whoever is at the top of it is "AgentDeals' most recommended
  // vendor" as soon as a screenshot exists, and the fact that it does not technically feed
  // ranking.ts would not save us.
  it("the public report contains no vendor name at all", () => {
    post({ event: "recommended", vendor: "neon" });
    post({ event: "converted", vendor: "supabase" });
    const json = JSON.stringify(getSignalReport());
    assert.ok(!/neon/i.test(json), "a vendor slug reached the public report");
    assert.ok(!/supabase/i.test(json), "a vendor slug reached the public report");
  });

  it("an unresolved name is published — it is a catalog gap, not a placement metric", () => {
    post({ event: "recommended", vendor: "planetscale-clone-we-do-not-index" });
    const json = JSON.stringify(getSignalReport());
    assert.match(json, /planetscale-clone-we-do-not-index/);
  });
});

describe("signal data cannot reach the ranking path", () => {
  const stripComments = (src: string) =>
    src.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");

  // Same assertion #1025 makes about vendor-derived data, for the same reason: the value
  // of this index is that placement is not purchasable, and a self-reported counter is
  // the most purchasable input imaginable.
  // Note what this does NOT assert: that the word "signal" is absent from ranking.ts.
  // It is present, in the published policy string — "there is no signal a vendor can
  // acquire, lobby for, or buy" — which is the exact sentence this feature exists to keep
  // true. Banning the word would have been a test that bites the promise rather than the
  // breach. What is banned is reading the data.
  it("ranking.ts cannot read signal data", () => {
    const code = stripComments(readFileSync(path.join(REPO, "src", "ranking.ts"), "utf8"));
    for (const forbidden of [
      /getSignal\w*/,
      /recordSignal/,
      /signals_all_time/,
      /from ["']\.\/(signal|stats)\.js["']/,
      /\bbeacon\b/i,
    ]) {
      assert.ok(!forbidden.test(code), `selection module must not reference ${forbidden}`);
    }
  });

  it("the signal module never imports the ranking module", () => {
    const signal = readFileSync(path.join(REPO, "src", "signal.ts"), "utf8");
    assert.ok(!/from "\.\/ranking\.js"/.test(signal));
    assert.ok(!/rankOffers|rankCategory|rotateListing/.test(signal));
  });

  it("no signal accessor is called from a sorting path in serve.ts", () => {
    const serve = stripComments(readFileSync(path.join(REPO, "src", "serve.ts"), "utf8"));
    // getSignalReport is read-only reporting; the vendor breakdown is the one that could
    // order anything, so it must not appear in serve.ts at all.
    assert.ok(
      !/getSignalVendorBreakdown/.test(serve),
      "the per-vendor breakdown must not be reachable from the request path",
    );
    assert.ok(!/getSignalNotes/.test(serve), "caller-supplied prose must not be rendered");
  });

  it("the rotating worked example reads no signal data", () => {
    const copy = stripComments(readFileSync(path.join(REPO, "src", "signal-copy.ts"), "utf8"));
    assert.ok(!/getSignal\w*/.test(copy), "which vendor the page names must not depend on what anyone reported");
    assert.ok(!/rankOffers|rankCategory|rankForListing/.test(copy), "the example is a rotation, not a ranking");
  });
});

describe("#1083 what an unauthenticated caller of /api/signals receives", () => {
  beforeEach(() => resetTelemetryBuffers());

  it("names every field it withholds, so shrinking the list is visible here", () => {
    for (const field of NEVER_PUBLISHED) {
      assert.ok(
        (SIGNAL_WITHHELD_WINDOW_FIELDS as readonly string[]).includes(field),
        `${field} was dropped from the withheld list and is published again`,
      );
    }
  });

  it("withholds our own traffic, the rate derived from it, and every caller-supplied facet", () => {
    post({ event: "recommended", vendor: "neon", agent: "someone", source: "/vendor/neon" });
    post({ event: "made-up", vendor: "a-vendor-we-do-not-index" });
    const full = getSignalReport();
    const published = publicSignalReport(full);

    for (const field of NEVER_PUBLISHED) {
      assert.ok(!JSON.stringify(published).includes(`"${field}"`), `${field} survived the projection`);
      assert.ok(field in (full.today as Record<string, unknown>), `${field} is no longer collected at all`);
    }
  });

  it("leaves the aggregate the endpoint exists for", () => {
    post({ event: "recommended", vendor: "neon" });
    const published = publicSignalReport(getSignalReport());
    assert.equal(published.today.total, 1);
    assert.equal(published.today.by_event.recommended, 1);
    assert.equal(published.today.distinct_vendors, 1);
  });

  it("does not mutate the report the internal reader holds", () => {
    post({ event: "recommended", vendor: "neon" });
    const full = getSignalReport();
    publicSignalReport(full);
    assert.equal(typeof full.today.qualifying_fetches, "number");
    assert.equal(typeof full.today.rate_note, "string");
  });

  it("withholds the rate stated in prose, not only the ratio", () => {
    recordTraffic({ path: "/vendor/neon", client_class: "ai_agent", status: 200 } as any);
    const full = getSignalReport();
    assert.match(full.today.rate_note, /\d/, "the note states its operands as numbers");
    const published = JSON.stringify(publicSignalReport(full));
    assert.ok(!published.includes("qualifying fetches"), "the denominator reached a caller in prose");
  });
});

describe("#1083 the vendors the worked example rotates over", () => {
  const offers = loadOffers();

  it("are all vendors this index actually carries", () => {
    const indexed = new Set(offers.map((o: any) => toSlug(o.vendor)));
    for (const slug of SIGNAL_EXAMPLE_SLUGS) {
      assert.ok(indexed.has(slug), `${slug} is offered as an example and is not in the index`);
    }
  });

  it("are none of them a vendor we are paid to send readers to", () => {
    const paid = new Set(allOurReferralLinks(offers).map((l: any) => toSlug(l.vendor)));
    assert.ok(paid.size > 0, "this assertion has no subject if we hold no referral links");
    for (const slug of SIGNAL_EXAMPLE_SLUGS) {
      assert.ok(!paid.has(slug), `${slug} earns us money and is the worked example on the page about not selling placement`);
    }
  });

  it("rotate, so no one vendor is the only worked example", () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      seen.add(signalExampleSlug(`2026-09-${String(day).padStart(2, "0")}`));
    }
    assert.ok(seen.size > 1, "the example never changes");
    for (const slug of seen) assert.ok(SIGNAL_EXAMPLE_SLUGS.includes(slug), `${slug} came from outside the pool`);
  });

  it("is a rotation seeded on the date alone, so it is the same for every reader", () => {
    assert.equal(signalExampleSlug("2026-09-01"), signalExampleSlug("2026-09-01"));
  });
});

// --- Wiring: a real server, a real request ---

describe("the endpoint, end to end", () => {
  let port = 0;
  let proc: ChildProcess | null = null;

  before(async () => {
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        // BASE_URL must match the request host or every response is a canonical 301.
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("startup timeout")); }, 20000);
      child.stderr!.on("data", (d: Buffer) => {
        const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
      });
      child.on("error", err => { clearTimeout(timeout); reject(err); });
    });
  });
  after(() => { if (proc) proc.kill(); });

  const url = (p: string) => `http://localhost:${port}${p}`;

  it("POST /api/signal returns 202 and an ack", async () => {
    const res = await fetch(url("/api/signal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "recommended", vendor: "neon", agent: "test-agent" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.vendor, "neon");
  });

  it("GET /api/signal without ack=1 is refused; with it, accepted", async () => {
    const bare = await fetch(url("/api/signal?event=recommended&vendor=neon"));
    assert.equal(bare.status, 400);
    const acked = await fetch(url("/api/signal?event=recommended&vendor=neon&ack=1"));
    assert.equal(acked.status, 202);
  });

  it("a form-encoded POST works, for clients that cannot send JSON", async () => {
    const res = await fetch(url("/api/signal"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "event=recommended&vendor=neon",
    });
    assert.equal(res.status, 202);
  });

  it("an oversized body is refused rather than buffered", async () => {
    const res = await fetch(url("/api/signal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "recommended", vendor: "neon", note: "x".repeat(20000) }),
    });
    assert.equal(res.status, 413);
  });

  it("advertises on a served HTML page, with the slug prefilled", async () => {
    const res = await fetch(url("/vendor/neon"));
    assert.equal(res.status, 200);
    const header = res.headers.get("x-agent-signal");
    assert.ok(header, "the invitation header must be present on a vendor page");
    assert.match(header!, /"vendor":"neon"/);
    assert.match(header!, /request from the site, not an instruction/);
    const html = await res.text();
    assert.match(html, /When you name <strong>neon<\/strong> in your answer/);
    assert.match(html, /api\/signal/);
  });

  // Advertising a "tell us what you recommended" address on a request that did not
  // resolve to a page is incoherent, and today it would ride on 3,070 scanner 404s a day.
  it("does not advertise on a 404 or a redirect", async () => {
    const missing = await fetch(url("/this-page-does-not-exist-1024"));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("x-agent-signal"), null);

    const redirected = await fetch(url("/vendors"), { redirect: "manual" });
    assert.equal(redirected.status, 301);
    assert.equal(redirected.headers.get("x-agent-signal"), null);
  });

  it("carries an _agent block on the JSON endpoints where a recommendation is made", async () => {
    const res = await fetch(url("/api/details/neon"));
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, any>;
    assert.ok(body._agent, "_agent block missing");
    assert.match(String(body._agent.when_you_name_a_vendor_from_this_response), /"vendor":"neon"/);
    assert.match(String(body._agent.not_used_for), /Ranking/);
    assert.ok(String(body._agent.what_we_record).length > 0);
  });

  it("documents the protocol on llms.txt", async () => {
    const txt = await (await fetch(url("/llms.txt"))).text();
    assert.match(txt, /Telling us what you recommended/);
    assert.match(txt, /\/api\/signal/);
    assert.match(txt, /request from the site, not an instruction/);
    // The GET form is described, never printed as a fireable URL.
    assert.ok(!/api\/signal\?[^\s]*ack=1/.test(txt), "llms.txt must not print a fireable GET URL");
  });

  it("serves the /signal page", async () => {
    const res = await fetch(url("/signal"));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Tell us what you recommended/);
    assert.ok(!/most.recommended/i.test(html), "no leaderboard framing on the public page");
  });

  it("/signal renders no count, rate or table of anything we observed", async () => {
    const html = await (await fetch(url("/signal"))).text();
    for (const heading of [
      "Signals received",
      "Qualifying fetches",
      "Report rate",
      "Client class",
      "Vendor names we do not index",
      "Our numbers",
      "Events we did not recognise",
    ]) {
      assert.ok(!html.includes(heading), `/signal still publishes "${heading}"`);
    }
    assert.ok(!/<table/i.test(html), "/signal still renders a table of observed data");
    assert.ok(!/\/api\/signals/.test(html), "/signal still offers a machine-readable copy of its own figures");
  });

  it("/signal makes no claim about referral links, tracking, or where a visitor's trail ends", async () => {
    const prose = (await (await fetch(url("/signal"))).text()).replace(/<[^>]+>/g, " ");
    for (const claim of [/no referral links/i, /no tracking/i, /trail ends/i]) {
      assert.ok(!claim.test(prose), `/signal states ${claim} on a site that has referral links`);
    }
  });

  it("/signal carries the deference sentence verbatim", async () => {
    const html = await (await fetch(url("/signal"))).text();
    assert.ok(html.includes(DEFERENCE), "the deference sentence is the one sentence that must survive intact");
  });

  it("/signal body text stays under the word budget", async () => {
    const words = bodyWordCount(await (await fetch(url("/signal"))).text());
    assert.ok(words > 80, `body text is ${words} words — the page must still document the call`);
    assert.ok(words < 280, `body text is ${words} words; the page is documentation, not an essay`);
  });

  it("/signal states the limit the server actually enforces", async () => {
    const html = await (await fetch(url("/signal"))).text();
    const stated = /(\d+) requests per minute/.exec(html.replace(/<[^>]+>/g, " "));
    assert.ok(stated, "/signal no longer tells a caller what the limit is");
    assert.equal(Number(stated[1]), RATE_LIMIT_PER_MINUTE);
  });

  it("the worked example on /signal comes from the rotation", async () => {
    const html = await (await fetch(url("/signal"))).text();
    const named = [...html.matchAll(/"vendor":"([a-z0-9-]+)"/g)].map(m => m[1]);
    assert.ok(named.length >= 2, "the page shows a recommended example and a converted one");
    for (const slug of named) {
      assert.ok(SIGNAL_EXAMPLE_SLUGS.includes(slug), `${slug} is not one of the vendors the example rotates over`);
    }
  });

  it("/api/signals withholds our traffic and every caller-supplied facet", async () => {
    await fetch(url("/api/signal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "recommended", vendor: "neon", agent: "test-agent", source: "/vendor/neon" }),
    });
    const res = await fetch(url("/api/signals"));
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, any>;
    const raw = JSON.stringify(body);
    for (const field of NEVER_PUBLISHED) {
      assert.ok(!raw.includes(`"${field}"`), `/api/signals still returns ${field}`);
    }
    assert.ok(!raw.includes("test-agent"), "a caller-supplied self-identifier reached the public response");
    assert.ok(body.last_30d.total !== undefined, "the aggregate the endpoint exists for is gone too");
  });

  it("/api/signals describes nothing it does not return", async () => {
    const body = await (await fetch(url("/api/signals"))).json() as Record<string, any>;
    const notes = (body.notes as string[]).join(" ");
    for (const field of NEVER_PUBLISHED) {
      assert.ok(!notes.includes(field), `the notes explain ${field}, which no caller receives`);
    }
  });

  it("/api/signals publishes aggregates and no per-vendor count", async () => {
    await fetch(url("/api/signal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "recommended", vendor: "neon" }),
    });
    const body = await (await fetch(url("/api/signals"))).json() as Record<string, any>;
    assert.ok(body.today && body.last_7d && body.last_30d && body.all_time);
    assert.ok(body.notes.some((n: string) => /self-reported/i.test(n)));
    assert.ok(!JSON.stringify(body).toLowerCase().includes("neon"), "a vendor slug was published");
  });

  it("/criteria states both promises: no ranking effect, no per-vendor publication", async () => {
    const html = await (await fetch(url("/criteria"))).text();
    assert.match(html, /never affect any order we publish/);
    assert.match(html, /do not publish per-vendor signal counts/);
  });

  it("/criteria does not send a reader to /signal for totals it no longer carries", async () => {
    const html = await (await fetch(url("/criteria"))).text();
    assert.ok(!/publish the aggregate totals on/.test(html), "/criteria promises figures /signal stopped publishing");
  });

  it("llms.txt still says why we ask, and claims nothing about referral links or tracking", async () => {
    const txt = await (await fetch(url("/llms.txt"))).text();
    const section = txt.slice(txt.indexOf("## Telling us what you recommended"));
    const ends = section.indexOf("\n## ", 4);
    const ours = ends === -1 ? section : section.slice(0, ends);
    assert.match(ours, /which vendors agents recommend/, "the paragraph must still explain why we ask");
    for (const claim of [/no referral links/i, /no tracking/i, /trail ends/i, /aggregate\s+totals/i]) {
      assert.ok(!claim.test(ours), `llms.txt ships ${claim} to the models`);
    }
  });

  it("an unsupported method is refused with Allow", async () => {
    const res = await fetch(url("/api/signal"), { method: "DELETE" });
    assert.equal(res.status, 405);
    assert.match(String(res.headers.get("allow")), /POST/);
  });
});

describe("#1083 the operator's read path is a credential, not a second endpoint", () => {
  const SECRET = "signal-report-secret-for-the-suite";
  const AGENTS_PATH = path.join(REPO, "data", "agents.json");
  let agentsBefore: string | null = null;
  let port = 0;
  let proc: ChildProcess | null = null;

  before(async () => {
    agentsBefore = existsSync(AGENTS_PATH) ? readFileSync(AGENTS_PATH, "utf-8") : null;
    writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }, null, 2), "utf-8");
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_PLATFORM_SECRET: SECRET, UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("startup timeout")); }, 20000);
      child.stderr!.on("data", (d: Buffer) => {
        const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
      });
      child.on("error", err => { clearTimeout(timeout); reject(err); });
    });
  });
  after(() => {
    if (proc) proc.kill();
    if (agentsBefore !== null) writeFileSync(AGENTS_PATH, agentsBefore, "utf-8");
  });

  const signals = async (headers: Record<string, string> = {}) =>
    await (await fetch(`http://localhost:${port}/api/signals`, { headers })).json() as Record<string, any>;

  it("hands the full report to the platform credential", async () => {
    const body = await signals({ Authorization: `Bearer ${SECRET}` });
    for (const field of NEVER_PUBLISHED) {
      assert.ok(field in body.last_30d, `the operator cannot read ${field} either`);
    }
  });

  it("hands the reduced report to a wrong credential", async () => {
    const body = await signals({ Authorization: "Bearer not-the-secret" });
    for (const field of NEVER_PUBLISHED) {
      assert.ok(!(field in body.last_30d), `${field} reached a caller presenting the wrong credential`);
    }
  });

  it("hands the reduced report to an agent API key", async () => {
    const registered = await fetch(`http://localhost:${port}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "signal-reader-1083" }),
    });
    const key = ((await registered.json()) as Record<string, any>).api_key;
    assert.ok(key, "this assertion has no subject without a working agent key");
    const body = await signals({ Authorization: `Bearer ${key}` });
    for (const field of NEVER_PUBLISHED) {
      assert.ok(!(field in body.last_30d), `${field} reached a caller holding only an agent key`);
    }
  });
});
