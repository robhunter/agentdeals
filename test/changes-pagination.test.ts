import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { getDealChanges, loadDealChanges } from "../dist/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BUDGET_BYTES = 40000;

const SHAPE_KEYS = [
  "changes",
  "total",
  "returned",
  "limit",
  "offset",
  "advisory",
  "summary",
  "date_provenance",
  "all_time_total",
  "change_log_freshness",
  "_provenance",
];

const QUERIES = [
  "",
  "?limit=2",
  "?limit=2&offset=2",
  "?limit=1000",
  "?since=2026-01-01",
  "?type=free_tier_removed",
  "?vendor=Slack",
  "?vendors=Slack",
  "?vendors=Slack,Exa",
  "?category=Databases",
  "?categories=Databases",
  "?vendors=a-vendor-we-do-not-hold",
];

describe("/api/changes answers one shape and pages", () => {
  let proc: ChildProcess;
  let base: string;

  const get = async (query: string): Promise<{ status: number; body: string; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/changes${query}`);
    const body = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(body); } catch { json = {}; }
    return { status: res.status, body, json };
  };

  before(async () => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("covers a filter of every kind the route accepts", () => {
    assert.strictEqual(QUERIES.length, 12);
  });

  for (const query of QUERIES) {
    it(`answers /api/changes${query || " with no parameters"} with the same top-level keys`, async () => {
      const { status, json } = await get(query);
      assert.strictEqual(status, 200, `/api/changes${query} answers ${status}`);
      assert.deepStrictEqual(Object.keys(json).sort(), [...SHAPE_KEYS].sort(), `/api/changes${query} answers a different shape`);
      assert.ok(Array.isArray(json.changes), `/api/changes${query} carries no changes array`);
      assert.strictEqual(typeof json.total, "number", `/api/changes${query} carries no total`);
    });
  }

  it("returns the number of records asked for", async () => {
    for (const limit of [1, 2, 5]) {
      const { json } = await get(`?limit=${limit}`);
      assert.strictEqual((json.changes as unknown[]).length, limit, `limit=${limit} returned a different count`);
      assert.strictEqual(json.returned, limit);
      assert.strictEqual(json.limit, limit);
    }
  });

  it("reports the unlimited count so a caller can page", async () => {
    const full = await get("?limit=1000");
    const paged = await get("?limit=2");
    assert.strictEqual(paged.json.total, full.json.total, "total moved with the page size");
    assert.strictEqual(paged.json.total, (full.json.changes as unknown[]).length);
    assert.ok((full.json.changes as unknown[]).length > 2, "the window holds too few records to test paging");
  });

  it("pages through the window without repeating or skipping a record", async () => {
    const full = await get("?limit=1000");
    const all = (full.json.changes as { vendor: string; date: string; change_type: string }[])
      .map((c) => `${c.vendor}|${c.date}|${c.change_type}`);
    const walked: string[] = [];
    for (let offset = 0; offset < 10; offset += 5) {
      const { json } = await get(`?limit=5&offset=${offset}`);
      assert.strictEqual(json.offset, offset);
      for (const c of json.changes as { vendor: string; date: string; change_type: string }[]) {
        walked.push(`${c.vendor}|${c.date}|${c.change_type}`);
      }
    }
    assert.deepStrictEqual(walked, all.slice(0, 10));
  });

  it("keeps the default response inside a stated budget", async () => {
    const { body, json } = await get("");
    assert.ok(
      body.length <= DEFAULT_BUDGET_BYTES,
      `the default response is ${body.length} bytes against a budget of ${DEFAULT_BUDGET_BYTES}`,
    );
    assert.strictEqual(json.limit, 20, "the default page size moved");
  });

  it("serves the page size /developers states, and states one at all", async () => {
    const page = await (await fetch(`${base}/developers`)).text();
    const stated = page.match(/<code>\/api\/changes<\/code> returns <strong>(\d+) records by default<\/strong>/);
    assert.ok(stated, "/developers states no default page size for /api/changes");
    const published = parseInt(stated[1], 10);
    const { json } = await get("");
    assert.strictEqual(json.limit, published, `/developers states ${published} and the route serves ${json.limit}`);
    assert.strictEqual(json.returned, published);
    assert.strictEqual((json.changes as unknown[]).length, published);
  });

  it("reaches the whole window by asking rather than by omitting a parameter", async () => {
    const windowSize = getDealChanges().changes.length;
    const { json } = await get("?limit=1000");
    assert.strictEqual((json.changes as unknown[]).length, windowSize);
    assert.strictEqual(json.total, windowSize);
  });

  it("answers the singular and plural spelling of a filter identically", async () => {
    const singularVendor = await get("?vendor=Slack");
    const pluralVendor = await get("?vendors=Slack");
    assert.deepStrictEqual(singularVendor.json.changes, pluralVendor.json.changes, "vendor and vendors disagree");

    const singularCategory = await get("?category=Databases");
    const pluralCategory = await get("?categories=Databases");
    assert.deepStrictEqual(singularCategory.json.changes, pluralCategory.json.changes, "category and categories disagree");
  });

  it("names the period every answer covers", async () => {
    for (const query of QUERIES) {
      const { json } = await get(query);
      const summary = json.summary as { period_days?: unknown };
      assert.strictEqual(typeof summary?.period_days, "number", `/api/changes${query} does not name its period`);
    }
  });

  it("refuses a page size it cannot read rather than ignoring it", async () => {
    for (const query of ["?limit=abc", "?offset=-1", "?limit=1.5"]) {
      const { status, json } = await get(query);
      assert.strictEqual(status, 400, `/api/changes${query} answers ${status}`);
      assert.ok(typeof json.error === "string", `/api/changes${query} refuses without saying why`);
    }
  });

  it("changes the response for every parameter /developers publishes for this route", async () => {
    const page = await (await fetch(`${base}/developers`)).text();
    const row = page.match(/<a href="[^"]*\/api\/changes">\/api\/changes<\/a><\/td><td>[^<]*<\/td><td><code>([^<]*)<\/code>/);
    assert.ok(row, "/developers publishes no parameter list for /api/changes");
    const published = row[1].split(",").map((p) => p.trim()).filter(Boolean);
    assert.ok(published.length > 0, "/developers publishes an empty parameter list for /api/changes");

    const probe: Record<string, string> = {
      since: "2026-08-25",
      type: "free_tier_removed",
      vendor: "Slack",
      vendors: "Slack",
      category: "Databases",
      categories: "Databases",
      limit: "2",
      offset: "3",
    };
    const baseline = (await get("")).body;
    const inert: string[] = [];
    for (const name of published) {
      assert.ok(probe[name] !== undefined, `/developers publishes ${name} and the test has no value to probe it with`);
      const { body } = await get(`?${name}=${encodeURIComponent(probe[name])}`);
      if (body === baseline) inert.push(name);
    }
    assert.deepStrictEqual(inert, [], "/developers publishes parameters that do not change the response");
  });

  it("keeps the stdio proxy's pinned page size above the whole window", async () => {
    const { TRACK_CHANGES_LIMIT } = await import("../dist/server-remote.js");
    assert.ok(
      TRACK_CHANGES_LIMIT >= loadDealChanges().length,
      `the proxy pins ${TRACK_CHANGES_LIMIT} against ${loadDealChanges().length} stored changes, so it would truncate`,
    );
  });
});

describe("the stdio proxy asks for what it means to return", () => {
  let api: ChildProcess;
  let stdio: ChildProcess;
  let nextId = 10;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();

  const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out on ${method}`)), 30000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      stdio.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  const trackChanges = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const msg = await rpc("tools/call", { name: "track_changes", arguments: args }) as {
      result?: { content?: { text?: string }[] };
    };
    return JSON.parse(msg.result?.content?.[0]?.text ?? "{}");
  };

  before(async () => {
    const repo = path.join(__dirname, "..");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(repo, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    api = started.proc;

    stdio = spawn("node", [path.join(repo, "dist", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENTDEALS_API_URL: `http://127.0.0.1:${started.port}` },
    });
    let buffered = "";
    stdio.stdout?.on("data", (b: Buffer) => {
      buffered += b.toString();
      let cut: number;
      while ((cut = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)!(msg as Record<string, unknown>);
            pending.delete(msg.id);
          }
        } catch { /* a partial frame is not a message */ }
      }
    });
    await once(stdio.stderr!, "data");
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    stdio.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  after(() => { stdio?.kill("SIGKILL"); api?.kill("SIGKILL"); });

  it("returns the whole window rather than the route's default page", async () => {
    const result = await trackChanges({ since: "2026-01-01", include_expiring: false });
    const changes = result.changes as unknown[];
    assert.ok(Array.isArray(changes), "track_changes returned no changes array");
    assert.strictEqual(changes.length, result.total, "the proxy returned a page and reported a window");
    assert.ok(changes.length > 20, `the proxy returned ${changes.length}, the route's default page size`);
  });

  it("forwards a category filter instead of dropping it", async () => {
    const filtered = await trackChanges({ since: "2026-01-01", categories: "Databases", include_expiring: false });
    const unfiltered = await trackChanges({ since: "2026-01-01", include_expiring: false });
    assert.ok(
      (filtered.total as number) < (unfiltered.total as number),
      `filtering by category returned ${filtered.total} of ${unfiltered.total}, so the filter was dropped`,
    );
    for (const change of filtered.changes as { category?: string }[]) {
      assert.ok(
        (change.category ?? "").toLowerCase().includes("database"),
        `a category filter returned ${change.category}`,
      );
    }
  });
});
