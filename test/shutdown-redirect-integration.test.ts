import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shutdownPath } from "../dist/shutdown-paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string;
let child: ChildProcess;
let base: string;
let target: string;
const old = "/shutdowns/former-example-2026-01-01";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "shutdown-redirect-"));
  for (const dir of ["dist", "data", "scripts"]) cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
  cpSync(path.join(root, "package.json"), path.join(scratch, "package.json"));
  symlinkSync(path.join(root, "assets"), path.join(scratch, "assets"), "dir");
  symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");
  child = spawn("node", [path.join(scratch, "dist/serve.js")], {
    cwd: scratch, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off" },
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
    let stderr = "";
    child.stderr!.on("data", chunk => {
      stderr += String(chunk);
      const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("error", reject);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code} ${stderr}`)); });
  });
  base = `http://localhost:${port}`;
  const xml = await (await fetch(`${base}/sitemap-pages.xml`)).text();
  target = xml.match(/<loc>http:\/\/localhost(\/shutdowns\/[^<]+)<\/loc>/)![1];
  assert.ok(target);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("maintained shutdown redirects", () => {
  it("refuses to drop a listed path without a redirect, then serves its replacement", async () => {
    const ledgerPath = path.join(scratch, "data/page-lastmod.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.pages[old] = { hash: "0123456789abcdef", changed: "2026-01-01" };
    const original = JSON.stringify(ledger, null, 2) + "\n";
    writeFileSync(ledgerPath, original);
    const failed = spawnSync("node", [path.join(scratch, "scripts/update-page-lastmod.js")], {
      cwd: scratch, encoding: "utf8", timeout: 60000,
      env: { ...process.env, TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off" },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Shutdown page needs a direct redirect/);
    assert.equal(readFileSync(ledgerPath, "utf8"), original);
    writeFileSync(path.join(scratch, "data/shutdown-redirects.json"), JSON.stringify({ [old]: target }));
    const response = await fetch(base + old, { redirect: "manual" });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), target);
    assert.equal((await fetch(base + target)).status, 200);
    const xml = await (await fetch(`${base}/sitemap-pages.xml`)).text();
    assert.ok(!xml.includes(`<loc>http://localhost${old}</loc>`));
    assert.ok(xml.includes(`<loc>http://localhost${target}</loc>`));
    const outcome = path.join(scratch, "outcome.json");
    const completed = spawnSync("node", [path.join(scratch, "scripts/update-page-lastmod.js"), "--json", outcome], {
      cwd: scratch, encoding: "utf8", timeout: 600000,
      env: { ...process.env, TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off" },
    });
    assert.equal(completed.status, 0, `${completed.stdout}${completed.stderr}`);
    assert.ok(JSON.parse(readFileSync(outcome, "utf8")).dropped.includes(old));
    const updated = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.ok(!(old in updated.pages));
    assert.ok(target in updated.pages);
  });

  it("requires a redirect when a recorded shutdown changes its first date", () => {
    const ledgerPath = path.join(scratch, "data/page-lastmod.json");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    const ledger = JSON.parse(ledgerBefore);
    const oldChroma = Object.keys(ledger.pages).find(key => key.startsWith("/shutdowns/chroma-2026-12-07-chroma-cloud-"));
    assert.ok(oldChroma);
    const changesPath = path.join(scratch, "data/deal_changes.json");
    const changes = JSON.parse(readFileSync(changesPath, "utf8"));
    const record = changes.changes.find((item: { what_ends?: string }) => item.what_ends === "Chroma Cloud");
    assert.ok(record);
    record.shutdown_stages[0].date = "2026-12-08";
    writeFileSync(changesPath, JSON.stringify(changes));
    const newChroma = shutdownPath({ vendorSlug: "chroma", service: record.what_ends, identity: record.summary, deadline: record.date, stages: record.shutdown_stages });
    const run = () => spawnSync("node", [path.join(scratch, "scripts/update-page-lastmod.js")], {
      cwd: scratch, encoding: "utf8", timeout: 600000,
      env: { ...process.env, TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off" },
    });
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Shutdown page needs a direct redirect/);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);
    writeFileSync(path.join(scratch, "data/shutdown-redirects.json"), JSON.stringify({ [oldChroma]: newChroma }));
    const accepted = run();
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
    const updated = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.ok(!(oldChroma in updated.pages));
    assert.ok(newChroma in updated.pages);
  });

  it("rejects a map whose target is not a current page", async () => {
    writeFileSync(path.join(scratch, "data/shutdown-redirects.json"), JSON.stringify({ [old]: "/shutdowns/missing" }));
    const inventory = path.join(scratch, "inventory.json");
    const probe = spawn("node", [path.join(scratch, "dist/serve.js")], {
      cwd: scratch, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTDEALS_PAGE_INVENTORY_OUT: inventory, PORT: "0", AGENTDEALS_REFERRAL_HEALTH: "off" },
    });
    let stderr = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${stderr}`)), 30000);
        probe.stderr!.on("data", chunk => {
          stderr += String(chunk);
          if (stderr.includes("running on http://localhost:")) { clearTimeout(timer); resolve(); }
        });
        probe.on("error", reject);
        probe.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code} ${stderr}`)); });
      });
      assert.match(stderr, /Shutdown redirect target is not a page/);
      assert.throws(() => readFileSync(inventory), /ENOENT/);
    } finally {
      if (probe.exitCode === null && probe.signalCode === null) {
        const exited = once(probe, "exit");
        probe.kill();
        await exited;
      }
    }
  });
});
