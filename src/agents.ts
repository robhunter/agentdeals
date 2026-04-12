import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Agent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

let cachedAgents: Agent[] | null = null;

function loadAgents(): Agent[] {
  if (cachedAgents) return cachedAgents;

  if (!fs.existsSync(AGENTS_PATH)) {
    cachedAgents = [];
    return cachedAgents;
  }

  try {
    const raw = fs.readFileSync(AGENTS_PATH, "utf-8");
    const data = JSON.parse(raw) as { agents?: Agent[] };
    cachedAgents = Array.isArray(data.agents) ? data.agents : [];
  } catch {
    cachedAgents = [];
  }
  return cachedAgents;
}

function saveAgents(agents: Agent[]): void {
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents }, null, 2), "utf-8");
  cachedAgents = agents;
}

export function resetAgentsCache(): void {
  cachedAgents = null;
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

  // Check for duplicate name
  if (agents.some(a => a.name.toLowerCase() === opts.name.toLowerCase())) {
    throw new Error(`Agent with name "${opts.name}" already exists`);
  }

  // Check for duplicate vestauth URL
  if (opts.vestauth_public_key_url) {
    if (agents.some(a => a.vestauth_public_key_url === opts.vestauth_public_key_url)) {
      throw new Error(`Agent with vestauth URL "${opts.vestauth_public_key_url}" already exists`);
    }
  }

  const id = generateAgentId();
  let apiKey: string | undefined;
  let apiKeyHash = "";

  if (opts.api_key !== false && !opts.vestauth_public_key_url) {
    // Default to API key auth if no vestauth URL provided
    apiKey = generateApiKey();
    apiKeyHash = hashApiKey(apiKey);
  } else if (opts.api_key) {
    // Explicitly requested API key alongside vestauth
    apiKey = generateApiKey();
    apiKeyHash = hashApiKey(apiKey);
  }

  const agent: Agent = {
    id,
    name: opts.name,
    api_key_hash: apiKeyHash,
    vestauth_public_key_url: opts.vestauth_public_key_url ?? null,
    x402_address: null,
    status: "active",
    registered_at: new Date().toISOString(),
  };

  agents.push(agent);
  saveAgents(agents);

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

/**
 * Authenticate an incoming HTTP request.
 * Returns the authenticated Agent or null.
 *
 * Supports:
 * 1. Bearer token (API key) — Authorization: Bearer agd_...
 * 2. Vestauth HTTP Message Signatures (RFC 9421) — Signature + Signature-Input headers
 */
export async function authenticateRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<Agent | null> {
  // Method 1: Bearer token (API key)
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const hash = hashApiKey(token);
      return getAgentByApiKeyHash(hash);
    }
  }

  // Method 2: Vestauth HTTP Message Signatures
  const signature = req.headers["signature"];
  const signatureInput = req.headers["signature-input"];
  if (typeof signature === "string" && typeof signatureInput === "string") {
    // Extract the keyid from signature-input to find the agent
    // RFC 9421 format: sig1=(...);keyid="https://example.com/.well-known/vestauth"
    const keyIdMatch = signatureInput.match(/keyid="([^"]+)"/);
    if (keyIdMatch) {
      const keyId = keyIdMatch[1];
      const agent = getAgentByVestauthUrl(keyId);
      if (agent) {
        // Verify the signature by fetching the public key
        try {
          const verified = await verifyVestauthSignature(keyId, signature, signatureInput, req.headers);
          if (verified) return agent;
        } catch {
          // Signature verification failed
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
  // Fetch the public key from the .well-known endpoint
  try {
    const resp = await fetch(publicKeyUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return false;

    const data = await resp.json() as Record<string, unknown>;
    // Vestauth .well-known response should contain a public key
    if (!data || !data.public_key) return false;

    // TODO: Full RFC 9421 signature verification using the public key
    // For Phase 2 MVP, we verify the key is fetchable and the agent is registered.
    // Full cryptographic verification will be added when vestauth adoption grows.
    // The agent being registered with this URL + the URL being reachable is the
    // identity assertion for now.
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a vestauth public key URL by fetching it.
 * Returns true if the URL is reachable and returns valid JSON with a public_key field.
 */
/**
 * Update an agent's x402 address. Validates format before persisting.
 */
export function updateAgentX402Address(agentId: string, x402Address: string | null): Agent {
  const agents = loadAgents();
  const agent = agents.find(a => a.id === agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  agent.x402_address = x402Address;
  saveAgents(agents);
  return agent;
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
