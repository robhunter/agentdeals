import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { startLocalApi, startStdioServerAgainst, type LocalApi } from "./local-api.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATION_GUIDES = ["/guides/langchain", "/guides/crewai", "/guides/n8n", "/guides/vercel-ai-sdk"];
const PAGES_READ_WHOLE = ["/developers", "/setup", ...INTEGRATION_GUIDES];
const PAGES_READ_WHERE_THEY_NAME_THE_TOOL = ["/", "/estimate", "/llms.txt", "/llms-full.txt"];
const NAMES_THE_TOOL = /plan_stack|\/api\/costs/;
const PLAN_STACK_CARD = "Get stack recommendations, free-tier checks, or a full infrastructure audit for your project.";

const STATED: Record<string, string[]> = {
  "/": [PLAN_STACK_CARD],
  "/developers": [
    "Stack Planning & Free Tier Coverage",
    "Use /api/stack to get free-tier recommendations for your use case, then /api/costs to check free tier coverage.",
    "GET /api/costs Check free tier coverage per service",
  ],
  "/llms-full.txt": ["GET /api/costs — Free tier coverage only, not paid usage (params: services, scale)"],
  "/llms.txt": ["Checks free tier coverage and audits existing stacks."],
  "/setup": ["> Check free-tier status for a SaaS backend. Stack recommendations, free-tier checks, and audits."],
  "/guides/langchain": [PLAN_STACK_CARD, "Get stack recommendations with free tier coverage.", "database, auth, email, and monitoring. Check free tier coverage."],
  "/guides/crewai": [PLAN_STACK_CARD],
  "/guides/n8n": [
    PLAN_STACK_CARD,
    "Stack free tier coverage check Check free tier coverage for vendors and email results to stakeholders.",
    "\"query\": \"Check which of these services are free-tier: Vercel, Neon, Clerk, Resend, Sentry.\"",
  ],
  "/guides/vercel-ai-sdk": [PLAN_STACK_CARD, "show the free tier limits, risk level, and free tier coverage."],
  "/estimate": ["Use plan_stack to get AI-powered stack recommendations with free tier coverage directly in your editor."],
};

const WITHDRAWN: Record<string, RegExp> = {
  "an estimate of costs": /\bestimat\w* (?:infrastructure |monthly )?costs?\b/i,
  "cost estimation or cost estimates": /\bcost estimat(?:ion|es?)\b/i,
  "cost analysis or cost projections at a scale": /\bcost (?:analysis|projections?) at\b/i,
  "estimate mode described as cost analysis": /\bestimate: cost\b/i,
  "an estimated cost at a user count": /\bestimated cost at\b/i,
  "what happens at scale": /\bestimate what happens\b/i,
  "a stack cost report": /\bstack cost report\b/i,
};

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&nbsp;/g, " ");
}

function squeezed(text: string): string {
  return text.replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

function passagesOf(body: string, isMarkup: boolean): string[] {
  if (!isMarkup) return body.split("\n").map(squeezed).filter(Boolean);
  const blocks = body
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/<\/(?:p|li|div|h\d|td|tr|pre|section|article)>|<br\s*\/?>/g, "\n");
  return decode(blocks.replace(/<[^>]+>/g, " ")).split("\n").map(squeezed).filter(Boolean);
}

function withdrawnClaimsIn(surface: string, text: string): string[] {
  return Object.entries(WITHDRAWN)
    .filter(([, pattern]) => pattern.test(text))
    .map(([claim, pattern]) => `${surface} states ${claim}: "${text.match(pattern)![0]}"`);
}

function stdioToolsList(api: LocalApi): Promise<any[]> {
  const child: ChildProcess = startStdioServerAgainst(api);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("the stdio server did not answer tools/list within 20 seconds")); }, 20000);
    let printed = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
      for (const line of printed.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== 2) continue;
        clearTimeout(timer);
        child.kill();
        resolve(message.result.tools);
        return;
      }
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cost-check-copy", version: "1.0" } } }) + "\n");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
}

async function httpMcp(base: string): Promise<{ instructions: string; tools: any[] }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const call = async (body: object) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    const session = response.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    const raw = await response.text();
    return raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  };
  const [initialized] = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cost-check-copy", version: "1.0" } } });
  await call({ jsonrpc: "2.0", method: "notifications/initialized" });
  const [listed] = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  return { instructions: initialized.result.instructions, tools: listed.result.tools };
}

const planStackIn = (tools: any[]) => tools.find((tool) => tool.name === "plan_stack");

let api: LocalApi;
const passages = new Map<string, string[]>();

describe("every description of the cost check says it covers free tiers, not paid usage", () => {
  before(async () => {
    api = await startLocalApi();
    for (const page of [...PAGES_READ_WHOLE, ...PAGES_READ_WHERE_THEY_NAME_THE_TOOL]) {
      const response = await fetch(`${api.url}${page}`);
      assert.equal(response.status, 200, `${page} answered ${response.status}`);
      passages.set(page, passagesOf(await response.text(), !page.endsWith(".txt")));
    }
  });
  after(() => { api?.stop(); });

  it("pages state the free-tier wording where they describe the check", () => {
    const missing = Object.entries(STATED).flatMap(([page, sentences]) => {
      const text = passages.get(page)!.join(" ");
      return sentences.filter((sentence) => !text.includes(sentence)).map((sentence) => `${page} lacks "${sentence}"`);
    });
    assert.deepEqual(missing, []);
  });

  it("no page describing the check promises a cost estimate", () => {
    const found = PAGES_READ_WHOLE.flatMap((page) => withdrawnClaimsIn(page, passages.get(page)!.join(" ")));
    for (const page of PAGES_READ_WHERE_THEY_NAME_THE_TOOL) {
      const naming = passages.get(page)!.filter((passage) => NAMES_THE_TOOL.test(passage));
      assert.ok(naming.length > 0, `${page} has no passage naming plan_stack or /api/costs, so this check would read nothing there`);
      found.push(...naming.flatMap((passage) => withdrawnClaimsIn(page, passage)));
    }
    assert.deepEqual(found, []);
  });

  it("both MCP transports, the instructions and the server card describe estimate mode as a free-tier status check", async () => {
    const http = await httpMcp(api.url);
    const stdioPlanStack = planStackIn(await stdioToolsList(api));
    const httpPlanStack = planStackIn(http.tools);
    const card = await (await fetch(`${api.url}/.well-known/mcp.json`)).json();
    const cardPlanStack = planStackIn(card.tools);

    assert.match(http.instructions, /free-tier status check \(`mode="estimate"`\)/);
    for (const [transport, tool] of [["HTTP", httpPlanStack], ["stdio", stdioPlanStack], ["server card", cardPlanStack]] as const) {
      assert.match(tool.inputSchema.properties.mode.description, /\bestimate: free-tier status check\./, `${transport} plan_stack mode`);
      assert.match(tool.inputSchema.properties.scale.description, /^Scale for free-tier status check\b/, `${transport} plan_stack scale`);
    }
    assert.match(stdioPlanStack.description, /^Get stack recommendations, free-tier checks, or a full infrastructure audit\. .*pass your current services to check free-tier status and find risks\./);
    assert.match(cardPlanStack.description, /Recommends services, checks free-tier status, or audits existing stacks\./);
    assert.match(card.description, /intent-based MCP tools for infrastructure decisions, free-tier status check, and vendor comparison\./);

    const found = [
      ...withdrawnClaimsIn("the MCP instructions", http.instructions),
      ...withdrawnClaimsIn("HTTP plan_stack", JSON.stringify(httpPlanStack)),
      ...withdrawnClaimsIn("stdio plan_stack", JSON.stringify(stdioPlanStack)),
      ...withdrawnClaimsIn("the server card's plan_stack", JSON.stringify(cardPlanStack)),
      ...withdrawnClaimsIn("the server card", card.description),
    ];
    assert.deepEqual(found, []);
  });

  it("the OpenAPI document summarises /api/costs as free tier coverage only", async () => {
    const { summary, description } = (await (await fetch(`${api.url}/openapi.json`)).json()).paths["/api/costs"].get;
    assert.equal(summary, "Check free tier coverage per service");
    assert.equal(description, "Free tier coverage only, not paid usage.");
  });

  it("the files we publish with the package promise no cost estimate", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "manifest.json"), "utf8"));
    const glama = JSON.parse(readFileSync(path.join(REPO, "glama.json"), "utf8"));
    const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
    assert.match(readme, /# Check free tier coverage per service\ncurl "https:\/\/agentdeals\.dev\/api\/costs\?services=Vercel,Supabase"\n/);
    const found = [
      ...withdrawnClaimsIn("manifest.json's description", manifest.description),
      ...withdrawnClaimsIn("manifest.json's long_description", manifest.long_description),
      ...withdrawnClaimsIn("manifest.json's plan_stack", JSON.stringify(planStackIn(manifest.tools))),
      ...withdrawnClaimsIn("glama.json", glama.description),
      ...["README.md", "SKILL.md", "AGENTS.md"].flatMap((file) => withdrawnClaimsIn(file, readFileSync(path.join(REPO, file), "utf8"))),
    ];
    assert.deepEqual(found, []);
  });
});
