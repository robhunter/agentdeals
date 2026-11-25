import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldPath = "/shutdowns/google-antigravity-2026-11-18-claude-4-6-models-and-gpt-oss-120b-on-antigravity-s-free-and-google-ai-plus-plans";
const target = "/shutdowns/google-antigravity-2026-11-30-claude-4-6-models-and-gpt-oss-120b-on-antigravity-s-free-and-google-ai-plus-plans";

test("redirects follow the server's change inventory", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "shutdown-inventory-"));
  for (const dir of ["dist", "data"]) cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
  cpSync(path.join(root, "package.json"), path.join(scratch, "package.json"));
  for (const dir of ["assets", "node_modules"]) symlinkSync(path.join(root, dir), path.join(scratch, dir), "dir");
  writeFileSync(path.join(scratch, "data/shutdown-redirects.json"), JSON.stringify({ [oldPath]: target }));
  const fixture = path.join(scratch, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ changes: [] }));
  try {
    for (const changesPath of [fixture, undefined]) {
      const env = { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off" };
      delete env.AGENTDEALS_CHANGES_PATH;
      if (changesPath) env.AGENTDEALS_CHANGES_PATH = changesPath;
      const child = spawn("node", [path.join(scratch, "dist/serve.js")], { cwd: scratch, stdio: ["ignore", "ignore", "pipe"], env });
      try {
        const port = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
          let stderr = "";
          child.stderr!.on("data", chunk => {
            stderr += String(chunk);
            const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
          });
          child.on("error", reject);
          child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code} ${stderr}`)); });
        });
        const base = `http://localhost:${port}`;
        assert.equal((await fetch(`${base}/sitemap.xml`)).status, 200);
        assert.equal((await fetch(`${base}/sitemap-pages.xml`)).status, 200);
        const response = await fetch(base + oldPath, { redirect: "manual" });
        assert.equal(response.status, changesPath ? 404 : 301);
        if (!changesPath) {
          assert.equal(response.headers.get("location"), target);
          assert.equal((await fetch(base + target)).status, 200);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
