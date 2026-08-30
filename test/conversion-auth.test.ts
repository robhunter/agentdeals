import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");

const PLATFORM_SECRET = "test-platform-secret-1164";
const HELD_VENDOR = "Railway";

const { MAX_COMMISSION_AMOUNT } = await import("../dist/ledger.js");
const { resetAgentsCache } = await import("../dist/agents.js");
const { resetLedgerCache } = await import("../dist/ledger.js");

const managedPaths = [AGENTS_PATH, LEDGER_PATH, BALANCES_PATH, REQUESTS_PATH];
const emptyContents = new Map<string, string>([
  [AGENTS_PATH, JSON.stringify({ agents: [] })],
  [LEDGER_PATH, JSON.stringify({ ledger_entries: [] })],
  [BALANCES_PATH, JSON.stringify({ agent_balances: [] })],
  [REQUESTS_PATH, JSON.stringify({ referral_requests: [] })],
]);
const originals = new Map<string, string | null>();

function saveOriginals(): void {
  for (const p of managedPaths) {
    originals.set(p, fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null);
  }
}

function restoreOriginals(): void {
  for (const p of managedPaths) {
    const held = originals.get(p) ?? null;
    if (held !== null) fs.writeFileSync(p, held, "utf-8");
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetAgentsCache();
  resetLedgerCache();
}

function emptyTheStores(): void {
  for (const p of managedPaths) fs.writeFileSync(p, emptyContents.get(p)!, "utf-8");
  resetAgentsCache();
  resetLedgerCache();
}

function ledgerEntryCount(): number {
  const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8")) as { ledger_entries?: unknown[] };
  return Array.isArray(raw.ledger_entries) ? raw.ledger_entries.length : 0;
}

function startHttpServer(extraEnv: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...extraEnv },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 15000);

    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10) });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("Conversion endpoints require the platform credential", () => {
  let serverProc: ChildProcess;
  let port = 0;
  let agentKey = "";

  const post = (route: string, opts: { credential?: string; body?: unknown } = {}) =>
    fetch(`http://localhost:${port}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.credential ? { Authorization: `Bearer ${opts.credential}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  const conversionBody = (over: Record<string, unknown> = {}) => ({
    vendor: HELD_VENDOR,
    referral_code: "AUTHTEST",
    commission_amount: 4.25,
    conversion_date: "2026-04-13",
    ...over,
  });

  before(async () => {
    saveOriginals();
    emptyTheStores();
    const started = await startHttpServer({ AGENTDEALS_PLATFORM_SECRET: PLATFORM_SECRET });
    serverProc = started.proc;
    port = started.port;

    const registered = await post("/api/agents/register", { body: { name: "ConversionAuthProbe" } });
    agentKey = ((await registered.json()) as { api_key: string }).api_key;
  });

  after(() => {
    serverProc?.kill();
    restoreOriginals();
  });

  const routes: Array<{ route: string; body?: unknown }> = [
    { route: "/api/conversions", body: { vendor: HELD_VENDOR, commission_amount: 1 } },
    { route: "/api/conversions/confirm" },
    { route: "/api/conversions/clawback", body: { entry_id: "le_whatever" } },
  ];

  for (const { route, body } of routes) {
    it(`POST ${route} returns 401 with no credential`, async () => {
      const res = await post(route, { body });
      assert.strictEqual(res.status, 401);
      const parsed = (await res.json()) as { error: string };
      assert.match(parsed.error, /platform credential/);
    });

    it(`POST ${route} returns 401 with a wrong credential`, async () => {
      const res = await post(route, { credential: "not-the-secret", body });
      assert.strictEqual(res.status, 401);
    });

    it(`POST ${route} returns 401 when presented an agent API key`, async () => {
      const res = await post(route, { credential: agentKey, body });
      assert.strictEqual(res.status, 401);
    });
  }

  it("writes nothing to the ledger when the caller has no credential", async () => {
    const before = ledgerEntryCount();
    const res = await post("/api/conversions", { body: conversionBody({ commission_amount: 999 }) });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(ledgerEntryCount(), before);
  });

  it("records a conversion for a credentialled caller", async () => {
    const before = ledgerEntryCount();
    const res = await post("/api/conversions", { credential: PLATFORM_SECRET, body: conversionBody() });
    assert.strictEqual(res.status, 201);
    const entry = (await res.json()) as { id: string; vendor: string; commission_amount: number; status: string };
    assert.ok(entry.id.startsWith("le_"));
    assert.strictEqual(entry.vendor, HELD_VENDOR);
    assert.strictEqual(entry.commission_amount, 4.25);
    assert.strictEqual(entry.status, "pending");
    assert.strictEqual(ledgerEntryCount(), before + 1);
  });

  it("runs the confirmation sweep for a credentialled caller", async () => {
    const res = await post("/api/conversions/confirm", { credential: PLATFORM_SECRET });
    assert.strictEqual(res.status, 200);
    const parsed = (await res.json()) as { confirmed_count: number; confirmed_ids: string[] };
    assert.ok("confirmed_count" in parsed);
    assert.ok(Array.isArray(parsed.confirmed_ids));
  });

  it("reaches the clawback lookup for a credentialled caller", async () => {
    const res = await post("/api/conversions/clawback", {
      credential: PLATFORM_SECRET,
      body: { entry_id: "le_does_not_exist" },
    });
    assert.strictEqual(res.status, 404);
  });

  it("rejects a commission above the maximum recordable amount", async () => {
    const before = ledgerEntryCount();
    const res = await post("/api/conversions", {
      credential: PLATFORM_SECRET,
      body: conversionBody({ commission_amount: MAX_COMMISSION_AMOUNT + 1 }),
    });
    assert.strictEqual(res.status, 400);
    const parsed = (await res.json()) as { error: string };
    assert.match(parsed.error, /maximum recordable commission/);
    assert.strictEqual(ledgerEntryCount(), before);
  });

  it("accepts a commission at the maximum recordable amount", async () => {
    const res = await post("/api/conversions", {
      credential: PLATFORM_SECRET,
      body: conversionBody({ commission_amount: MAX_COMMISSION_AMOUNT }),
    });
    assert.strictEqual(res.status, 201);
  });

  it("reports a commission that is not a finite number as not a number, not as too large", async () => {
    const notNumbers = [
      '{"vendor":"Railway","commission_amount":1e400}',
      '{"vendor":"Railway","commission_amount":-1e400}',
      '{"vendor":"Railway","commission_amount":"5"}',
      '{"vendor":"Railway","commission_amount":null}',
    ];
    for (const raw of notNumbers) {
      const res = await fetch(`http://localhost:${port}/api/conversions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${PLATFORM_SECRET}` },
        body: raw,
      });
      assert.strictEqual(res.status, 400, `should reject ${raw}`);
      const parsed = (await res.json()) as { error: string };
      assert.match(parsed.error, /commission_amount is required and must be a positive number/, `for ${raw}`);
    }
  });

  it("rejects a vendor we hold no referral link for", async () => {
    const before = ledgerEntryCount();
    const res = await post("/api/conversions", {
      credential: PLATFORM_SECRET,
      body: conversionBody({ vendor: "A Vendor We Have Never Heard Of" }),
    });
    assert.strictEqual(res.status, 400);
    const parsed = (await res.json()) as { error: string };
    assert.match(parsed.error, /No referral link of ours/);
    assert.strictEqual(ledgerEntryCount(), before);
  });

  it("rejects a vendor that runs its own programme when we hold no link into it", async () => {
    const before = ledgerEntryCount();
    const res = await post("/api/conversions", {
      credential: PLATFORM_SECRET,
      body: conversionBody({ vendor: "Vercel" }),
    });
    assert.strictEqual(res.status, 400);
    const parsed = (await res.json()) as { error: string };
    assert.match(parsed.error, /No referral link of ours/);
    assert.strictEqual(ledgerEntryCount(), before);
  });

  it("matches a held vendor by slug as well as by name", async () => {
    const res = await post("/api/conversions", {
      credential: PLATFORM_SECRET,
      body: conversionBody({ vendor: "railway" }),
    });
    assert.strictEqual(res.status, 201);
  });
});

describe("Conversion endpoints with no platform secret configured", () => {
  let serverProc: ChildProcess;
  let port = 0;

  before(async () => {
    saveOriginals();
    emptyTheStores();
    const started = await startHttpServer({ AGENTDEALS_PLATFORM_SECRET: "" });
    serverProc = started.proc;
    port = started.port;
  });

  after(() => {
    serverProc?.kill();
    restoreOriginals();
  });

  it("refuses every caller rather than admitting every caller", async () => {
    for (const credential of [undefined, "", "guess", "Bearer"]) {
      const res = await fetch(`http://localhost:${port}/api/conversions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(credential === undefined ? {} : { Authorization: `Bearer ${credential}` }),
        },
        body: JSON.stringify({ vendor: HELD_VENDOR, commission_amount: 1 }),
      });
      assert.strictEqual(res.status, 401, `credential ${JSON.stringify(credential)} should not be admitted`);
    }
    assert.strictEqual(ledgerEntryCount(), 0);
  });
});

describe("Agent registration is open but rate limited", () => {
  let serverProc: ChildProcess;
  let port = 0;

  before(async () => {
    saveOriginals();
    emptyTheStores();
    const started = await startHttpServer({ AGENTDEALS_REGISTER_LIMIT_PER_HOUR: "2" });
    serverProc = started.proc;
    port = started.port;
  });

  after(() => {
    serverProc?.kill();
    restoreOriginals();
  });

  const register = (name: string) =>
    fetch(`http://localhost:${port}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

  it("admits the allowance, then answers 429 with the headers the API page promises", async () => {
    const first = await register("RateLimitedBotOne");
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.headers.get("x-ratelimit-limit"), "2");
    assert.strictEqual(first.headers.get("x-ratelimit-remaining"), "1");
    assert.ok(Number(first.headers.get("x-ratelimit-reset")) > 0);

    const second = await register("RateLimitedBotTwo");
    assert.strictEqual(second.status, 201);
    assert.strictEqual(second.headers.get("x-ratelimit-remaining"), "0");

    const third = await register("RateLimitedBotThree");
    assert.strictEqual(third.status, 429);
    assert.strictEqual(third.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(Number(third.headers.get("retry-after")) > 0);
    const parsed = (await third.json()) as { error: string; retry_after_seconds: number };
    assert.match(parsed.error, /rate limited/);
    assert.ok(parsed.retry_after_seconds > 0);
  });

  it("does not create the identity it refused", async () => {
    const stored = JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8")) as { agents: Array<{ name: string }> };
    const names = stored.agents.map(a => a.name);
    assert.ok(names.includes("RateLimitedBotOne"));
    assert.ok(!names.includes("RateLimitedBotThree"));
  });

  it("keeps refusing for the rest of the window", async () => {
    const res = await register("RateLimitedBotFour");
    assert.strictEqual(res.status, 429);
  });

  it("publishes the limit it enforces on the developer API page", async () => {
    const html = await (await fetch(`http://localhost:${port}/developers`)).text();
    assert.ok(
      html.includes("allows 2 registrations per hour per client"),
      "the API page should state the limit this server is enforcing",
    );
    assert.ok(html.includes("X-RateLimit-Limit"), "the API page should name the headers the endpoint returns");
  });
});
