import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export async function retainedShutdownDetailsPage(root: string): Promise<string> {
  const child = spawn("node", ["--import", path.join(root, "scripts/shifted-clock.mjs"), path.join(root, "dist/serve.js")], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2026-07-29T12:00:00Z") - Date.now()) },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
      child.stderr!.on("data", chunk => {
        const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
    });
    const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
}
