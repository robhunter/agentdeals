import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const {
  recordSessionConnect,
  getConnectionStats,
  getSessionSeries,
  getSessionsForDate,
  getTrafficReport,
  resetCounters,
  resetTelemetryBuffers,
  resetTelemetryHealth,
  loadTelemetry,
  flushPending,
  getTelemetryHealth,
  OTHER_SESSION_CLIENT_KEY,
  UNNAMED_SESSION_CLIENT_KEY,
  MAX_SESSION_CLIENT_KEYS_PER_DAY,
} = await import("../dist/stats.js");

const PAGE_VIEWS_KEY = "agentdeals:pageviews";

type Call = { cmd: string; args: unknown[] };

class FakeUpstash {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();
  calls: Call[] = [];

  reset(): void {
    this.calls = [];
  }
  commandCount(cmd?: string): number {
    return cmd ? this.calls.filter(c => c.cmd === cmd).length : this.calls.length;
  }
  exec(cmd: string, args: unknown[]): unknown {
    switch (cmd) {
      case "GET": {
        const v = this.values.get(String(args[0]));
        return { result: v === undefined ? null : v };
      }
      case "SET":
        this.values.set(String(args[0]), String(args[1]));
        return { result: "OK" };
      case "MGET":
        return { result: args.map(k => this.values.get(String(k)) ?? null) };
      case "SCAN":
        return { result: ["0", []] };
      case "LPUSH": {
        const key = String(args[0]);
        const list = this.lists.get(key) ?? [];
        for (const v of args.slice(1)) list.unshift(String(v));
        this.lists.set(key, list);
        return { result: list.length };
      }
      case "LRANGE": {
        const list = this.lists.get(String(args[0])) ?? [];
        return { result: list.slice(Number(args[1]), Number(args[2]) + 1) };
      }
      default:
        return { result: 1 };
    }
  }
}

const realFetch = globalThis.fetch;
let redis: FakeUpstash;
let telemetryFile: string;

function installFetchStub(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as unknown[];
    const cmd = String(parsed[0]).toUpperCase();
    const args = parsed.slice(1);
    redis.calls.push({ cmd, args });
    return { ok: true, status: 200, json: async () => redis.exec(cmd, args) };
  }) as unknown as typeof fetch;
}

async function boot(): Promise<void> {
  await loadTelemetry(telemetryFile);
  redis.reset();
  resetTelemetryHealth();
}

async function redeploy(): Promise<void> {
  resetCounters();
  resetTelemetryBuffers();
  await boot();
}

function storedSnapshot(): Record<string, any> {
  const raw = redis.values.get(PAGE_VIEWS_KEY);
  assert.ok(raw, "expected a persisted snapshot");
  return JSON.parse(raw!);
}

const today = () => new Date().toISOString().slice(0, 10);

describe("daily MCP session counts (#1052)", () => {
  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
    redis = new FakeUpstash();
    telemetryFile = join(tmpdir(), `sessions-${randomUUID()}.json`);
    resetCounters();
    resetTelemetryBuffers();
    resetTelemetryHealth();
    installFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("keeps counting today's sessions across a deploy", async () => {
    await boot();
    for (let i = 0; i < 7; i++) recordSessionConnect("opencode");
    assert.strictEqual(getConnectionStats(0).sessionsToday, 7);
    await flushPending();

    await redeploy();

    assert.strictEqual(
      getConnectionStats(0).sessionsToday,
      7,
      "a restart must not restart the day",
    );
    recordSessionConnect("claude-code");
    assert.strictEqual(getConnectionStats(0).sessionsToday, 8);
  });

  it("adds post-deploy sessions to the pre-deploy count rather than replacing them", async () => {
    await boot();
    for (let i = 0; i < 4; i++) recordSessionConnect("opencode");
    await flushPending();
    await redeploy();
    for (let i = 0; i < 3; i++) recordSessionConnect("opencode");
    await flushPending();
    await redeploy();
    for (let i = 0; i < 2; i++) recordSessionConnect("opencode");

    assert.strictEqual(getConnectionStats(0).sessionsToday, 9);
  });

  it("counts a session the moment it happens, before the next flush", async () => {
    await boot();
    recordSessionConnect("opencode");
    assert.strictEqual(
      getConnectionStats(0).sessionsToday,
      1,
      "the un-flushed buffer is part of the answer",
    );
  });

  it("attributes each day to its own key so a rollover needs no reset", async () => {
    await boot();
    recordSessionConnect("opencode");
    await flushPending();

    const stored = storedSnapshot();
    assert.deepStrictEqual(Object.keys(stored.sessions), [today()]);
    assert.strictEqual(stored.sessions[today()], 1);
    assert.strictEqual(getSessionsForDate("2020-01-01"), 0);
  });

  it("makes a session on its own worth a flush", async () => {
    await boot();
    recordSessionConnect("opencode");
    const before = redis.commandCount("SET");
    await flushPending();
    assert.ok(
      redis.commandCount("SET") > before,
      "an MCP-only interval records no page view; sessions must trigger the write themselves",
    );
  });

  it("costs no Redis command per session", async () => {
    await boot();
    for (let i = 0; i < 250; i++) recordSessionConnect(`client-${i % 5}`);
    assert.strictEqual(
      redis.commandCount(),
      0,
      "recording must stay in memory — #1023's write pattern is the reason the snapshot exists",
    );
  });

  it("records which clients opened the day's sessions", async () => {
    await boot();
    recordSessionConnect("opencode");
    recordSessionConnect("opencode");
    recordSessionConnect("glimind-probe");
    await flushPending();

    assert.deepStrictEqual(storedSnapshot().session_clients[today()], {
      opencode: 2,
      "glimind-probe": 1,
    });
  });

  it("buckets a session with no client name apart from a named one", async () => {
    await boot();
    recordSessionConnect();
    recordSessionConnect("   ");
    recordSessionConnect("opencode");
    await flushPending();

    const clients = storedSnapshot().session_clients[today()];
    assert.strictEqual(clients[UNNAMED_SESSION_CLIENT_KEY], 2);
    assert.strictEqual(clients.opencode, 1);
  });

  it("caps the caller-supplied client key space without losing a session", async () => {
    await boot();
    for (let i = 0; i < 400; i++) recordSessionConnect(`attacker-supplied-${i}`);
    await flushPending();

    const clients = storedSnapshot().session_clients[today()];
    assert.ok(
      Object.keys(clients).length <= MAX_SESSION_CLIENT_KEYS_PER_DAY + 1,
      `key space must stay bounded, saw ${Object.keys(clients).length}`,
    );
    assert.ok(clients[OTHER_SESSION_CLIENT_KEY] > 0, "the excess must be folded, not dropped");
    const total = Object.values(clients).reduce((a, b) => (a as number) + (b as number), 0);
    assert.strictEqual(total, 400, "every session must still be counted somewhere");
    assert.strictEqual(getConnectionStats(0).sessionsToday, 400);
  });

  it("does not carry a client name across from the cap into the next day's budget", async () => {
    await boot();
    for (let i = 0; i < 400; i++) recordSessionConnect(`attacker-supplied-${i}`);
    await flushPending();
    assert.strictEqual(
      storedSnapshot().sessions[today()],
      400,
      "the per-day total is a single key and is never subject to the client cap",
    );
  });

  it("dates the series so a reader cannot plot zero where nothing was measured", async () => {
    await boot();
    recordSessionConnect("opencode");
    await flushPending();

    const series = getSessionSeries();
    assert.strictEqual(series.recording_since, today());
    assert.deepStrictEqual(series.daily, [{ date: today(), sessions: 1 }]);
    assert.strictEqual(series.today, 1);
  });

  it("keeps recording_since at the first date, not the latest", async () => {
    await boot();
    recordSessionConnect("opencode");
    await flushPending();

    const stored = storedSnapshot();
    stored.sessions["2026-01-01"] = 5;
    stored.sessions_from = "2026-01-01";
    redis.values.set(PAGE_VIEWS_KEY, JSON.stringify(stored));

    await redeploy();
    recordSessionConnect("opencode");

    const series = getSessionSeries();
    assert.strictEqual(series.recording_since, "2026-01-01");
    assert.deepStrictEqual(
      series.daily.map((d: { date: string }) => d.date),
      ["2026-01-01", today()],
    );
  });

  it("keeps the stored first-measured date when a later day flushes over it", async () => {
    redis.values.set(
      PAGE_VIEWS_KEY,
      JSON.stringify({
        days: {},
        all_time: {},
        sessions: { "2026-01-01": 5 },
        sessions_from: "2026-01-01",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await boot();
    recordSessionConnect("opencode");
    await flushPending();

    assert.strictEqual(
      storedSnapshot().sessions_from,
      "2026-01-01",
      "a flush must not move the date the series began",
    );
    assert.strictEqual(getSessionSeries().recording_since, "2026-01-01");
  });

  it("adds the day's clients to the stored ones rather than replacing them", async () => {
    await boot();
    recordSessionConnect("opencode");
    recordSessionConnect("claude-code");
    await flushPending();

    await redeploy();
    recordSessionConnect("opencode");
    recordSessionConnect("codex-mcp-client");
    await flushPending();

    assert.deepStrictEqual(storedSnapshot().session_clients[today()], {
      opencode: 2,
      "claude-code": 1,
      "codex-mcp-client": 1,
    });
    assert.strictEqual(storedSnapshot().sessions[today()], 4);
  });

  it("holds the stored client key space at the cap across repeated flushes", async () => {
    await boot();
    for (let i = 0; i < 400; i++) recordSessionConnect(`first-batch-${i}`);
    await flushPending();
    for (let i = 0; i < 400; i++) recordSessionConnect(`second-batch-${i}`);
    await flushPending();

    const clients = storedSnapshot().session_clients[today()];
    assert.ok(
      Object.keys(clients).length <= MAX_SESSION_CLIENT_KEYS_PER_DAY + 1,
      `key space must stay bounded across flushes, saw ${Object.keys(clients).length}`,
    );
    const total = Object.values(clients).reduce((a, b) => (a as number) + (b as number), 0);
    assert.strictEqual(total, 800, "no session may be lost to the cap");
    assert.strictEqual(storedSnapshot().sessions[today()], 800);
  });

  it("caps the merged day when an outgoing instance flushes its own clients after we booted", async () => {
    await boot();
    for (let i = 0; i < MAX_SESSION_CLIENT_KEYS_PER_DAY; i++) {
      recordSessionConnect(`incoming-${i}`);
    }

    const departing: Record<string, number> = {};
    for (let i = 0; i < MAX_SESSION_CLIENT_KEYS_PER_DAY; i++) departing[`departing-${i}`] = 1;
    redis.values.set(
      PAGE_VIEWS_KEY,
      JSON.stringify({
        days: {},
        all_time: {},
        sessions: { [today()]: MAX_SESSION_CLIENT_KEYS_PER_DAY },
        session_clients: { [today()]: departing },
        sessions_from: today(),
        updated_at: new Date().toISOString(),
      }),
    );

    await flushPending();

    const clients = storedSnapshot().session_clients[today()];
    assert.ok(
      Object.keys(clients).length <= MAX_SESSION_CLIENT_KEYS_PER_DAY + 1,
      `the merge must bound the key space it did not record, saw ${Object.keys(clients).length}`,
    );
    const total = Object.values(clients).reduce((a, b) => (a as number) + (b as number), 0);
    assert.strictEqual(
      total,
      MAX_SESSION_CLIENT_KEYS_PER_DAY * 2,
      "both instances' sessions must survive the merge",
    );
    assert.strictEqual(
      storedSnapshot().sessions[today()],
      MAX_SESSION_CLIENT_KEYS_PER_DAY * 2,
      "the day total must include the departing instance's final batch",
    );
  });

  it("bounds what an unflushed burst of new client names can hold in memory", async () => {
    await boot();
    const before = getTelemetryHealth().pending_page_view_keys;
    for (let i = 0; i < 5000; i++) recordSessionConnect(`burst-${i}`);

    const growth = getTelemetryHealth().pending_page_view_keys - before;
    assert.ok(
      growth <= MAX_SESSION_CLIENT_KEYS_PER_DAY + 2,
      `an unflushed burst must not grow the buffer per distinct name, grew by ${growth}`,
    );
    assert.strictEqual(
      getConnectionStats(0).sessionsToday,
      5000,
      "bounding the buffer must not lose a session from the day",
    );
  });

  it("reports the lifetime total separately from the dated series", async () => {
    await boot();
    recordSessionConnect("opencode");
    const series = getSessionSeries();
    assert.strictEqual(series.all_time, getConnectionStats(0).totalSessionsAllTime);
    assert.ok(
      series.retention_days >= 30,
      "the session series is the narrowest map in the snapshot and is kept longer than the 30-day counters",
    );
  });

  it("reads a snapshot written before the series existed as unmeasured, not as zero sessions", async () => {
    redis.values.set(
      PAGE_VIEWS_KEY,
      JSON.stringify({ days: {}, all_time: {}, updated_at: "2026-08-01T00:00:00.000Z" }),
    );
    await boot();

    const series = getSessionSeries();
    assert.strictEqual(series.recording_since, null);
    assert.deepStrictEqual(series.daily, []);
  });

  it("publishes the series on the traffic report", async () => {
    await boot();
    recordSessionConnect("opencode");
    await flushPending();

    const report = getTrafficReport();
    assert.strictEqual(report.sessions.today, 1);
    assert.strictEqual(report.sessions.recording_since, today());
    assert.ok(
      report.notes.some((n: string) => n.includes("recording_since")),
      "the rule for reading the series must be published with it",
    );
  });

  it("still answers from the buffer when storage is unavailable", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetCounters();
    resetTelemetryBuffers();
    recordSessionConnect("opencode");

    const report = getTrafficReport();
    assert.strictEqual(report.available, false);
    assert.strictEqual(
      report.sessions.today,
      1,
      "a session this process saw is an observation of this process, exactly like since_boot_by_class",
    );
  });
});
