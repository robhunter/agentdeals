import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverPort = 0;
let serverProc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 10000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("vendor marketplace solicitation CTA (#858)", () => {
  before(async () => { serverProc = await startServer(); });
  after(() => { serverProc?.kill(); });

  it("vendor with neither program nor code shows the solicitation block", async () => {
    // Deno Deploy: no referral_program, no referral, no platform code.
    const res = await fetch(`http://localhost:${serverPort}/vendor/deno-deploy`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("marketplace-solicitation"), "Solicitation section CSS hook missing");
    assert.ok(html.includes("Know a referral or partner program for Deno Deploy?"), "Solicitation heading missing");
    assert.ok(html.includes('href="/marketplace"'), "Should link to /marketplace");
    assert.ok(html.includes("60% commission"), "Should mention commission split");
    assert.ok(html.includes("x402"), "Should mention payout rail");
    // Should NOT show the active program callout for this vendor
    assert.ok(!html.includes(">Referral Program</h2>"), "Should not show 'Referral Program' h2 (no program available)");
  });

  it("vendor with platform code (Railway) does NOT show the solicitation block", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/railway`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("marketplace-solicitation"), "Solicitation should be suppressed when a platform code exists");
    assert.ok(!html.includes("Know a referral or partner program for Railway?"), "Solicitation heading should not appear for Railway");
    // Existing platform CTA still rendered
    assert.ok(html.includes("Sign up via our referral link"), "Existing platform CTA should still render");
  });

  it("vendor with referral_program.available=true (Vercel) does NOT show the solicitation block", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("marketplace-solicitation"), "Solicitation should be suppressed when program is available");
    assert.ok(!html.includes("Know a referral or partner program for Vercel?"), "Solicitation heading should not appear for Vercel");
    // Existing program callout still renders
    assert.ok(html.includes(">Referral Program</h2>"), "Existing 'Referral Program' h2 should still render");
  });

  it("solicitation block uses muted/secondary styling (dashed border, h3 not h2)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/deno-deploy`);
    const html = await res.text();
    // Visually distinguishable from active program promo (which uses h2 + solid border)
    const idx = html.indexOf("marketplace-solicitation");
    assert.ok(idx > 0, "Section must exist");
    const slice = html.slice(idx, idx + 800);
    assert.ok(slice.includes("border:1px dashed"), "Should use a dashed border to look passive");
    assert.ok(slice.includes("<h3"), "Should use h3 (less prominent than h2)");
  });

  it("solicitation block links to disclosure page", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/deno-deploy`);
    const html = await res.text();
    const idx = html.indexOf("marketplace-solicitation");
    const slice = html.slice(idx, idx + 800);
    assert.ok(slice.includes('href="/disclosure"'), "Should link to disclosure");
  });
});
