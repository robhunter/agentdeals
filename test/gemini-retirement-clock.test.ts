import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();

test("Gemini retirement text follows the UTC day on each request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-clock-"));
  const dayFile = path.join(dir, "day");
  const preload = path.join(dir, "clock.cjs");
  writeFileSync(dayFile, "2026-11-30");
  writeFileSync(preload, `const fs = require('node:fs');
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fs.readFileSync(${JSON.stringify(dayFile)}, 'utf8') + 'T12:00:00Z'])); }
  static now() { return new RealDate(fs.readFileSync(${JSON.stringify(dayFile)}, 'utf8') + 'T12:00:00Z').getTime(); }
};`);
  const server = spawn(process.execPath, ["--require", preload, path.join(root, "dist/serve.js")], {
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 20000);
      server.stderr!.on("data", (data: Buffer) => {
        const found = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (found) { clearTimeout(timer); resolve(found[1]); }
      });
      server.on("error", reject);
      server.on("exit", code => reject(new Error(`Server exited: ${code}`)));
    });
    for (const day of ["2026-11-30", "2026-12-01", "2026-12-02"]) {
      writeFileSync(dayFile, day);
      const pages = await Promise.all(["/gemini-api-pricing-2026", "/google-developer-program-2026", "/free-tier-risk"].map(async route => {
        const response = await fetch(`http://localhost:${port}${route}`);
        assert.equal(response.status, 200);
        return response.text();
      }));
      if (day === "2026-11-30") {
        assert.ok(pages[0].includes("Since 2026-09-18 Google serves the Gemini 2.5 models only to users who used them before."));
        assert.ok(pages[0].includes("Gemini 2.0 Flash shut down on 2026-06-01, and new projects cannot use the 2.5 models."));
        assert.ok(pages[1].includes("Google limits the Gemini 2.5 models to users who have used them before."));
        assert.ok(pages[2].includes("Since 2026-09-18 the 2.5 models are limited to earlier users."));
        assert.ok(!pages[0].includes("On 2026-12-01 Google shut down 2.5 Pro"));
      } else {
        for (const page of pages) {
          assert.ok(page.includes("Google shut down Gemini 2.5 Pro and 2.5 Flash on the Gemini API on 2026-12-01"));
          assert.ok(page.includes("Gemini 2.5 Flash-Lite, a separate model, still runs."));
        }
        assert.ok(pages[0].includes("On 2026-12-01 Google shut down 2.5 Pro and 2.5 Flash on the Gemini API"));
        assert.ok(pages[0].includes("Gemini 2.0 Flash shut down on 2026-06-01 and Gemini 2.5 Pro and 2.5 Flash on 2026-12-01"));
      }
    }
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
