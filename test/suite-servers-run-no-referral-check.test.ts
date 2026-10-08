import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWITCH = "AGENTDEALS_REFERRAL_HEALTH";

let referralTarget: Server;
let targetBase = "";
const referralHits: string[] = [];
let fixtureDir = "";
let indexPath = "";
let checkedWithinMs = 0;

function startServer(env: NodeJS.ProcessEnv): Promise<{ base: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], { stdio: ["ignore", "ignore", "pipe"], env });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the server did not start within 60 seconds")); }, 60000);
    let printed = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
      const port = printed.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (!port) return;
      clearTimeout(timer);
      child.stderr!.removeAllListeners("data");
      child.stderr!.resume();
      resolve({ base: `http://localhost:${port}`, child });
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function serverEnv(switchedOff: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_INDEX_PATH: indexPath };
  if (switchedOff) env[SWITCH] = "off";
  else delete env[SWITCH];
  return env;
}

describe("the servers the test suite starts send nothing to a referral link", () => {
  before(async () => {
    referralTarget = createServer((req, res) => {
      referralHits.push(`${req.method} ${req.url}`);
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => referralTarget.listen(0, "127.0.0.1", resolve));
    targetBase = `http://127.0.0.1:${(referralTarget.address() as AddressInfo).port}`;

    const shipped = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
    const offers = shipped.offers.map((offer: any) =>
      offer.referral?.url ? { ...offer, referral: { ...offer.referral, url: `${targetBase}/ref/${encodeURIComponent(offer.vendor)}` } } : offer);
    assert.ok(offers.some((offer: any) => offer.referral?.url), "the catalogue holds no referral link to point at the local target");
    fixtureDir = mkdtempSync(path.join(tmpdir(), "referral-switch-"));
    indexPath = path.join(fixtureDir, "index.json");
    writeFileSync(indexPath, JSON.stringify({ ...shipped, offers }));
  });

  after(() => {
    referralTarget?.close();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("npm test and npm run test:gated switch the check off for every server they start", () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts;
    for (const name of ["test", "test:gated"]) {
      assert.match(scripts[name], new RegExp(`(^|\\s)${SWITCH}=off\\s`), `${name} starts its servers with the referral check on`);
    }
  });

  it("a server with the switch unset checks every referral link at startup and reports it", async () => {
    referralHits.length = 0;
    const started = Date.now();
    const { base, child } = await startServer(serverEnv(false));
    try {
      let report: any = null;
      while (Date.now() - started < 30000) {
        const response = await fetch(`${base}/api/referral-health`);
        if (response.status === 200) { report = await response.json(); break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      checkedWithinMs = Date.now() - started;
      assert.ok(report, "the startup check never reported");
      assert.ok(report.total > 0 && report.valid === report.total, JSON.stringify(report));
      assert.ok(report.results.every((result: any) => result.url.startsWith(`${targetBase}/ref/`)), JSON.stringify(report.results));
      assert.ok(referralHits.length >= report.total, `the target saw ${referralHits.length} requests for ${report.total} links`);
    } finally {
      child.kill();
    }
  });

  it("a server with the switch off sends no referral request and reports no check", async () => {
    assert.ok(checkedWithinMs > 0, "the run with the switch unset did not report, so there is no time to wait against");
    referralHits.length = 0;
    const started = Date.now();
    const { base, child } = await startServer(serverEnv(true));
    try {
      while (Date.now() - started < 2 * checkedWithinMs + 1000) {
        const response = await fetch(`${base}/api/referral-health`);
        assert.equal(response.status, 503, `the server reported a referral check ${Date.now() - started} ms after starting`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(referralHits, []);
    } finally {
      child.kill();
    }
  });
});
