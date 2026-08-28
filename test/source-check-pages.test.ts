import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const SOURCED_FROM_A_MARKETPLACE = {
  vendor: "Fixturecorp",
  category: "Databases",
  description: "30% off for 3 months. Access via: First deal free",
  tier: "Startup Program",
  url: "https://dealmarket.example/offers",
  tags: ["databases"],
  verifiedDate: "2026-08-11",
  source_check: {
    checked: "2026-08-28",
    outcome: "does_not_name_vendor",
    detail: "the page never names Fixturecorp and is not served from its domain",
  },
};

const SOURCED_FROM_ITS_OWN_PAGE = {
  ...SOURCED_FROM_A_MARKETPLACE,
  vendor: "Controlcorp",
  url: "https://controlcorp.example/pricing",
  source_check: { checked: "2026-08-28", outcome: "ok", detail: "text" },
};

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(indexPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "source-check-"));
  const indexPath = path.join(fixtureDir, "index.json");
  writeFileSync(
    indexPath,
    JSON.stringify({ offers: [SOURCED_FROM_A_MARKETPLACE, SOURCED_FROM_ITS_OWN_PAGE] }, null, 2)
  );
  proc = await startServer(indexPath);
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("a vendor page whose cited source names somebody else", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get("/vendor/fixturecorp");
    assert.equal(res.status, 200);
  });

  it("does not read its empty change history as good news", async () => {
    const { body } = await get("/vendor/fixturecorp");
    assert.doesNotMatch(body, /This is a good sign — stable pricing/);
    assert.match(body, /does not name it/);
  });

  it("does not open with a stability verdict it cannot back", async () => {
    const { body } = await get("/vendor/fixturecorp");
    assert.doesNotMatch(body, /It's stable — zero pricing changes recorded/);
    assert.match(body, /we cannot confirm these terms today/);
  });

  it("shows no stability value in the comparison table", async () => {
    const { body } = await get("/vendor/fixturecorp");
    const row = body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "";
    assert.ok(row.includes("Fixturecorp"), "the row under test must be the vendor's own");
    assert.match(row, /source unconfirmed/);
    assert.doesNotMatch(row, /stability-dot/);
  });

  it("answers the reliability question with what it cannot say", async () => {
    const { body } = await get("/vendor/fixturecorp");
    assert.doesNotMatch(body, /free tier is considered stable/);
    assert.doesNotMatch(body, /This is a positive stability signal/);
  });

  it("still reads an empty history as good news where the source does name the vendor", async () => {
    const { body } = await get("/vendor/controlcorp");
    assert.match(body, /This is a good sign — stable pricing/);
  });

  it("publishes no risk level for it through the API", async () => {
    const { body } = await get("/api/offers?q=fixturecorp");
    const offer = JSON.parse(body).offers[0];
    assert.strictEqual(offer.risk_level, null);
    assert.strictEqual(offer.source_check.outcome, "does_not_name_vendor");
  });

  it("publishes a stable level for the control", async () => {
    const { body } = await get("/api/offers?q=controlcorp");
    assert.strictEqual(JSON.parse(body).offers[0].risk_level, "stable");
  });
});
