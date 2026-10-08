import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startLocalApi, type LocalApi } from "./local-api.ts";

const PLAN_STACK_VIEW = "ui://agentdeals/plan-stack";

let api: LocalApi;
const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let renderView: (args: unknown, data: unknown) => void;
const shown = { innerHTML: "" };
let nextId = 10;

async function rpc(message: object): Promise<any[]> {
  const response = await fetch(`${api.url}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  const session = response.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
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

async function planStack(args: Record<string, unknown>): Promise<any> {
  const [call] = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "plan_stack", arguments: args } });
  const result = JSON.parse(call.result.content[0].text);
  renderView(args, result);
  return result;
}

before(async () => {
  api = await startLocalApi();
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plan-stack-view-test", version: "1" } } });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const [read] = await rpc({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: PLAN_STACK_VIEW } });
  const script = read.result.contents[0].text.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const afterConnect = script.slice(script.indexOf("await app.connect();") + "await app.connect();".length);
  renderView = new Function("document", `${afterConnect}\nreturn render;`)(documentStub);
});

after(() => { api?.stop(); });

describe("the plan_stack MCP App view prints the fields the tool returns", () => {
  it("gives each service's free tier limits and monthly cost, and the total, as the estimate states them", async () => {
    const result = await planStack({ mode: "estimate", services: ["OpenAI", "Neon", "phare.io"] });
    const lines = linesShown();
    assert.equal(result.services.length, 3);
    for (const service of result.services) {
      assert.ok(lines.includes(squashed(`${service.vendor} ${service.free_tier_limits} ${service.estimated_monthly_cost}`)), service.vendor);
    }
    assert.ok(lines.includes(squashed(`Total ${result.total_estimated_cost}`)), lines.join("\n"));
  });

  it("names each role's candidates with the tie they are drawn from, and the stack's monthly cost", async () => {
    const result = await planStack({ mode: "recommend", use_case: "API backend" });
    const lines = linesShown();
    assert.ok(result.stack.length > 0);
    for (const role of result.stack) {
      const at = lines.indexOf(squashed(`${role.role} ${role.category}`));
      assert.ok(at > -1, role.role);
      assert.equal(lines[at + 1], role.candidates.map((candidate: { vendor: string }) => candidate.vendor).join(" , "));
      assert.match(lines[at + 2], /^\d+ (of \d+ equally-qualified options, rotated daily|options?)$/);
    }
    assert.ok(lines.includes(squashed(`Monthly cost ${result.total_monthly_cost}`)), lines.join("\n"));
    assert.ok(!lines.includes("Stack Analysis"), "the view does not fall back to printing the raw result");
  });

  it("flags each caution or risky service with the cause the audit gives, and lists the gaps by category alone", async () => {
    const result = await planStack({ mode: "audit", services: ["Render", "CockroachDB", "Vercel"] });
    const lines = linesShown();
    const flagged = result.services.filter((service: { risk_level?: string }) => service.risk_level === "caution" || service.risk_level === "risky");
    assert.ok(flagged.length > 0, "the audit read holds no flagged service to show");
    for (const service of flagged) {
      assert.ok(lines.includes(squashed(`${service.risk_level} ${service.vendor} : ${service.risk_cause.summary}`)), service.vendor);
    }
    const gapsFrom = lines.indexOf("Coverage Gaps") + 1;
    assert.ok(gapsFrom > 0 && result.gaps.length > 0);
    assert.deepEqual(lines.slice(gapsFrom, gapsFrom + result.gaps.length), result.gaps.map((gap: { category: string }) => gap.category));
    assert.ok(lines[gapsFrom + result.gaps.length].startsWith("View full risk index"), lines.slice(gapsFrom).join("\n"));
  });
});
