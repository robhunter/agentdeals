import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citedRecords, narrowestPath } from "../dist/provenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");

interface IndexedOffer {
  vendor: string;
  category?: string;
  verifiedDate?: string;
  gate?: unknown;
  terms_superseded?: unknown;
  risk_level?: unknown;
}

function aVendorWhoseWholeCatalogueIsOneOffer(offers: IndexedOffer[]): IndexedOffer {
  const offersPerVendor = new Map<string, number>();
  for (const offer of offers) offersPerVendor.set(offer.vendor, (offersPerVendor.get(offer.vendor) ?? 0) + 1);
  const found = offers.find((offer) =>
    offersPerVendor.get(offer.vendor) === 1 &&
    typeof offer.category === "string" && offer.category.length > 0 &&
    typeof offer.verifiedDate === "string" &&
    offer.gate === undefined &&
    offer.terms_superseded === undefined &&
    offer.risk_level !== null);
  assert.ok(found, "no vendor in the index holds a single dated offer we publish in full");
  return found;
}

const CATALOGUE_WIDE_ROUTES: [string, (vendor: string, category: string) => string][] = [
  ["/api/new", () => "/api/new?days=3650"],
  ["/api/newest", () => "/api/newest?limit=3"],
  ["/api/audit-stack", (vendor) => `/api/audit-stack?services=${encodeURIComponent(vendor)}`],
  ["/api/stack", (vendor, category) => `/api/stack?use_case=a+small+web+app&requirements=${encodeURIComponent(category)}`],
  ["/api/costs", (vendor) => `/api/costs?services=${encodeURIComponent(vendor)}&scale=hobby`],
];

const CATALOGUE_WIDE_TOOLS: [string, string, (vendor: string, category: string) => unknown][] = [
  ["search_deals since a date", "search_deals", () => ({ since: "2000-01-01" })],
  ["plan_stack in recommend mode", "plan_stack", (vendor, category) => ({ mode: "recommend", use_case: "a small web app", requirements: [category] })],
  ["plan_stack in estimate mode", "plan_stack", (vendor) => ({ mode: "estimate", services: [vendor], scale: "hobby" })],
  ["plan_stack in audit mode", "plan_stack", (vendor) => ({ mode: "audit", services: [vendor] })],
];

const ANSWERED_FROM_THE_WHOLE_CATALOGUE = [
  ...CATALOGUE_WIDE_ROUTES.map(([route]) => route),
  ...CATALOGUE_WIDE_TOOLS.map(([label]) => label),
];

describe("a route answering from the whole catalogue cites the whole catalogue", () => {
  let proc: ChildProcess;
  let base: string;
  let vendor: string;
  let category: string;
  let sessionId: string;
  const bodies = new Map<string, string>();

  const callTool = async (name: string, args: unknown, id: number): Promise<string> => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
    const payload = JSON.parse(line.replace(/^data: /, ""));
    const first = payload?.result?.content?.[0]?.text;
    assert.ok(typeof first === "string", `${name} answered ${text.slice(0, 200)}`);
    return first;
  };

  before(async () => {
    const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as { offers: IndexedOffer[] };
    const only = aVendorWhoseWholeCatalogueIsOneOffer(index.offers);
    vendor = only.vendor;
    category = only.category!;
    const fixture = path.join(mkdtempSync(path.join(tmpdir(), "one-vendor-index-")), "index.json");
    writeFileSync(fixture, JSON.stringify({ ...index, offers: [only] }));

    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", AGENTDEALS_INDEX_PATH: fixture },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
    for (const [route, probe] of CATALOGUE_WIDE_ROUTES) {
      bodies.set(route, await (await fetch(`${base}${probe(vendor, category)}`)).text());
    }

    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
      }),
    });
    sessionId = init.headers.get("mcp-session-id") ?? "";
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    for (const [index, [label, tool, args]] of CATALOGUE_WIDE_TOOLS.entries()) {
      bodies.set(label, await callTool(tool, args(vendor, category), 100 + index));
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("serves a catalogue of exactly one vendor", async () => {
    const offers = JSON.parse(await (await fetch(`${base}/api/offers?limit=100`)).text()) as { offers: { vendor: string }[] };
    assert.deepStrictEqual([...new Set(offers.offers.map((o) => o.vendor))], [vendor]);
  });

  it("checks every surface that answers from the whole catalogue", () => {
    assert.deepStrictEqual([...bodies.keys()].sort(), [...ANSWERED_FROM_THE_WHOLE_CATALOGUE].sort());
  });

  for (const route of ANSWERED_FROM_THE_WHOLE_CATALOGUE) {
    it(`${route} draws on records a derived citation would narrow to`, () => {
      const records = citedRecords(JSON.parse(bodies.get(route)!));
      assert.notStrictEqual(records.length, 0, `${route} answers with no record, so this probe proves nothing`);
      assert.notStrictEqual(
        narrowestPath(records),
        "/",
        `${route} answers with records spread wider than one page, so this probe proves nothing`,
      );
    });

    it(`${route} cites the site root over a catalogue holding one vendor`, () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      assert.strictEqual(new URL(String(block.url)).pathname, "/", `${route} cites ${block.url}`);
    });

    it(`${route} counts the records it answered with`, () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      const published = citedRecords(JSON.parse(bodies.get(route)!)).filter((r) => !r.withheld).length;
      assert.strictEqual(block.verified_records, published, `${route} counts records it did not answer with`);
    });

    it(`${route} cites a page that answers`, async () => {
      const block = (JSON.parse(bodies.get(route)!) as Record<string, unknown>)._provenance as Record<string, unknown>;
      const res = await fetch(`${base}${new URL(String(block.url)).pathname}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `${route} cites a page answering ${res.status}`);
    });
  }
});
