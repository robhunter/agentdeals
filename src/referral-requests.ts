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

export function getRequestsByAgent(agentId: string): ReferralRequest[] {
  return loadRequests().filter(r => r.agent_id === agentId);
}

export function getRequestById(id: string): ReferralRequest | null {
  return loadRequests().find(r => r.id === id) ?? null;
}
