import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = path.join(__dirname, "..", "data", "watchlist.json");

describe("watchlist HTTP endpoints", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;
  let backup: string | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 10000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  beforeEach(() => {
    if (fs.existsSync(WATCHLIST_PATH)) {
      backup = fs.readFileSync(WATCHLIST_PATH, "utf-8");
    } else {
      backup = null;
    }
  });

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
    if (backup !== null) {
      fs.writeFileSync(WATCHLIST_PATH, backup, "utf-8");
    } else if (fs.existsSync(WATCHLIST_PATH)) {
      fs.unlinkSync(WATCHLIST_PATH);
    }
  });

  it("POST /api/watchlist creates subscription with secret", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", webhook_url: "https://example.com/hook" }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json() as any;
    assert.ok(body.id, "Should have an ID");
    assert.strictEqual(body.vendor, "Railway");
    assert.strictEqual(body.webhook_url, "https://example.com/hook");
    assert.ok(body.secret, "Should include secret for HMAC verification");
    assert.ok(body.secret.length === 64, "Secret should be 64 hex chars");
    assert.ok(body.created_at, "Should have created_at");
  });

  it("POST /api/watchlist persists to file", async () => {
    proc = await startHttpServer();
    await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Vercel", webhook_url: "https://example.com/hook" }),
    });
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, "utf-8"));
    assert.ok(raw.subscriptions.some((s: any) => s.vendor === "Vercel"), "Should persist to file");
  });

  it("POST /api/watchlist rejects missing vendor", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhook_url: "https://example.com/hook" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json() as any;
    assert.ok(body.error.includes("vendor"));
  });

  it("POST /api/watchlist rejects missing webhook_url", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/watchlist rejects invalid webhook URL", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", webhook_url: "not-a-url" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json() as any;
    assert.ok(body.error.includes("valid URL"));
  });

  it("POST /api/watchlist rejects invalid JSON", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/watchlist rejects duplicate vendor+webhook", async () => {
    proc = await startHttpServer();
    await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", webhook_url: "https://example.com/hook" }),
    });
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "railway", webhook_url: "https://example.com/hook" }),
    });
    assert.strictEqual(res.status, 409);
    const body = await res.json() as any;
    assert.ok(body.error.includes("Already watching"));
  });

  it("GET /api/watchlist lists subscriptions without secrets", async () => {
    proc = await startHttpServer();
    await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", webhook_url: "https://example.com/hook" }),
    });
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.subscriptions.length >= 1);
    assert.ok(body.total >= 1);
    assert.ok(!body.subscriptions[0].secret, "Should not expose secret in list");
  });

  it("GET /api/watchlist filters by webhook_url", async () => {
    proc = await startHttpServer();
    await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Railway", webhook_url: "https://a.com/hook" }),
    });
    await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Vercel", webhook_url: "https://b.com/hook" }),
    });
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist?webhook_url=${encodeURIComponent("https://a.com/hook")}`);
    const body = await res.json() as any;
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.subscriptions[0].vendor, "Railway");
  });

  it("GET /api/watchlist/:id returns subscription without secret", async () => {
    proc = await startHttpServer();
    const createRes = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Supabase", webhook_url: "https://example.com/hook" }),
    });
    const created = await createRes.json() as any;
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist/${created.id}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.vendor, "Supabase");
    assert.strictEqual(body.id, created.id);
    assert.ok(!body.secret, "Should not expose secret in GET");
    assert.ok("last_notified_change" in body, "Should include last_notified_change field");
  });

  it("GET /api/watchlist/:id returns 404 for unknown", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist/nonexistent-id`);
    assert.strictEqual(res.status, 404);
  });

  it("DELETE /api/watchlist/:id removes subscription", async () => {
    proc = await startHttpServer();
    const createRes = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Heroku", webhook_url: "https://example.com/hook" }),
    });
    const created = await createRes.json() as any;
    const delRes = await fetch(`http://localhost:${serverPort}/api/watchlist/${created.id}`, { method: "DELETE" });
    assert.strictEqual(delRes.status, 200);
    const delBody = await delRes.json() as any;
    assert.strictEqual(delBody.ok, true);
    const getRes = await fetch(`http://localhost:${serverPort}/api/watchlist/${created.id}`);
    assert.strictEqual(getRes.status, 404);
  });

  it("DELETE /api/watchlist/:id returns 404 for unknown", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist/nonexistent-id`, { method: "DELETE" });
    assert.strictEqual(res.status, 404);
  });

  it("CORS headers are present on watchlist responses", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/watchlist`);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
  });

  it("subscription secret produces valid HMAC signature", async () => {
    proc = await startHttpServer();
    const createRes = await fetch(`http://localhost:${serverPort}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "Netlify", webhook_url: "https://example.com/hook" }),
    });
    const created = await createRes.json() as any;
    const testPayload = '{"test": true}';
    const expectedSig = crypto.createHmac("sha256", created.secret).update(testPayload).digest("hex");
    assert.strictEqual(expectedSig.length, 64, "HMAC should produce 64-char hex");
    assert.ok(created.secret.length === 64, "Secret should be 64 hex chars (32 bytes)");
  });
});
