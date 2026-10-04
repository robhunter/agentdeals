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
const { conditionsInPlainText } = await import("../dist/listing-conditions.js");

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

const ANY_DESCRIPTION_TOKEN = /Zqd([a-z]{3})\.(?!\.)/g;
const SET_ASIDE_TOKEN = /Zqs([a-z]{3})/g;

function conditionNaming(token: string): ListingCondition {
  return { text: `The free plan carries condition ${token}.`, quote: `Condition ${token} applies.`, url: "https://conditions.example/terms", read_on: TODAY };
}

type Role = "conditions" | "none";

const roleByCode = new Map<string, Role>();
const vendorByCode = new Map<string, string>();

const scratchOffers: Offer[] = catalogue.offers.map((offer: Offer, index: number) => {
  const code = codeFor(index);
  if (offerRetired(offer) || supersedingChange(offer, changesByVendor.get(offer.vendor.toLowerCase()) ?? [])) {
    return { ...offer, conditions: [conditionNaming(`Zqs${code}`)] };
  }
  const role: Role = index % 2 === 0 ? "conditions" : "none";
  roleByCode.set(code, role);
  vendorByCode.set(code, offer.vendor);
  const { conditions: _stored, ...withoutConditions } = offer;
  const description = `${offer.description.endsWith(".") ? offer.description.slice(0, -1) : offer.description} Zqd${code}.`;
  return role === "conditions"
    ? { ...withoutConditions, description, conditions: [conditionNaming(`Zqc${code}`)] }
    : { ...withoutConditions, description } as Offer;
});

const dir = mkdtempSync(path.join(tmpdir(), "conditions-in-mcp-text-"));
const scratchIndex = path.join(dir, "index.json");
writeFileSync(scratchIndex, JSON.stringify({ ...catalogue, offers: scratchOffers }));

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
const liveVendors = [...vendorByCode.values()];
const categoryUris = [...new Set<string>(catalogue.offers.map((offer: Offer) => offer.category))].map(name => `agentdeals://category/${slugOf(name)}`);
const vendorUris = [...new Set(["Vercel", "Supabase", "Neon", "Render", "Railway", "Northflank", ...liveVendors.filter((_, index) => index % 60 === 0)])]
  .filter(vendor => liveVendors.includes(vendor))
  .map(vendor => `agentdeals://vendor/${slugOf(vendor)}`);

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: scratchIndex },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function readOverHttp(base: string, uris: string[]): Promise<Map<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conditions-in-mcp-text", version: "1" } } }),
  });
  await initialized.text();
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  await (await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const read = new Map<string, string>();
  for (const [index, uri] of uris.entries()) {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "resources/read", params: { uri } }) });
    const line = (await response.text()).split("\n").find(one => one.startsWith("data: "));
    read.set(uri, line ? JSON.parse(line.slice(6)).result?.contents?.[0]?.text ?? "" : "");
  }
  return read;
}

function readOverStdio(base: string, uris: string[]): Promise<Map<string, string>> {
  const child = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDEALS_API_URL: base },
  });
  const read = new Map<string, string>();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("stdio MCP timeout")); }, 120000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let payload: { id?: number; result?: { contents?: Array<{ text?: string }> } };
        try { payload = JSON.parse(line); } catch { continue; }
        if (typeof payload.id !== "number" || payload.id < 2) continue;
        read.set(uris[payload.id - 2]!, payload.result?.contents?.[0]?.text ?? "");
        if (read.size === uris.length) { clearTimeout(timer); child.kill(); resolve(read); }
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conditions-in-mcp-text", version: "1" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    uris.forEach((uri, index) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "resources/read", params: { uri } })}\n`));
  });
}

interface Printed {
  where: string;
  code: string;
  role: Role;
  after: string;
}

function descriptionsPrinted(where: string, text: string): Printed[] {
  const found = [...text.matchAll(ANY_DESCRIPTION_TOKEN)].filter(match => roleByCode.has(match[1]!));
  return found.map((match, index) => ({
    where,
    code: match[1]!,
    role: roleByCode.get(match[1]!)!,
    after: text.slice(match.index! + match[0].length, index + 1 < found.length ? found[index + 1]!.index! : text.length),
  }));
}

function checksOn(read: () => Map<string, string>, floors: { conditioned: number; unconditioned: number }) {
  return () => {
    it("reads enough descriptions of listings with and without conditions for the check to be able to fail", () => {
      const printed = [...read()].flatMap(([uri, text]) => descriptionsPrinted(uri, text));
      assertPopulationFloor(printed.filter(one => one.role === "conditions").length, floors.conditioned, "full descriptions of listings with conditions printed in MCP text");
      assertPopulationFloor(printed.filter(one => one.role === "none").length, floors.unconditioned, "full descriptions of listings without conditions printed in MCP text");
    });

    it("follows each full description with the listing's conditions in plain text, before the next listing begins", () => {
      const missing = [...read()]
        .flatMap(([uri, text]) => descriptionsPrinted(uri, text))
        .filter(one => one.role === "conditions" && !one.after.includes(` ${conditionsInPlainText([conditionNaming(`Zqc${one.code}`)])}`))
        .map(one => `${one.where}: ${vendorByCode.get(one.code)}`);
      assert.deepStrictEqual(missing, []);
    });

    it("prints no conditions after a listing that has none", () => {
      const stray = [...read()]
        .flatMap(([uri, text]) => descriptionsPrinted(uri, text))
        .filter(one => one.role === "none" && one.after.includes("conditions.example"))
        .map(one => `${one.where}: ${vendorByCode.get(one.code)}`);
      assert.deepStrictEqual(stray, []);
    });

    it("prints no conditions for a listing whose offer has ended or whose stored terms a later change supersedes", () => {
      const printed = [...read()].flatMap(([uri, text]) => [...text.matchAll(SET_ASIDE_TOKEN)].map(match => `${uri}: Zqs${match[1]}`));
      assert.deepStrictEqual(printed, []);
    });
  };
}

describe("MCP category and vendor resources print a listing's conditions after its description", () => {
  let server: { proc: ChildProcess; base: string };
  let overHttp = new Map<string, string>();
  let overStdio = new Map<string, string>();

  before(async () => {
    server = await startServer();
    overHttp = await readOverHttp(server.base, [...categoryUris, ...vendorUris]);
    overStdio = await readOverStdio(server.base, [...categoryUris, ...vendorUris.slice(0, 8)]);
  });

  after(() => server?.proc.kill());

  describe("served over HTTP", checksOn(() => overHttp, { conditioned: 500, unconditioned: 500 }));
  describe("served by the stdio package from the API", checksOn(() => overStdio, { conditioned: 100, unconditioned: 100 }));
});
