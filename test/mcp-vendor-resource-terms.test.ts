import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_CHECK_OUTCOMES, outcomeConfirmsThePrice } from "../dist/source-check.js";
import { CONFIRMED_DATE_LABEL, UNCONFIRMED_DATE_LABEL, confirmationDate, publishedDateLabel } from "../dist/read-date.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const DAY_MS = 86_400_000;
const dayOffset = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
const CONFIRMED_ON = dayOffset(-10);
const CHECKED_ON = dayOffset(-2);

const NOT_OK_OUTCOMES = SOURCE_CHECK_OUTCOMES.filter(
  (outcome: string) => outcome !== "ok" && !outcomeConfirmsThePrice(outcome),
);

function offerFor(vendor: string, outcome: string) {
  const host = `${vendor.toLowerCase()}.example`;
  return {
    vendor,
    category: "Databases",
    description: "Managed Postgres with 10 GB storage, 5 projects and 100K rows",
    tier: "Free",
    url: `https://${host}/pricing`,
    tags: ["databases"],
    verifiedDate: CONFIRMED_ON,
    source_check: { checked: CHECKED_ON, outcome, detail: `recorded as ${outcome}` },
  };
}

const UNCONFIRMED = NOT_OK_OUTCOMES.map((outcome: string, i: number) => offerFor(`Cavecorp${i + 1}`, outcome));
const CONFIRMED = [offerFor("Cleancorp1", "ok"), offerFor("Cleancorp2", "ok")];
const RETIRED = [{
  ...offerFor("Gonecorp1", NOT_OK_OUTCOMES[0]),
  tier: "Retired",
  description: `There is no free tier: gonecorp1.example no longer serves the product. Checked ${CHECKED_ON}, the domain redirects to an unrelated parking page. The former offer was 10 GB storage and 5 projects.`,
}];
const CORPUS = [...UNCONFIRMED, ...CONFIRMED, ...RETIRED];

const slugOf = (vendor: string) => vendor.toLowerCase();

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(indexPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function readResourcesOverStdio(uris: string[]): Promise<Map<string, string>> {
  const child = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: `http://localhost:${serverPort}` },
  });
  const read = new Map<string, string>();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("stdio MCP timeout")); }, 40000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let payload: { id?: number; result?: { contents?: Array<{ text?: string }> } };
        try { payload = JSON.parse(line.trim()); } catch { continue; }
        if (typeof payload.id !== "number" || payload.id < 2) continue;
        read.set(uris[payload.id - 2], payload.result?.contents?.[0]?.text ?? "");
        if (read.size === uris.length) { clearTimeout(timeout); child.kill(); resolve(read); }
      }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    uris.forEach((uri, i) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "resources/read", params: { uri } })}\n`));
  });
}

async function readResourcesOverHttp(uris: string[]): Promise<Map<string, string>> {
  const base = `http://localhost:${serverPort}/mcp`;
  const accept = "application/json, text/event-stream";
  const init = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  const headers = { "Content-Type": "application/json", Accept: accept, "Mcp-Session-Id": session };
  await fetch(base, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const read = new Map<string, string>();
  for (const uri of uris) {
    const res = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
    const payload = JSON.parse(line.replace(/^data: /, ""));
    read.set(uri, payload.result?.contents?.[0]?.text ?? "");
  }
  return read;
}

const URIS = CORPUS.map((o) => `agentdeals://vendor/${slugOf(o.vendor)}`);
let overStdio = new Map<string, string>();
let overHttp = new Map<string, string>();

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "mcp-vendor-terms-"));
  const indexPath = path.join(fixtureDir, "index.json");
  writeFileSync(indexPath, JSON.stringify({ offers: CORPUS }, null, 2));
  proc = await startServer(indexPath);
  overStdio = await readResourcesOverStdio(URIS);
  overHttp = await readResourcesOverHttp(URIS);
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

const bothBuilders: Array<[string, () => Map<string, string>]> = [
  ["read over stdio", () => overStdio],
  ["read over HTTP", () => overHttp],
];

for (const [how, resources] of bothBuilders) {
  describe(`the vendor prose resource, ${how}`, () => {
    it("resolves every vendor in the corpus, so the assertions below are about real resources", () => {
      for (const uri of URIS) {
        const text = resources().get(uri) ?? "";
        assert.match(text, /^# /, `${uri} returned nothing`);
      }
    });

    it("names what the read found wherever it states terms the read did not confirm", () => {
      for (const offer of UNCONFIRMED) {
        const text = resources().get(`agentdeals://vendor/${slugOf(offer.vendor)}`) ?? "";
        assert.ok(text.includes(offer.description), `${offer.vendor} no longer states the terms`);
        assert.match(
          text,
          /\*\*Verification:\*\* Not verified —/,
          `${offer.vendor} (${offer.source_check.outcome}) states the terms and names no reason`,
        );
      }
    });

    it("claims no verification date beside terms it could not confirm", () => {
      for (const offer of UNCONFIRMED) {
        const text = resources().get(`agentdeals://vendor/${slugOf(offer.vendor)}`) ?? "";
        assert.doesNotMatch(
          text,
          /\*\*Verified:\*\* \d{4}-\d{2}-\d{2}/,
          `${offer.vendor} (${offer.source_check.outcome}) carries a bare verification date`,
        );
        assert.ok(text.includes(CONFIRMED_ON), `${offer.vendor} drops the date our own record was last confirmed`);
      }
    });

    it("names no reason to doubt a record whose own terms state the offer is gone", () => {
      for (const offer of RETIRED) {
        const text = resources().get(`agentdeals://vendor/${slugOf(offer.vendor)}`) ?? "";
        assert.ok(text.includes(offer.description), `${offer.vendor} no longer states the terms`);
        assert.doesNotMatch(
          text,
          /\*\*Verification:\*\* Not verified —/,
          `${offer.vendor} states a reason to doubt terms that already say the offer is gone`,
        );
        assert.doesNotMatch(
          text,
          /so we cannot confirm these terms today/,
          `${offer.vendor} closes its own retirement notice with a caveat against it`,
        );
      }
    });

    it("still states the tier where the read found a plan and no amount", () => {
      const offer = UNCONFIRMED.find((o) => o.source_check.outcome === "states_no_amount")!;
      const text = resources().get(`agentdeals://vendor/${slugOf(offer.vendor)}`) ?? "";
      assert.match(text, /\*\*Tier:\*\* Free/);
      assert.ok(text.includes(offer.description));
    });

    it("leaves a resource whose read confirmed the terms publishing its date, under the label the store justifies", () => {
      for (const offer of CONFIRMED) {
        const text = resources().get(`agentdeals://vendor/${slugOf(offer.vendor)}`) ?? "";
        assert.match(
          text,
          new RegExp(`\\*\\*${publishedDateLabel(offer)}:\\*\\* ${CONFIRMED_ON}`),
          `${offer.vendor} lost the date it publishes`,
        );
        if (confirmationDate(offer) === null) {
          assert.doesNotMatch(
            text,
            new RegExp(`\\*\\*${CONFIRMED_DATE_LABEL}:\\*\\*`),
            `${offer.vendor} is stamped ${CONFIRMED_DATE_LABEL} over a date the store cannot source`,
          );
        }
        assert.doesNotMatch(text, /Not verified/, `${offer.vendor} carries a caveat over a read that confirmed`);
      }
    });
  });
}

const TERMS_LINES = new RegExp(`^\\*\\*(?:Description|${CONFIRMED_DATE_LABEL}|${UNCONFIRMED_DATE_LABEL}|Verification):\\*\\*`);

const statedTerms = (text: string) => text.split("\n").filter((line) => TERMS_LINES.test(line));

describe("the two vendor resource builders", () => {
  it("state the terms and their verification identically, so neither can drift from the other", () => {
    for (const uri of URIS) {
      assert.deepEqual(
        statedTerms(overStdio.get(uri) ?? ""),
        statedTerms(overHttp.get(uri) ?? ""),
        `${uri} states its terms differently in the two builders`,
      );
    }
  });
});
