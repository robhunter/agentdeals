import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function status(routePath: string): Promise<number> {
  const res = await fetch(`http://localhost:${serverPort}${routePath}`);
  await res.arrayBuffer();
  return res.status;
}

async function stillServing(): Promise<boolean> {
  try {
    return await status("/health") === 200;
  } catch {
    return false;
  }
}

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1574 a request for a docs asset cannot take the server down", () => {
  it("serves a real asset, so the route is reaching the directory the rest of this file is about", async () => {
    assert.strictEqual(await status("/api/docs/swagger-ui.css"), 200);
  });

  it("answers 404 for the directory itself rather than reading it", async () => {
    assert.strictEqual(await status("/api/docs/"), 404);
    assert.ok(await stillServing(), "the server stopped answering after a request for /api/docs/");
  });

  it("answers 404 for an asset that is not there", async () => {
    assert.strictEqual(await status("/api/docs/no-such-file.js"), 404);
    assert.ok(await stillServing(), "the server stopped answering after a request for a missing asset");
  });

  it("keeps refusing a path that climbs out of the directory", async () => {
    assert.strictEqual(await status("/api/docs/..%2Fpackage.json"), 400);
    assert.strictEqual(await status("/api/docs/nested/thing.js"), 400);
    assert.ok(await stillServing(), "the server stopped answering after a refused path");
  });

  it("is still serving every earlier assertion's traffic at the end", async () => {
    assert.ok(await stillServing());
    assert.strictEqual(await status("/api/docs/swagger-ui.css"), 200);
  });
});
