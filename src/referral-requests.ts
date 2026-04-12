import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");

export interface ReferralRequest {
  id: string;
  agent_id: string;
  vendor: string;
  referral_code: string;
  referral_url: string;
  requested_at: string;
  conversion_id: string | null;
}

let cachedRequests: ReferralRequest[] | null = null;

function loadRequests(): ReferralRequest[] {
  if (cachedRequests) return cachedRequests;

  if (!fs.existsSync(REQUESTS_PATH)) {
    cachedRequests = [];
    return cachedRequests;
  }

  try {
    const raw = fs.readFileSync(REQUESTS_PATH, "utf-8");
    const data = JSON.parse(raw) as { referral_requests?: ReferralRequest[] };
    cachedRequests = Array.isArray(data.referral_requests) ? data.referral_requests : [];
  } catch {
    cachedRequests = [];
  }
  return cachedRequests;
}

function saveRequests(requests: ReferralRequest[]): void {
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: requests }, null, 2), "utf-8");
  cachedRequests = requests;
}

export function resetReferralRequestsCache(): void {
  cachedRequests = null;
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
  requests.push(request);
  saveRequests(requests);
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
  const request = requests.find(r => r.id === requestId);
  if (!request) return false;
  request.conversion_id = conversionId;
  saveRequests(requests);
  return true;
}
