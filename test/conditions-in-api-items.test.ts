import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;
type ListingCondition = import("../src/types.ts").ListingCondition;

const { supersedingChange } = await import("../dist/superseded-description.js");
const { offerRetired } = await import("../dist/retirement.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const changeLog: DealChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

const changesByVendor = new Map<string, DealChange[]>();
for (const change of changeLog) {
  const key = change.vendor.toLowerCase();
  changesByVendor.set(key, [...(changesByVendor.get(key) ?? []), change]);
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function codeFor(index: number): string {
  return LETTERS[Math.floor(index / 676) % 26]! + LETTERS[Math.floor(index / 26) % 26]! + LETTERS[index % 26]!;
}

const DESCRIPTION_TOKEN = "Zqd";
const ANY_DESCRIPTION_TOKEN = /Zqd([a-z]{3})\.(?!\.)/g;

function conditionNaming(token: string): ListingCondition {
  return { text: `The free plan carries condition ${token}.`, quote: `Condition ${token} applies.`, url: "https://conditions.example/terms", read_on: TODAY };
}

const conditionsByCode = new Map<string, ListingCondition[]>();
const vendorByCode = new Map<string, string>();
let listedToday = false;

const scratchOffers: Offer[] = catalogue.offers.map((offer: Offer, index: number) => {
  const code = codeFor(index);
  if (offerRetired(offer) || supersedingChange(offer, changesByVendor.get(offer.vendor.toLowerCase()) ?? [])) {
    return { ...offer, conditions: [conditionNaming(`Zqs${code}`)] };
  }
  const conditions = [conditionNaming(`Zqc${code}`)];
  conditionsByCode.set(code, conditions);
  vendorByCode.set(code, offer.vendor);
  const listedOn = listedToday ? {} : { verifiedDate: TODAY };
  listedToday = true;
  const description = `${offer.description.endsWith(".") ? offer.description.slice(0, -1) : offer.description} ${DESCRIPTION_TOKEN}${code}.`;
  return { ...offer, ...listedOn, description, conditions };
});

const unconditionedOffers: Offer[] = catalogue.offers.map((offer: Offer) => {
  const { conditions: _none, ...withoutConditions } = offer;
  return withoutConditions as Offer;
});

const dir = mkdtempSync(path.join(tmpdir(), "conditions-in-api-items-"));

function scratchCatalogue(name: string, offers: Offer[]): string {
  const indexPath = path.join(dir, name);
  writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers }));
  return indexPath;
}

function startServer(indexPath: string): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const liveVendors = scratchOffers.filter(offer => offer.description.includes(DESCRIPTION_TOKEN)).map(offer => offer.vendor);
const WELL_KNOWN = ["Vercel", "Supabase", "Neon", "Render", "Railway", "Northflank"].filter(vendor => liveVendors.includes(vendor));
const SHORT_DESCRIPTIONS = scratchOffers
  .filter(offer => offer.description.includes(DESCRIPTION_TOKEN) && offer.description.length <= 200 && offer.tier !== "Free")
  .slice(0, 4)
  .map(offer => offer.vendor);

const API_ROUTES = [
  "/api/offers?limit=5000",
  "/api/new?days=30",
  "/api/newest?since=2000-01-01&limit=500",
  "/api/agent-payments",
  "/api/ai-coding-pricing",
  "/api/hosting-pricing",
  "/api/llm-pricing",
  "/api/startup-credits",
  "/api/digest",
  "/api/audit-stack?services=No%20Such%20Vendor",
  "/api/stack?use_case=Next.js%20SaaS%20app",
  `/api/costs?scale=startup&services=${encodeURIComponent(SHORT_DESCRIPTIONS.join(","))}`,
  ...WELL_KNOWN.map(vendor => `/api/details/${encodeURIComponent(vendor)}?alternatives=true`),
  `/api/compare?a=${encodeURIComponent(WELL_KNOWN[0]!)}&b=${encodeURIComponent(WELL_KNOWN[1]!)}`,
];

const MCP_CALLS: Array<{ name: string; arguments: Record<string, unknown> }> = [
  { name: "search_deals", arguments: { query: "postgres", limit: 50 } },
  { name: "search_deals", arguments: { query: "postgres", limit: 50, response_format: "concise" } },
  ...WELL_KNOWN.slice(0, 3).map(vendor => ({ name: "search_deals", arguments: { vendor } })),
  ...WELL_KNOWN.slice(0, 3).map(vendor => ({ name: "search_deals", arguments: { vendor, response_format: "concise" } })),
  { name: "plan_stack", arguments: { mode: "recommend", use_case: "Next.js SaaS app" } },
  { name: "plan_stack", arguments: { mode: "estimate", scale: "startup", services: SHORT_DESCRIPTIONS } },
  { name: "plan_stack", arguments: { mode: "audit", services: ["No Such Vendor"] } },
  { name: "compare_vendors", arguments: { vendors: WELL_KNOWN.slice(0, 2) } },
  { name: "track_changes", arguments: {} },
];

function parseEventStream(text: string): any[] {
  return text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}

async function mcpResults(base: string): Promise<Array<{ surface: string; body: string }>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conditions-in-api-items", version: "1" } } }),
  });
  await initialized.text();
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  await (await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const results: Array<{ surface: string; body: string }> = [];
  for (const [index, call] of MCP_CALLS.entries()) {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: call }) });
    const [message] = parseEventStream(await response.text());
    for (const content of message?.result?.content ?? []) {
      if (content.type === "text") results.push({ surface: `${call.name} ${JSON.stringify(call.arguments)}`, body: content.text });
    }
  }
  return results;
}

async function outputsOf(base: string): Promise<Array<{ surface: string; body: string }>> {
  const outputs: Array<{ surface: string; body: string }> = [];
  for (const route of API_ROUTES) {
    const response = await fetch(base + route);
    assert.strictEqual(response.status, 200, `${route} answered ${response.status}`);
    outputs.push({ surface: route, body: await response.text() });
  }
  return [...outputs, ...await mcpResults(base)];
}

interface FullDescription {
  surface: string;
  at: string;
  code: string;
  conditions: unknown;
}

function fullDescriptionsIn(surface: string, node: unknown, holder: Record<string, unknown> | null, at: string, found: FullDescription[]): void {
  if (typeof node === "string") {
    for (const match of node.matchAll(ANY_DESCRIPTION_TOKEN)) {
      if (conditionsByCode.has(match[1]!)) found.push({ surface, at, code: match[1]!, conditions: holder?.conditions });
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => fullDescriptionsIn(surface, item, holder, `${at}[${index}]`, found));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) fullDescriptionsIn(surface, value, node as Record<string, unknown>, `${at}.${key}`, found);
  }
}

function parsedOrNull(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function fullDescriptionsInText(surface: string, text: string, found: FullDescription[]): void {
  const matches = [...text.matchAll(ANY_DESCRIPTION_TOKEN)];
  matches.forEach((match, index) => {
    const code = match[1]!;
    if (!conditionsByCode.has(code)) return;
    const after = text.slice(match.index! + match[0].length, index + 1 < matches.length ? matches[index + 1]!.index! : text.length);
    const stated = conditionsByCode.get(code)!.every(condition => after.includes(condition.text));
    found.push({ surface, at: "text", code, conditions: stated ? conditionsByCode.get(code) : undefined });
  });
}

function fullDescriptionsInOutput(surface: string, body: string, found: FullDescription[]): void {
  const parsed = parsedOrNull(body);
  if (parsed === null) fullDescriptionsInText(surface, body, found);
  else fullDescriptionsIn(surface, parsed, null, "$", found);
}

function listingConditionsIn(node: unknown, at: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => listingConditionsIn(item, `${at}[${index}]`, found));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "conditions" && ("vendor" in node || (Array.isArray(value) && value.some(item => item && typeof item === "object" && "quote" in item)))) found.push(`${at}.${key}`);
      else listingConditionsIn(value, `${at}.${key}`, found);
    }
  }
}

const SURFACES_THAT_BUILD_ITEMS_FIELD_BY_FIELD = [
  "/api/agent-payments",
  "/api/ai-coding-pricing",
  "/api/hosting-pricing",
  "/api/llm-pricing",
  "/api/startup-credits",
  "/api/digest",
  "/api/audit-stack",
  "/api/stack",
  "/api/costs",
  'search_deals {"query":"postgres","limit":50,"response_format":"concise"}',
  'plan_stack {"mode":"recommend"',
  'plan_stack {"mode":"estimate"',
  'plan_stack {"mode":"audit"',
  "track_changes",
];

describe("every API item and MCP result that prints a listing's description in full carries the listing's conditions", () => {
  let server: { proc: ChildProcess; base: string };
  const printed: FullDescription[] = [];

  before(async () => {
    server = await startServer(scratchCatalogue("conditioned.json", scratchOffers));
    for (const output of await outputsOf(server.base)) fullDescriptionsInOutput(output.surface, output.body, printed);
  });

  after(() => server?.proc.kill());

  it("reads enough full descriptions for the check to be able to fail", () => {
    assertPopulationFloor(printed.length, 1900, "full descriptions printed in API items and MCP results");
    assertPopulationFloor(new Set(printed.map(one => one.surface)).size, 20, "API routes and MCP calls printing a full description");
  });

  it("prints full descriptions in every surface that builds its items field by field, so each can be checked", () => {
    const silent = SURFACES_THAT_BUILD_ITEMS_FIELD_BY_FIELD.filter(surface => !printed.some(one => one.surface.startsWith(surface)));
    assert.deepStrictEqual(silent, []);
  });

  it("carries each listing's conditions, as the listing stores them, in the item that prints its description", () => {
    const missing = printed
      .filter(one => JSON.stringify(one.conditions) !== JSON.stringify(conditionsByCode.get(one.code)))
      .map(one => `${one.surface} ${one.at.replace(/\[\d+\]/g, "[]")}`);
    const lines = [...new Set(missing)];
    assert.deepStrictEqual(lines, [], `${missing.length} full descriptions printed without their listing's conditions`);
  });
});

describe("API items and MCP results from a catalogue in which no listing states conditions", () => {
  let server: { proc: ChildProcess; base: string };
  const carried: string[] = [];
  let outputsRead = 0;

  before(async () => {
    server = await startServer(scratchCatalogue("unconditioned.json", unconditionedOffers));
    for (const output of await outputsOf(server.base)) {
      outputsRead += 1;
      listingConditionsIn(parsedOrNull(output.body), output.surface, carried);
    }
  });

  after(() => server?.proc.kill());

  it("carry no listing conditions anywhere", () => {
    assertPopulationFloor(outputsRead, 20, "API routes and MCP calls read for listing conditions");
    assert.deepStrictEqual(carried, []);
  });
});
