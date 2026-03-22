import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3471;

let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const p = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: String(PORT), BASE_URL: `http://localhost:${PORT}` },
    });
    const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 5000);
    p.stderr!.on("data", (data: Buffer) => {
      if (data.toString().includes("running on http")) { clearTimeout(timeout); resolve(p); }
    });
    p.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("HEAD requests return same status as GET", () => {
  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  const pagePaths = [
    "/",
    "/best",
    "/category",
    "/compare",
    "/vendor",
    "/changes",
    "/expiring",
    "/setup",
    "/privacy",
    "/search",
    "/alternative-to",
    "/trends",
    "/freshness",
    "/agent-stack",
  ];

  for (const pagePath of pagePaths) {
    it(`HEAD ${pagePath} returns 200 with text/html`, async () => {
      proc = await startHttpServer();
      const headRes = await fetch(`http://localhost:${PORT}${pagePath}`, { method: "HEAD" });
      assert.strictEqual(headRes.status, 200, `HEAD ${pagePath} should return 200, got ${headRes.status}`);
      assert.ok(
        headRes.headers.get("content-type")?.includes("text/html"),
        `HEAD ${pagePath} should return text/html, got ${headRes.headers.get("content-type")}`
      );
      // HEAD responses should have no body
      const body = await headRes.text();
      assert.strictEqual(body, "", `HEAD ${pagePath} should have empty body`);
    });
  }

  it("HEAD /api/offers returns 200 with application/json", async () => {
    proc = await startHttpServer();
    const headRes = await fetch(`http://localhost:${PORT}/api/offers`, { method: "HEAD" });
    assert.strictEqual(headRes.status, 200);
    assert.ok(headRes.headers.get("content-type")?.includes("application/json"));
  });

  it("HEAD /robots.txt returns 200", async () => {
    proc = await startHttpServer();
    const headRes = await fetch(`http://localhost:${PORT}/robots.txt`, { method: "HEAD" });
    assert.strictEqual(headRes.status, 200);
  });

  it("HEAD /nonexistent returns 404", async () => {
    proc = await startHttpServer();
    const headRes = await fetch(`http://localhost:${PORT}/nonexistent-page-xyz`, { method: "HEAD" });
    assert.strictEqual(headRes.status, 404);
  });
});
