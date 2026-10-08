import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalApi, type LocalApi } from "./local-api.ts";

type Offer = import("../src/types.ts").Offer;
type JsonObject = Record<string, any>;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const IN_A_WEEK = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

const PINNED = ["logflare.app", "phare.io", "addy.io"];
const SEARCH_VIEW = "ui://agentdeals/search-deals";

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const dir = mkdtempSync(path.join(tmpdir(), "withheld-terms-mcp-"));

function newAndExpiringFirst(): string {
  const pinned = catalogue.offers.filter((offer: Offer) => PINNED.includes(offer.vendor)).map((offer: Offer) => ({ ...offer, verifiedDate: TODAY, expires_date: IN_A_WEEK }));
  const others = catalogue.offers.filter((offer: Offer) => !PINNED.includes(offer.vendor));
  const at = path.join(dir, "index.json");
  writeFileSync(at, JSON.stringify({ ...catalogue, offers: [...pinned, ...others] }));
  return at;
}

interface Withheld {
  vendor: string;
  category: string;
  description: string;
  terms_superseded: { notice: string };
}

interface ToolRead {
  label: string;
  args: JsonObject;
  result: JsonObject;
}

let api: LocalApi;
let withheld: Withheld[] = [];
let withSubstitutes: string[] = [];
let toolReads: ToolRead[] = [];
const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const renderers: Record<string, (args: unknown, data: unknown) => void> = {};
const shown = { innerHTML: "" };
let nextId = 10;

async function rpc(message: object): Promise<any[]> {
  const response = await fetch(`${api.url}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  const session = response.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

async function callTool(name: string, args: JsonObject): Promise<JsonObject> {
  const [call] = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
  assert.ok(!call.result.isError, `${name} ${JSON.stringify(args)}: ${call.result.content[0].text}`);
  return JSON.parse(call.result.content[0].text);
}

function escapedLikeTheView(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const documentStub = {
  getElementById: () => shown,
  createElement: () => {
    let text = "";
    return {
      set textContent(value: string) { text = String(value); },
      get innerHTML() { return escapedLikeTheView(text); },
    };
  },
};

async function rendererFor(uri: string): Promise<(args: unknown, data: unknown) => void> {
  const [read] = await rpc({ jsonrpc: "2.0", id: nextId++, method: "resources/read", params: { uri } });
  const script = read.result.contents[0].text.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const afterConnect = script.slice(script.indexOf("await app.connect();") + "await app.connect();".length);
  return new Function("document", `${afterConnect}\nreturn render;`)(documentStub);
}

function squashed(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function linesShown(): string[] {
  return shown.innerHTML
    .replace(/\s+/g, " ")
    .replace(/<\/(tr|div|h\d|p)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .split("\n")
    .map(squashed)
    .filter(Boolean);
}

function objectsIn(value: unknown, found: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(value)) {
    for (const item of value) objectsIn(item, found);
  } else if (value !== null && typeof value === "object") {
    found.push(value as JsonObject);
    for (const inner of Object.values(value)) objectsIn(inner, found);
  }
  return found;
}

function printsTheStoredTermsOf(object: JsonObject, listing: Withheld): boolean {
  if (object.vendor !== listing.vendor || typeof object.description !== "string") return false;
  const printed = object.description;
  return printed === listing.description || (printed.endsWith("...") && listing.description.startsWith(printed.slice(0, -3)));
}

function printedWithheld(read: ToolRead): { object: JsonObject; listing: Withheld }[] {
  return objectsIn(read.result).flatMap((object) =>
    withheld.filter((listing) => printsTheStoredTermsOf(object, listing)).map((listing) => ({ object, listing })),
  );
}

function readsLabelled(label: string): ToolRead[] {
  return toolReads.filter((read) => read.label === label);
}

function storedOpening(listing: Withheld): string {
  return squashed(listing.description).slice(0, 50);
}

async function alternativesOf(vendor: string): Promise<{ relatedVendors: string[]; alternatives: string[] }> {
  const details = await (await fetch(`${api.url}/api/details/${encodeURIComponent(vendor)}?alternatives=true`)).json() as { relatedVendors?: string[]; alternatives?: { vendor: string }[] };
  return { relatedVendors: details.relatedVendors ?? [], alternatives: (details.alternatives ?? []).map((each) => each.vendor) };
}

async function peerListing(listing: Withheld): Promise<string | null> {
  for (const candidate of (await alternativesOf(listing.vendor)).relatedVendors) {
    if ((await alternativesOf(candidate)).alternatives.includes(listing.vendor)) return candidate;
  }
  return null;
}

before(async () => {
  process.env.AGENTDEALS_INDEX_PATH = newAndExpiringFirst();
  api = await startLocalApi();
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "withheld-terms-mcp-test", version: "1" } } });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const offers = await (await fetch(`${api.url}/api/offers?limit=5000`)).json() as { offers: (Offer & { terms_superseded: { notice: string } | null })[] };
  withheld = offers.offers
    .filter((offer) => offer.terms_superseded)
    .map((offer) => ({ vendor: offer.vendor, category: offer.category, description: offer.description, terms_superseded: offer.terms_superseded! }));
  const pinned = withheld.filter((listing) => PINNED.includes(listing.vendor));
  const peers: [string, string][] = [];
  for (const listing of pinned) {
    const peer = await peerListing(listing);
    if (peer) peers.push([listing.vendor, peer]);
  }
  withSubstitutes = peers.map(([vendor]) => vendor);
  const calls: [string, string, JsonObject][] = [
    ...pinned.map((listing): [string, string, JsonObject] => ["vendor", "search_deals", { vendor: listing.vendor }]),
    ...peers.map(([, peer]): [string, string, JsonObject] => ["peer", "search_deals", { vendor: peer }]),
    ...pinned.map((listing): [string, string, JsonObject] => ["query", "search_deals", { query: listing.vendor }]),
    ...pinned.map((listing): [string, string, JsonObject] => ["concise", "search_deals", { query: listing.vendor, response_format: "concise" }]),
    ["since", "search_deals", { since: TODAY, limit: 2000 }],
    ["compare", "compare_vendors", { vendors: [PINNED[0], PINNED[1]] }],
    ["compare", "compare_vendors", { vendors: [PINNED[2], PINNED[0]] }],
    ["track", "track_changes", { include_expiring: true, lookahead_days: 30 }],
    ["audit", "plan_stack", { mode: "audit", services: PINNED }],
  ];
  toolReads = [];
  for (const [label, name, args] of calls) toolReads.push({ label, args, result: await callTool(name, args) });
  renderers[SEARCH_VIEW] = await rendererFor(SEARCH_VIEW);
});

after(() => {
  api?.stop();
  delete process.env.AGENTDEALS_INDEX_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP tools mark a listing whose stored terms the vendor page withholds", () => {
  it("withholds the terms of each pinned listing, and no notice quotes the stored terms it replaces", () => {
    for (const vendor of PINNED) {
      const listing = withheld.find((each) => each.vendor === vendor);
      assert.ok(listing, `${vendor} is no longer withheld; pin another withheld listing`);
      assert.ok(!squashed(listing.terms_superseded.notice).includes(storedOpening(listing)), vendor);
    }
  });

  it("returns terms_superseded, as /api/offers gives it, on every object that prints a withheld listing's stored description", () => {
    const unmarked = toolReads.flatMap((read) =>
      printedWithheld(read)
        .filter(({ object, listing }) => JSON.stringify(object.terms_superseded) !== JSON.stringify(listing.terms_superseded))
        .map(({ listing }) => `${read.label} ${JSON.stringify(read.args)}: ${listing.vendor}`),
    );
    assert.deepEqual([...new Set(unmarked)], []);
  });

  it("finds every pinned listing that has substitutes among the alternatives a peer's vendor read returns", () => {
    assert.ok(withSubstitutes.length > 0, "no pinned listing has a substitute; pin one that does");
    const printed = new Set(readsLabelled("peer").flatMap((read) => printedWithheld(read).map(({ listing }) => listing.vendor)));
    assert.deepEqual(withSubstitutes.filter((vendor) => !printed.has(vendor)), []);
  });

  for (const label of ["vendor", "query", "concise", "since", "compare", "track"]) {
    it(`finds every pinned listing in the ${label} reads, so their check is not vacuous`, () => {
      const printed = new Set(readsLabelled(label).flatMap((read) => printedWithheld(read).map(({ listing }) => listing.vendor)));
      assert.deepEqual(PINNED.filter((vendor) => !printed.has(vendor)), []);
    });
  }
});

describe("the search view prints the notice in place of a withheld listing's stored terms", () => {
  function assertNoticeShownFor(listing: Withheld, lines: string[]) {
    assert.ok(lines.some((line) => line.includes(squashed(listing.terms_superseded.notice))), `${listing.vendor}'s notice is not shown:\n${lines.join("\n")}`);
    assert.ok(!lines.some((line) => line.includes(storedOpening(listing))), `${listing.vendor}'s stored terms are shown`);
  }

  const pinnedListings = () => withheld.filter((listing) => PINNED.includes(listing.vendor));

  it("prints the notice on a withheld vendor's own card", () => {
    for (const read of readsLabelled("vendor")) {
      renderers[SEARCH_VIEW](read.args, read.result);
      assertNoticeShownFor(withheld.find((listing) => listing.vendor === read.args.vendor)!, linesShown());
    }
  });

  it("prints the notice for a withheld listing among another vendor's alternatives", () => {
    for (const read of readsLabelled("peer")) {
      const listing = pinnedListings().find((each) => read.result.alternatives.some((alternative: JsonObject) => alternative.vendor === each.vendor))!;
      const alternative = read.result.alternatives.find((each: JsonObject) => each.vendor === listing.vendor);
      renderers[SEARCH_VIEW](read.args, { ...read.result, alternatives: [alternative, ...read.result.alternatives.filter((each: JsonObject) => each !== alternative)] });
      assertNoticeShownFor(listing, linesShown());
    }
  });

  it("prints the notice in the search results, in both response formats", () => {
    for (const read of [...readsLabelled("query"), ...readsLabelled("concise")]) {
      renderers[SEARCH_VIEW](read.args, read.result);
      assertNoticeShownFor(withheld.find((listing) => listing.vendor === read.args.query)!, linesShown());
    }
  });
});
