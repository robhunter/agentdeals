import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDurableStore } from "./durable-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUESTS_PATH =
  process.env.AGENTDEALS_REFERRAL_REQUESTS_PATH ||
  path.join(__dirname, "..", "data", "referral_requests.json");

export interface ReferralRequest {
  id: string;
  agent_id: string;
  vendor: string;
  referral_code: string;
  referral_url: string;
  requested_at: string;
  conversion_id: string | null;
}

const requestStore = createDurableStore<ReferralRequest>({
  name: "referral_requests",
  property: "referral_requests",
  filePath: () => REQUESTS_PATH,
});

function loadRequests(): ReferralRequest[] {
  return requestStore.read();
}

function saveRequests(requests: ReferralRequest[]): void {
  requestStore.save(requests);
}

export function resetReferralRequestsCache(): void {
  requestStore.reset();
}

function generateRequestId(): string {
  return `rr_${randomBytes(16).toString("hex")}`;
}

/**
 * Log a referral request from an authenticated agent.
 */
export function logReferralRequest(opts: {
  agent_id: string;
  vendor: string;
  referral_code: string;
  referral_url: string;
}): ReferralRequest {
  const requests = loadRequests();
  const request: ReferralRequest = {
    id: generateRequestId(),
    agent_id: opts.agent_id,
    vendor: opts.vendor,
    referral_code: opts.referral_code,
    referral_url: opts.referral_url,
    requested_at: new Date().toISOString(),
    conversion_id: null,
  };
  saveRequests([...requests, request]);
  return request;
}

/**
 * Last-touch attribution: find the most recent agent that requested a referral
 * code for the given vendor within the lookback window.
 * Returns the agent_id or null if no match.
 */
export function attributeConversion(
  vendor: string,
  conversionDate: Date,
  lookbackDays: number = 90
): string | null {
  const requests = loadRequests();
  const cutoff = new Date(conversionDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const vendorLower = vendor.toLowerCase();

  // Filter to matching vendor within lookback window
  const eligible = requests.filter(r => {
    if (r.vendor.toLowerCase() !== vendorLower) return false;
    const requestedAt = new Date(r.requested_at);
    return requestedAt >= cutoff && requestedAt <= conversionDate;
  });

  if (eligible.length === 0) return null;

  // Last-touch: most recent request wins
  eligible.sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
  return eligible[0].agent_id;
}

/**
 * Get all referral requests for a specific agent.
 */
export function getRequestsByAgent(agentId: string): ReferralRequest[] {
  return loadRequests().filter(r => r.agent_id === agentId);
}

/**
 * Get a referral request by ID.
 */
export function getRequestById(id: string): ReferralRequest | null {
  return loadRequests().find(r => r.id === id) ?? null;
}

/**
 * Mark a referral request as converted by setting the conversion_id.
 */
export function markConversion(requestId: string, conversionId: string): boolean {
  const requests = loadRequests();
  if (!requests.some(r => r.id === requestId)) return false;
  saveRequests(requests.map(r => (r.id === requestId ? { ...r, conversion_id: conversionId } : r)));
  return true;
}
