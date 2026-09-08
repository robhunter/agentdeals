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

const SOLICITATION_MARKERS = [
  "marketplace-solicitation",
  "60% commission",
  "Submit a referral code",
  "Submit your referral code",
  "Know a referral or partner program",
  'href="/marketplace"',
];

function solicitationsIn(html: string): string[] {
  return SOLICITATION_MARKERS.filter(marker => html.includes(marker));
}

async function getText(pathname: string): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${pathname}`);
  assert.strictEqual(res.status, 200, `${pathname} answered ${res.status}`);
  return res.text();
}

describe("vendor pages do not ask for referral codes", () => {
  before(async () => { serverProc = await startServer(); });
  after(() => { serverProc?.kill(); });

  it("a vendor with no code and no program of its own carries nothing", async () => {
    const html = await getText("/vendor/deno-deploy");
    assert.deepStrictEqual(solicitationsIn(html), []);
  });

  it("the vendor page the report names carries nothing", async () => {
    const html = await getText("/vendor/supabase");
    assert.deepStrictEqual(solicitationsIn(html), []);
  });

  it("a vendor whose only referral surface is a code of ours carries nothing", async () => {
    const html = await getText("/vendor/railway");
    assert.deepStrictEqual(solicitationsIn(html), []);
  });
});

describe("what the vendor pages keep", () => {
  before(async () => { if (!serverProc || serverProc.killed) serverProc = await startServer(); });
  after(() => { serverProc?.kill(); });

  it("a vendor running its own referral program keeps that section", async () => {
    for (const slug of ["vercel", "neon", "proton-mail", "proton-drive", "proton-vpn", "proton-pass"]) {
      const html = await getText(`/vendor/${slug}`);
      assert.ok(html.includes(">Referral Program</h2>"), `/vendor/${slug} lost its referral program section`);
      assert.deepStrictEqual(solicitationsIn(html), [], `/vendor/${slug} gained a solicitation`);
    }
  });

  it("the one vendor we hold a code for keeps its referral link", async () => {
    const html = await getText("/vendor/railway");
    assert.ok(html.includes("Sign up via our referral link"), "the referral call to action is gone");
    assert.ok(html.includes("7RZL9q"), "the code we earn on is gone");
    assert.deepStrictEqual(solicitationsIn(html), []);
  });

  it("a lookup for that code still answers with it", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/Railway`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { code?: string; source?: string };
    assert.strictEqual(body.code, "7RZL9q");
    assert.strictEqual(body.source, "platform");
  });
});
