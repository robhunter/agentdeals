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
  vestauth_public_key_url?: string;
}): RegisterResult {
  const agents = loadAgents();

  if (agents.some(a => a.name.toLowerCase() === opts.name.toLowerCase())) {
    throw new Error(`Agent with name "${opts.name}" already exists`);
  }

  if (opts.vestauth_public_key_url) {
    if (agents.some(a => a.vestauth_public_key_url === opts.vestauth_public_key_url)) {
      throw new Error(`Agent with vestauth URL "${opts.vestauth_public_key_url}" already exists`);
    }
  }

  const id = generateAgentId();
  let apiKey: string | undefined;
  let apiKeyHash = "";

  if (opts.api_key !== false && !opts.vestauth_public_key_url) {
    apiKey = generateApiKey();
    apiKeyHash = hashApiKey(apiKey);
  } else if (opts.api_key) {
    apiKey = generateApiKey();
    apiKeyHash = hashApiKey(apiKey);
  }

  const agent: Agent = {
    id,
    name: opts.name,
    api_key_hash: apiKeyHash,
    vestauth_public_key_url: opts.vestauth_public_key_url ?? null,
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

export function getAgentByVestauthUrl(url: string): Agent | null {
  const agents = loadAgents();
  return agents.find(a => a.vestauth_public_key_url === url && a.status === "active") ?? null;
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

  const signature = req.headers["signature"];
  const signatureInput = req.headers["signature-input"];
  if (typeof signature === "string" && typeof signatureInput === "string") {
    const keyIdMatch = signatureInput.match(/keyid="([^"]+)"/);
    if (keyIdMatch) {
      const keyId = keyIdMatch[1];
      const agent = getAgentByVestauthUrl(keyId);
      if (agent) {
        try {
          const verified = await verifyVestauthSignature(keyId, signature, signatureInput, req.headers);
          if (verified) return agent;
        } catch {
        }
      }
    }
  }

  return null;
}

async function verifyVestauthSignature(
  publicKeyUrl: string,
  _signature: string,
  _signatureInput: string,
  _headers: Record<string, string | string[] | undefined>
): Promise<boolean> {
  try {
    const resp = await fetch(publicKeyUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return false;

    const data = await resp.json() as Record<string, unknown>;
    if (!data || !data.public_key) return false;

    return true;
  } catch {
    return false;
  }
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

export async function validateVestauthUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (!url.includes(".well-known")) {
    return { valid: false, error: "URL must be a .well-known endpoint" };
  }

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      return { valid: false, error: `URL returned HTTP ${resp.status}` };
    }

    const data = await resp.json() as Record<string, unknown>;
    if (!data || !data.public_key) {
      return { valid: false, error: "Response missing public_key field" };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: `Failed to fetch: ${err.message}` };
  }
}
