import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Agent } from "./types.js";
import { createDurableStore } from "./durable-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

const agentStore = createDurableStore<Agent>({
  name: "agents",
  property: "agents",
  filePath: () => AGENTS_PATH,
});

function loadAgents(): Agent[] {
  return agentStore.read();
}

function saveAgents(agents: Agent[]): void {
  agentStore.save(agents);
}

export function resetAgentsCache(): void {
  agentStore.reset();
}

export function agentRegistryReadable(): boolean {
  return agentStore.status().hydrated;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generateAgentId(): string {
  return `agent_${randomBytes(12).toString("hex")}`;
}

function generateApiKey(): string {
  return `agd_${randomBytes(32).toString("hex")}`;
}

export interface RegisterResult {
  agent: Agent;
  api_key?: string;
}

export function registerAgent(opts: {
  name: string;
  api_key?: boolean;
}): RegisterResult {
  if (Object.hasOwn(opts, "vestauth_public_key_url")) {
    throw new Error("vestauth_public_key_url is no longer accepted. Use API key authentication.");
  }

  const agents = loadAgents();

  if (agents.some(a => a.name.toLowerCase() === opts.name.toLowerCase())) {
    throw new Error(`Agent with name "${opts.name}" already exists`);
  }

  const id = generateAgentId();
  let apiKey: string | undefined;
  let apiKeyHash = "";

  if (opts.api_key !== false) {
    apiKey = generateApiKey();
    apiKeyHash = hashApiKey(apiKey);
  }

  const agent: Agent = {
    id,
    name: opts.name,
    api_key_hash: apiKeyHash,
    vestauth_public_key_url: null,
    x402_address: null,
    trust_tier: "new",
    status: "active",
    registered_at: new Date().toISOString(),
  };

  saveAgents([...agents, agent]);

  const result: RegisterResult = { agent };
  if (apiKey) result.api_key = apiKey;
  return result;
}

export function getAgentByApiKeyHash(hash: string): Agent | null {
  const agents = loadAgents();
  return agents.find(a => a.api_key_hash === hash && a.status === "active") ?? null;
}

export function getAgentById(id: string): Agent | null {
  const agents = loadAgents();
  return agents.find(a => a.id === id) ?? null;
}

export async function authenticateRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<Agent | null> {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const hash = hashApiKey(token);
      return getAgentByApiKeyHash(hash);
    }
  }

  return null;
}

export function updateAgentX402Address(agentId: string, x402Address: string | null): Agent {
  const agents = loadAgents();
  if (!agents.some(a => a.id === agentId)) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  const next = agents.map(a => (a.id === agentId ? { ...a, x402_address: x402Address } : a));
  saveAgents(next);
  return next.find(a => a.id === agentId)!;
}

export function updateAgentTrustTier(agentId: string, newTier: "new" | "verified" | "trusted"): Agent {
  const agents = loadAgents();
  if (!agents.some(a => a.id === agentId)) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  const next = agents.map(a => (a.id === agentId ? { ...a, trust_tier: newTier } : a));
  saveAgents(next);
  return next.find(a => a.id === agentId)!;
}
