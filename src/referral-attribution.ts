import { agentRegistryReadable, getAgentByApiKeyHash, hashApiKey } from "./agents.js";
import { logReferralRequest } from "./referral-requests.js";
import { persistDurableStores } from "./durable-store.js";
import type { Agent } from "./types.js";

export type AttributionStatus =
  | "attributed"
  | "no_key"
  | "key_not_recognised"
  | "registry_unavailable"
  | "not_recorded";

export interface AttributionOutcome {
  status: AttributionStatus;
  note: string;
}

export interface AttributableReferral {
  vendor: string;
  referral: { code?: string | null; url: string };
}

export const ATTRIBUTION_NOTES: Record<AttributionStatus, string> = {
  attributed:
    "Recorded against your agent. Requesting a code does not itself earn a share of a commission — a commission is credited to the agent that submitted the code it was reported against.",
  no_key: "No API key was supplied, so this request was not attributed to any agent.",
  key_not_recognised:
    "This API key is not in the agent registry, so nothing was attributed. Register again with register_agent to get a key that resolves.",
  registry_unavailable:
    "The agent registry could not be read, so this request was not attributed. Your key may still be valid — retry later.",
  not_recorded:
    "Your key was recognised, but the request could not be stored, so it was not recorded against your agent.",
};

function outcome(status: AttributionStatus): AttributionOutcome {
  return { status, note: ATTRIBUTION_NOTES[status] };
}

export function hasAuthCredential(headers: Record<string, string | string[] | undefined>): boolean {
  const authHeader = headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ") && authHeader.slice(7).trim()) {
    return true;
  }
  return typeof headers["signature"] === "string" && typeof headers["signature-input"] === "string";
}

export async function recordAttribution(
  agent: Agent,
  referral: AttributableReferral,
): Promise<AttributionOutcome> {
  logReferralRequest({
    agent_id: agent.id,
    vendor: referral.vendor,
    referral_code: referral.referral.code ?? "",
    referral_url: referral.referral.url,
  });
  const persisted = await persistDurableStores();
  return outcome(persisted.ok ? "attributed" : "not_recorded");
}

export async function attributeByApiKey(
  apiKey: string | undefined,
  referral: AttributableReferral,
): Promise<AttributionOutcome> {
  if (!apiKey) return outcome("no_key");
  if (!agentRegistryReadable()) return outcome("registry_unavailable");
  const agent = getAgentByApiKeyHash(hashApiKey(apiKey));
  if (!agent) return outcome("key_not_recognised");
  return recordAttribution(agent, referral);
}

export async function attributeAuthenticatedRequest(
  agent: Agent | null,
  headers: Record<string, string | string[] | undefined>,
  referral: AttributableReferral,
): Promise<AttributionOutcome> {
  if (agent) return recordAttribution(agent, referral);
  if (!hasAuthCredential(headers)) return outcome("no_key");
  if (!agentRegistryReadable()) return outcome("registry_unavailable");
  return outcome("key_not_recognised");
}
