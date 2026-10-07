import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Offer = import("../src/types.ts").Offer;
type PaymentProtocol = import("../src/types.ts").PaymentProtocol;

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));

export const SHIPPED_OFFERS: Offer[] = catalogue.offers;

function categoriesByListingCount(offers: readonly Offer[]): string[] {
  const counts = new Map<string, number>();
  for (const offer of offers) counts.set(offer.category, (counts.get(offer.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category]) => category);
}

export const [BUSIEST_CATEGORY, SECOND_BUSIEST_CATEGORY] = categoriesByListingCount(SHIPPED_OFFERS) as [string, string];

export const STATED_X402_COST = "$0.0137 per call";
export const UNSTATED_X402_COST = "$0.0249/request";
export const STATED_MPP_COST = "$0.0311 per session";
export const UNSOURCED_MPP_COST = "$0.0423/request";

function syntheticListing(vendor: string, category: string, payment_protocols: PaymentProtocol[]): Offer {
  return {
    vendor,
    category,
    description: "A synthetic API. Free plan: 100 requests a month.",
    tier: "Free",
    url: `https://${vendor.toLowerCase().replace(/\s+/g, "-")}.example/pricing`,
    tags: ["api"],
    verifiedDate: "2026-09-28",
    payment_protocols,
  };
}

function paidPerUse(listing: Offer): Offer {
  return { ...listing, tier: "Pay-per-use", description: "A synthetic API. Every request is paid." };
}

export const X402_WITH_A_STATED_COST = syntheticListing("Zqpay Stated", BUSIEST_CATEGORY, [
  {
    protocol: "x402",
    chain: "Zqchain",
    settlement: "Zqcoin",
    pricing_model: "per-request",
    example_cost: STATED_X402_COST,
    source_url: "https://zqpay-stated.example/docs/x402",
    source_quote: `Agents pay ${STATED_X402_COST} in Zqcoin on Zqchain over x402.`,
  },
]);

export const BOTH_WITH_AN_UNSTATED_X402_COST = syntheticListing("Zqpay Unstated", SECOND_BUSIEST_CATEGORY, [
  {
    protocol: "x402",
    settlement: "Zqcoin",
    pricing_model: "per-request",
    example_cost: UNSTATED_X402_COST,
    source_url: "https://zqpay-unstated.example/docs/x402",
    source_quote: "Agents pay per request in Zqcoin over x402.",
  },
  {
    protocol: "stripe-mpp",
    settlement: "Zqfiat",
    pricing_model: "per-session",
    example_cost: STATED_MPP_COST,
    source_url: "https://zqpay-unstated.example/docs/mpp",
    source_quote: `Sessions cost ${STATED_MPP_COST} through MPP.`,
  },
]);

export const MPP_WITHOUT_A_SOURCE = syntheticListing("Zqpay Unsourced", BUSIEST_CATEGORY, [
  { protocol: "stripe-mpp", settlement: "Zqfiat", pricing_model: "per-request", example_cost: UNSOURCED_MPP_COST },
]);

export const X402_WITHOUT_A_COST = paidPerUse(syntheticListing("Zqpay Costless", SECOND_BUSIEST_CATEGORY, [
  {
    protocol: "x402",
    chain: "Zqledger",
    pricing_model: "per-request",
    source_url: "https://zqpay-costless.example/docs/x402",
    source_quote: "Agents pay on Zqledger over x402.",
  },
]));

export const PAYMENT_LISTINGS: readonly Offer[] = [X402_WITH_A_STATED_COST, BOTH_WITH_AN_UNSTATED_X402_COST, MPP_WITHOUT_A_SOURCE, X402_WITHOUT_A_COST];

export function vendorsHolding(offers: readonly Offer[], protocol?: string): string[] {
  return offers
    .filter(offer => (offer.payment_protocols ?? []).some(entry => protocol === undefined || entry.protocol === protocol))
    .map(offer => offer.vendor)
    .sort();
}

function withoutPaymentProtocols(offer: Offer): Offer {
  const { payment_protocols: _shippedEntries, ...rest } = offer;
  return rest;
}

export function writeSyntheticCatalogue(): { indexPath: string; remove(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "payment-protocols-"));
  const indexPath = path.join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers: [...SHIPPED_OFFERS.map(withoutPaymentProtocols), ...PAYMENT_LISTINGS] }));
  return { indexPath, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function startServer(env: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

export async function json(base: string, route: string): Promise<any> {
  const response = await fetch(base + route);
  if (response.status !== 200) throw new Error(`${route} answered ${response.status}`);
  return response.json();
}

export async function page(base: string, route: string): Promise<string> {
  const response = await fetch(base + route);
  if (response.status !== 200) throw new Error(`${route} answered ${response.status}`);
  return response.text();
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'" };

export function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, entity => ENTITIES[entity]!).trim();
}

export function serviceRows(html: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const [row] of html.matchAll(/<tr>\s*<td>[\s\S]*?<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]!.trim());
    if (!cells[0]?.includes('class="vendor-link"')) continue;
    rows.set(textOf(cells[0]), cells.slice(1));
  }
  return rows;
}

export function serviceCards(html: string): Map<string, string> {
  const cards = new Map<string, string>();
  for (const [header] of html.matchAll(/<div class="service-header">[\s\S]*?<\/div>/g)) {
    const vendor = header.match(/class="vendor-link"[^>]*>([^<]*)</)?.[1];
    if (vendor !== undefined) cards.set(textOf(vendor), header);
  }
  return cards;
}

function jsonLdBlocks(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]!));
}

export function faqAnswers(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const block of jsonLdBlocks(html).filter(candidate => candidate["@type"] === "FAQPage")) {
    for (const question of block.mainEntity) answers.set(question.name, question.acceptedAnswer.text);
  }
  return answers;
}

export function descriptionsOf(html: string): string[] {
  const metas = [...html.matchAll(/<meta (?:name="description"|property="og:description") content="([^"]*)"/g)].map(match => textOf(match[1]!));
  const structured = jsonLdBlocks(html).filter(block => typeof block.description === "string").map(block => block.description as string);
  return [...metas, ...structured];
}

export function catalogueVendorsNamedIn(text: string, protocolNames: readonly string[]): string[] {
  const withoutProtocolNames = protocolNames.reduce((rest, name) => rest.split(name).join(" "), text);
  return [...new Set(SHIPPED_OFFERS.map(offer => offer.vendor))].filter(vendor =>
    new RegExp(`(?<![\\w-])${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(withoutProtocolNames));
}

export function servedVendors(offers: ReadonlyArray<{ vendor: string }>): string[] {
  return offers.map(offer => offer.vendor).sort();
}

function parseEventStream(text: string): any[] {
  return text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}

export async function mcpToolTexts(base: string, calls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>): Promise<string[][]> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "payment-protocols", version: "1" } } }),
  });
  await initialized.text();
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  await (await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const answers: string[][] = [];
  for (const [index, call] of calls.entries()) {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: call }) });
    const [message] = parseEventStream(await response.text());
    answers.push((message?.result?.content ?? []).filter((content: any) => content.type === "text").map((content: any) => content.text));
  }
  return answers;
}
