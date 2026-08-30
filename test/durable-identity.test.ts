import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");

const managedPaths: [string, string][] = [
  [AGENTS_PATH, JSON.stringify({ agents: [] })],
  [REQUESTS_PATH, JSON.stringify({ referral_requests: [] })],
];
const managedOriginals = new Map<string, string | null>();

function holdManagedFiles(): void {
  for (const [p] of managedPaths) {
    managedOriginals.set(p, fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null);
  }
  for (const [p, empty] of managedPaths) fs.writeFileSync(p, empty, "utf-8");
}

function releaseManagedFiles(): void {
  for (const [p] of managedPaths) {
    const held = managedOriginals.get(p) ?? null;
    if (held !== null) fs.writeFileSync(p, held, "utf-8");
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

holdManagedFiles();
process.on("exit", releaseManagedFiles);

const {
  createDurableStore,
  configureDurableBackend,
  hydrateDurableStores,
  persistDurableStores,
  identityStorageReport,
  DURABLE_KEY_PREFIX,
} = await import("../dist/durable-store.js");
const { registerAgent, getAgentByApiKeyHash, hashApiKey, agentRegistryReadable, resetAgentsCache } =
  await import("../dist/agents.js");
const { attributeByApiKey, attributeAuthenticatedRequest, hasAuthCredential, ATTRIBUTION_NOTES } =
  await import("../dist/referral-attribution.js");
const { payoutsAvailable, setTransferFn, resetTransferFn, PAYOUTS_UNAVAILABLE_REASON } =
  await import("../dist/x402.js");

interface StoredRow {
  id: string;
  value: string;
}

function memoryBackend(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const calls: { op: string; key: string }[] = [];
  let failReads = false;
  let failWrites = false;
  return {
    store,
    calls,
    failReads: (on: boolean) => { failReads = on; },
    failWrites: (on: boolean) => { failWrites = on; },
    writeCount: () => calls.filter(c => c.op === "set").length,
    backend: {
      async get(key: string) {
        calls.push({ op: "get", key });
        if (failReads) return { ok: false, value: null, error: "read refused" };
        return { ok: true, value: store.has(key) ? store.get(key) : null };
      },
      async set(key: string, value: unknown) {
        calls.push({ op: "set", key });
        if (failWrites) return { ok: false, error: "write refused" };
        store.set(key, value);
        return { ok: true };
      },
    },
  };
}

describe("A store backed by durable storage keeps its records across a process restart", () => {
  const tmpFile = path.join(os.tmpdir(), `durable-store-${process.pid}.json`);

  after(() => {
    configureDurableBackend(null);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  beforeEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("writes to the backend and reads the same records back on a fresh hydrate", async () => {
    const harness = memoryBackend();
    const store = createDurableStore<StoredRow>({ name: "rows_roundtrip", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    await store.hydrate();
    store.save([{ id: "a", value: "first" }]);
    assert.deepStrictEqual(await store.flush(), { ok: true });

    store.reset();
    await store.hydrate();
    assert.deepStrictEqual(store.read(), [{ id: "a", value: "first" }]);
    assert.strictEqual(fs.existsSync(tmpFile), false);
  });

  it("collapses several saves into a single backend write", async () => {
    const harness = memoryBackend();
    const store = createDurableStore<StoredRow>({ name: "rows_collapse", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    await store.hydrate();
    store.save([{ id: "a", value: "1" }]);
    store.save([{ id: "a", value: "2" }]);
    store.save([{ id: "a", value: "3" }]);
    await store.flush();

    assert.strictEqual(harness.writeCount(), 1);
    assert.deepStrictEqual(store.read(), [{ id: "a", value: "3" }]);
  });

  it("costs no backend write when nothing changed", async () => {
    const harness = memoryBackend();
    const store = createDurableStore<StoredRow>({ name: "rows_idle", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    await store.hydrate();
    await store.flush();
    await store.flush();

    assert.strictEqual(harness.writeCount(), 0);
  });

  it("seeds an absent key from the committed file and persists the seed on the first flush", async () => {
    const harness = memoryBackend();
    fs.writeFileSync(tmpFile, JSON.stringify({ rows: [{ id: "seed", value: "committed" }] }), "utf-8");
    const store = createDurableStore<StoredRow>({ name: "rows_seed", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    await store.hydrate();
    assert.deepStrictEqual(store.read(), [{ id: "seed", value: "committed" }]);
    assert.strictEqual(store.status().seeded_from_file, true);

    await store.flush();
    assert.deepStrictEqual(harness.store.get(`${DURABLE_KEY_PREFIX}rows_seed`), {
      rows: [{ id: "seed", value: "committed" }],
    });
  });

  it("refuses to write when the backend could not be read, so a failed read cannot erase what is stored", async () => {
    const harness = memoryBackend({
      [`${DURABLE_KEY_PREFIX}rows_unread`]: { rows: [{ id: "kept", value: "stored" }] },
    });
    const store = createDurableStore<StoredRow>({ name: "rows_unread", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    harness.failReads(true);
    await store.hydrate();
    assert.strictEqual(store.status().hydrated, false);
    assert.strictEqual(store.status().last_read_error, "read refused");

    store.save([{ id: "overwrite", value: "would clobber" }]);
    const outcome = await store.flush();
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(harness.writeCount(), 0);
    assert.deepStrictEqual(harness.store.get(`${DURABLE_KEY_PREFIX}rows_unread`), {
      rows: [{ id: "kept", value: "stored" }],
    });
  });

  it("refuses a write whose store it had to read first, rather than reporting a change it dropped", async () => {
    const harness = memoryBackend({
      [`${DURABLE_KEY_PREFIX}rows_recovered`]: { rows: [{ id: "stored", value: "already there" }] },
    });
    const store = createDurableStore<StoredRow>({ name: "rows_recovered", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    harness.failReads(true);
    await store.hydrate();
    assert.strictEqual(store.status().hydrated, false);

    harness.failReads(false);
    store.save([{ id: "stored", value: "already there" }, { id: "new", value: "added while blind" }]);
    const refused = await store.flush();
    assert.strictEqual(refused.ok, false, "a change made against records we had not read must not be reported as saved");
    assert.deepStrictEqual(store.read(), [{ id: "stored", value: "already there" }]);
    assert.strictEqual(harness.writeCount(), 0);

    store.save([{ id: "stored", value: "already there" }, { id: "new", value: "added after reading" }]);
    assert.deepStrictEqual(await store.flush(), { ok: true }, "the retry lands once the store has been read");
    assert.deepStrictEqual(harness.store.get(`${DURABLE_KEY_PREFIX}rows_recovered`), {
      rows: [{ id: "stored", value: "already there" }, { id: "new", value: "added after reading" }],
    });
  });

  it("reports a failed write and rolls the in-memory records back to what is stored", async () => {
    const harness = memoryBackend();
    const store = createDurableStore<StoredRow>({ name: "rows_writefail", property: "rows", filePath: () => tmpFile });
    configureDurableBackend(harness.backend);

    await store.hydrate();
    store.save([{ id: "a", value: "durable" }]);
    await store.flush();

    harness.failWrites(true);
    store.save([{ id: "a", value: "durable" }, { id: "b", value: "lost" }]);
    const outcome = await store.flush();

    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.error, "write refused");
    assert.deepStrictEqual(store.read(), [{ id: "a", value: "durable" }]);
    assert.strictEqual(store.status().last_write_error, "write refused");
  });

  it("falls back to the file when no backend is configured, and says so", async () => {
    configureDurableBackend(null);
    const store = createDurableStore<StoredRow>({ name: "rows_filemode", property: "rows", filePath: () => tmpFile });

    store.save([{ id: "a", value: "on disk" }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(tmpFile, "utf-8")), { rows: [{ id: "a", value: "on disk" }] });

    const status = store.status();
    assert.strictEqual(status.mode, "file");
    assert.deepStrictEqual(await store.flush(), { ok: true });
  });
});

describe("The identity storage report distinguishes durable from ephemeral", () => {
  after(() => configureDurableBackend(null));

  it("reports the container filesystem, and no survival across a deploy, when no backend is configured", async () => {
    configureDurableBackend(null);
    await hydrateDurableStores();
    const report = identityStorageReport();
    assert.strictEqual(report.durable, false);
    assert.strictEqual(report.backend, "container_filesystem");
    assert.strictEqual(report.survives_deploy, false);
  });

  it("reports durable storage once every store has been read from the backend", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    await hydrateDurableStores();
    const report = identityStorageReport();
    assert.strictEqual(report.durable, true);
    assert.strictEqual(report.backend, "redis");
    assert.strictEqual(report.survives_deploy, true);
    assert.ok(report.stores.length >= 7);
    assert.ok(report.stores.every((s: { hydrated: boolean }) => s.hydrated));
  });

  it("stops reporting durable storage when a store could not be read", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    harness.failReads(true);
    await hydrateDurableStores();
    const report = identityStorageReport();
    assert.strictEqual(report.durable, false);
    assert.strictEqual(report.backend, "redis");
    assert.strictEqual(report.survives_deploy, false);
  });
});

describe("An unrecognised API key is reported as unrecognised, not silently unattributed", () => {
  const referral = { vendor: "Railway", referral: { code: "ABC", url: "https://railway.com/?referralCode=ABC" } };

  after(() => {
    configureDurableBackend(null);
    resetAgentsCache();
  });

  it("names the missing key when no key was supplied", async () => {
    configureDurableBackend(null);
    const outcome = await attributeByApiKey(undefined, referral);
    assert.strictEqual(outcome.status, "no_key");
    assert.strictEqual(outcome.note, ATTRIBUTION_NOTES.no_key);
  });

  it("names the unrecognised key when the registry is readable and the key is absent", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    await hydrateDurableStores();

    const outcome = await attributeByApiKey("agd_not_a_real_key", referral);
    assert.strictEqual(outcome.status, "key_not_recognised");
    assert.notStrictEqual(outcome.note, ATTRIBUTION_NOTES.no_key);
  });

  it("distinguishes a registry it could not read from a key that does not exist", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    harness.failReads(true);
    await hydrateDurableStores();

    assert.strictEqual(agentRegistryReadable(), false);
    const outcome = await attributeByApiKey("agd_not_a_real_key", referral);
    assert.strictEqual(outcome.status, "registry_unavailable");
  });

  it("reports that a recognised key was not recorded when the attribution write fails", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    await hydrateDurableStores();

    const registered = registerAgent({ name: `AttributionProbe-${process.pid}` });
    assert.ok(registered.api_key);
    assert.deepStrictEqual(await persistDurableStores(), { ok: true });

    harness.failWrites(true);
    const outcome = await attributeByApiKey(registered.api_key!, referral);
    assert.strictEqual(outcome.status, "not_recorded");
  });

  it("records the attribution when the key resolves and the write lands", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    await hydrateDurableStores();

    const registered = registerAgent({ name: `AttributionProbe2-${process.pid}` });
    await persistDurableStores();

    const outcome = await attributeByApiKey(registered.api_key!, referral);
    assert.strictEqual(outcome.status, "attributed");
    const stored = harness.store.get(`${DURABLE_KEY_PREFIX}referral_requests`) as { referral_requests: unknown[] };
    assert.strictEqual(stored.referral_requests.length, 1);
  });

  it("treats a request carrying no credential differently from one carrying a bad credential", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    await hydrateDurableStores();

    const bare = await attributeAuthenticatedRequest(null, {}, referral);
    assert.strictEqual(bare.status, "no_key");

    const withKey = await attributeAuthenticatedRequest(null, { authorization: "Bearer agd_nope" }, referral);
    assert.strictEqual(withKey.status, "key_not_recognised");

    assert.strictEqual(hasAuthCredential({ authorization: "Bearer " }), false);
    assert.strictEqual(hasAuthCredential({ signature: "s", "signature-input": "i" }), true);
  });
});

describe("An API key issued before a restart still authenticates after it", () => {
  after(() => {
    configureDurableBackend(null);
    resetAgentsCache();
  });

  it("resolves a key that was issued by a previous process", async () => {
    const harness = memoryBackend();
    configureDurableBackend(harness.backend);
    await hydrateDurableStores();

    const registered = registerAgent({ name: `RestartProbe-${process.pid}` });
    const issuedKey = registered.api_key!;
    assert.deepStrictEqual(await persistDurableStores(), { ok: true });

    configureDurableBackend(harness.backend);
    await hydrateDurableStores();

    const resolved = getAgentByApiKeyHash(hashApiKey(issuedKey));
    assert.ok(resolved, "a key issued before the restart must still resolve");
    assert.strictEqual(resolved!.id, registered.agent.id);

    const onDisk = JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8")) as { agents: unknown[] };
    assert.strictEqual(onDisk.agents.length, 0, "the registration must not have gone to the image's file");
  });
});

describe("Payouts are described as unavailable while no transfer provider is installed", () => {
  after(() => resetTransferFn());

  it("reports no payout capability with the default implementation", () => {
    resetTransferFn();
    assert.strictEqual(payoutsAvailable(), false);
  });

  it("reports payout capability once a transfer implementation is installed", () => {
    setTransferFn(async (req: { correlation_id: string }) => ({ success: true, correlation_id: req.correlation_id }));
    assert.strictEqual(payoutsAvailable(), true);
    resetTransferFn();
  });

  it("states the reason rather than a balance threshold", () => {
    assert.match(PAYOUTS_UNAVAILABLE_REASON, /not enabled/i);
    assert.doesNotMatch(PAYOUTS_UNAVAILABLE_REASON, /available for withdrawal/i);
  });
});

function upstashDouble(): Promise<{ server: Server; url: string; keys: Map<string, string> }> {
  const keys = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let cmd: (string | number)[];
      try { cmd = JSON.parse(body); } catch { cmd = []; }
      const op = String(cmd[0] ?? "").toUpperCase();
      const key = String(cmd[1] ?? "");
      let result: unknown = null;
      if (op === "SET") { keys.set(key, String(cmd[2])); result = "OK"; }
      else if (op === "GET") { result = keys.has(key) ? keys.get(key) : null; }
      else if (op === "MGET") { result = cmd.slice(1).map((k) => keys.get(String(k)) ?? null); }
      else if (op === "INCR") { const n = Number(keys.get(key) ?? "0") + 1; keys.set(key, String(n)); result = n; }
      else if (op === "INCRBY") { const n = Number(keys.get(key) ?? "0") + Number(cmd[2]); keys.set(key, String(n)); result = n; }
      else if (op === "LPUSH") { const list = lists.get(key) ?? []; for (const v of cmd.slice(2)) list.unshift(String(v)); lists.set(key, list); result = list.length; }
      else if (op === "LRANGE") { result = (lists.get(key) ?? []).slice(Number(cmd[2]), Number(cmd[3]) + 1); }
      else if (op === "LTRIM") { lists.set(key, (lists.get(key) ?? []).slice(Number(cmd[2]), Number(cmd[3]) + 1)); result = "OK"; }
      else if (op === "DEL") { keys.delete(key); lists.delete(key); result = 1; }
      else if (op === "EXPIRE") { result = 1; }
      else if (op === "SCAN") { result = ["0", [...keys.keys()]]; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as import("net").AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, keys });
    });
  });
}

function startAgentDeals(extraEnv: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...extraEnv },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, port: parseInt(match[1], 10) }); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("A registration issued by one server process survives into the next one", () => {
  let redis: { server: Server; url: string; keys: Map<string, string> };
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;

  before(async () => {
    redis = await upstashDouble();
  });

  after(() => {
    first?.kill();
    second?.kill();
    redis?.server.close();
    resetAgentsCache();
  });

  it("authenticates the key against a second process that shares only the durable store", async () => {
    const env = {
      UPSTASH_REDIS_REST_URL: redis.url,
      UPSTASH_REDIS_REST_TOKEN: "double",
      AGENTDEALS_ROLLUP_DIR: path.join(os.tmpdir(), `rollups-${process.pid}`),
    };

    const started = await startAgentDeals(env);
    first = started.proc;

    const registered = await fetch(`http://localhost:${started.port}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `DeployProbe-${process.pid}` }),
    });
    assert.strictEqual(registered.status, 201);
    const issued = (await registered.json()) as { api_key: string; id: string };
    assert.ok(issued.api_key);

    const statsBefore = await (await fetch(`http://localhost:${started.port}/api/stats`)).json() as {
      identity_storage: { durable: boolean; backend: string; survives_deploy: boolean };
    };
    assert.strictEqual(statsBefore.identity_storage.durable, true);
    assert.strictEqual(statsBefore.identity_storage.backend, "redis");

    assert.strictEqual(
      JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8")).agents.length,
      0,
      "the registration must not have been written to the image's file",
    );

    first.kill();
    first = undefined;
    await new Promise((r) => setTimeout(r, 300));

    const restarted = await startAgentDeals(env);
    second = restarted.proc;

    const me = await fetch(`http://localhost:${restarted.port}/api/agents/me`, {
      headers: { Authorization: `Bearer ${issued.api_key}` },
    });
    assert.strictEqual(me.status, 200, "a key issued before the restart must still authenticate");
    const body = (await me.json()) as { id: string };
    assert.strictEqual(body.id, issued.id);
  });

  it("refuses a registration rather than issuing a key it cannot store", async () => {
    const started = await startAgentDeals({
      UPSTASH_REDIS_REST_URL: "https://unreachable.upstash.invalid",
      UPSTASH_REDIS_REST_TOKEN: "unreachable",
      AGENTDEALS_ROLLUP_DIR: path.join(os.tmpdir(), `rollups-down-${process.pid}`),
    });
    try {
      const res = await fetch(`http://localhost:${started.port}/api/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `UnreachableProbe-${process.pid}` }),
      });
      assert.strictEqual(res.status, 503);
      const body = (await res.json()) as { error: string; api_key?: string };
      assert.strictEqual(body.api_key, undefined, "no key may be issued when it cannot be stored");
      assert.match(body.error, /not saved|discarded/i);

      const stats = await (await fetch(`http://localhost:${started.port}/api/stats`)).json() as {
        identity_storage: { durable: boolean; stores: { name: string; hydrated: boolean }[] };
      };
      assert.strictEqual(stats.identity_storage.durable, false);
      assert.ok(stats.identity_storage.stores.some(s => s.name === "agents" && !s.hydrated));

      assert.strictEqual(
        JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8")).agents.length,
        0,
        "a refused registration must not fall back to the ephemeral file",
      );

      const retry = await fetch(`http://localhost:${started.port}/api/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `UnreachableProbe-${process.pid}` }),
      });
      assert.strictEqual(retry.status, 503, "a refused registration must not leave the name taken");
    } finally {
      started.proc.kill();
    }
  });

  it("reports ephemeral identity storage when the process has no durable backend", async () => {
    const started = await startAgentDeals({
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      AGENTDEALS_ROLLUP_DIR: path.join(os.tmpdir(), `rollups-nb-${process.pid}`),
    });
    try {
      const stats = await (await fetch(`http://localhost:${started.port}/api/stats`)).json() as {
        identity_storage: { durable: boolean; backend: string; survives_deploy: boolean };
      };
      assert.strictEqual(stats.identity_storage.durable, false);
      assert.strictEqual(stats.identity_storage.backend, "container_filesystem");
      assert.strictEqual(stats.identity_storage.survives_deploy, false);
    } finally {
      started.proc.kill();
    }
  });
});
