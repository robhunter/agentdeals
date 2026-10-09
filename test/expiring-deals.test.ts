import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalApi, startStdioServerAgainst, type LocalApi } from "./local-api.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
const dateIn = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const EXPIRING_IN_DAYS = [200, 10, 40];
const EXPIRED_DAYS_AGO = 5;

function catalogueExpiringIn(days: readonly number[]): string {
  const catalogue = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "index.json"), "utf-8"));
  for (const offer of catalogue.offers) delete offer.expires_date;
  const subjects: { vendor: string; expires_date?: string }[] = [];
  for (const offer of catalogue.offers) {
    if (subjects.length === days.length) break;
    if (subjects.some((s) => s.vendor === offer.vendor)) continue;
    subjects.push(offer);
  }
  subjects.forEach((subject, i) => { subject.expires_date = dateIn(days[i]); });
  const dir = mkdtempSync(path.join(tmpdir(), "expiring-deals-"));
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(catalogue));
  return path.join(dir, "index.json");
}

const expiringCatalogue = catalogueExpiringIn([...EXPIRING_IN_DAYS, -EXPIRED_DAYS_AGO]);

after(() => rmSync(path.dirname(expiringCatalogue), { recursive: true, force: true }));

describe("getExpiringDeals logic", () => {
  before(() => { process.env.AGENTDEALS_INDEX_PATH = expiringCatalogue; });
  after(() => { delete process.env.AGENTDEALS_INDEX_PATH; });

  it("returns deals expiring within the given window", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(365);
    assert.strictEqual(result.deals.length, EXPIRING_IN_DAYS.length, "Should find every deal expiring within 365 days");
    assert.strictEqual(result.total, result.deals.length);
    for (const deal of result.deals) {
      assert.ok(deal.expires_date, "Each deal should have expires_date");
      assert.ok(typeof deal.days_until_expiry === "number", "Should have days_until_expiry");
      assert.ok(deal.days_until_expiry >= 0, "days_until_expiry should be non-negative");
      assert.ok(deal.days_until_expiry <= 365, "days_until_expiry should be within window");
    }
  });

  it("returns empty results when no deals expire in window", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(0);
    assert.strictEqual(result.total, 0, "No deals should expire within 0 days");
    assert.deepStrictEqual(result.deals, []);
  });

  it("results are sorted by expiration date (soonest first)", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(365);
    for (let i = 1; i < result.deals.length; i++) {
      assert.ok(
        result.deals[i].days_until_expiry >= result.deals[i - 1].days_until_expiry,
        `Deal ${result.deals[i].vendor} should expire after or same as ${result.deals[i - 1].vendor}`
      );
    }
  });

  it("each deal includes standard offer fields", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(365);
    assert.ok(result.deals.length > 0);
    const deal = result.deals[0];
    assert.ok(deal.vendor, "Should have vendor");
    assert.ok(deal.category, "Should have category");
    assert.ok(deal.description, "Should have description");
    assert.ok(deal.tier, "Should have tier");
    assert.ok(deal.expires_date, "Should have expires_date");
    assert.ok(typeof deal.days_until_expiry === "number", "Should have days_until_expiry");
  });

  it("narrower window returns fewer or equal results", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const wide = getExpiringDeals(365);
    const narrow = getExpiringDeals(30);
    assert.ok(narrow.total <= wide.total, "Narrower window should return fewer or equal results");
    assert.strictEqual(narrow.total, EXPIRING_IN_DAYS.filter((d) => d <= 30).length);
  });
});

describe("get_expiring_deals MCP tool via stdio", () => {
  let api: LocalApi;
  let proc: ChildProcess | null = null;

  before(async () => { api = await startLocalApi(); });
  after(() => { api?.stop(); });

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("get_expiring_deals is listed in tools/list", async () => {
    proc = startStdioServerAgainst(api);

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const initedMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const listTools = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const response = await new Promise<string>((resolve, reject) => {
      let data = "";
      const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
      proc!.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        const lines = data.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          clearTimeout(timeout);
          resolve(lines[1]);
        }
      });
      proc!.stdin!.write(initMsg + "\n");
      proc!.stdin!.write(initedMsg + "\n");
      proc!.stdin!.write(listTools + "\n");
    });

    const parsed = JSON.parse(response);
    assert.strictEqual(parsed.id, 2);
    const tools = parsed.result.tools;
    assert.ok(Array.isArray(tools));
    const trackTool = tools.find((t: any) => t.name === "track_changes");
    assert.ok(trackTool, "track_changes should be in tools list");
    assert.ok(trackTool.description.includes("expir") || trackTool.description.includes("changes"), "Description should mention expiring or changes");
  });
});

describe("get_expiring_deals REST endpoint", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", AGENTDEALS_INDEX_PATH: expiringCatalogue },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 10000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/expiring returns expiring deals", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/expiring?within_days=365`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.deals), "Should have deals array");
    assert.ok(typeof body.total === "number", "Should have total count");
    assert.strictEqual(body.deals.length, EXPIRING_IN_DAYS.length);
    assert.ok(body.deals[0].expires_date, "Deals should include expires_date");
    assert.ok(typeof body.deals[0].days_until_expiry === "number", "Deals should include days_until_expiry");
  });

  it("GET /api/expiring defaults to 30 days", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/expiring`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.deals));
    assert.strictEqual(body.deals.length, EXPIRING_IN_DAYS.filter((d) => d <= 30).length);
    for (const deal of body.deals) {
      assert.ok(deal.days_until_expiry <= 30, `Deal ${deal.vendor} should expire within 30 days`);
    }
  });
});

describe("/api/expiring cites the expiring page whatever the window holds", () => {
  let scratch = "";
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  before(async () => {
    const catalogue = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "index.json"), "utf-8"));
    for (const offer of catalogue.offers) delete offer.expires_date;
    const subjects: { expires_date?: string }[] = [];
    const seen = new Set<string>();
    for (const offer of catalogue.offers) {
      if (subjects.length === 3) break;
      if (seen.has(offer.vendor)) continue;
      seen.add(offer.vendor);
      subjects.push(offer);
    }
    subjects[0].expires_date = dateIn(3);
    subjects[1].expires_date = dateIn(8);
    subjects[2].expires_date = dateIn(8);
    scratch = mkdtempSync(path.join(tmpdir(), "expiring-citation-"));
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify(catalogue));
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const p = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json") },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 60000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  });

  after(() => {
    proc?.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  for (const [withinDays, holds] of [[1, 0], [5, 1], [20, 3]] as const) {
    it(`cites /expiring when the window holds ${holds} record${holds === 1 ? "" : "s"}`, async () => {
      const body = await fetch(`http://localhost:${serverPort}/api/expiring?within_days=${withinDays}`).then((r) => r.json()) as {
        total: number;
        _provenance: { url: string; cite_as: string };
      };
      assert.strictEqual(body.total, holds);
      assert.strictEqual(new URL(body._provenance.url).pathname, "/expiring", body._provenance.cite_as);
    });
  }
});
