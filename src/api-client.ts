const DEFAULT_BASE_URL = "https://agentdeals-production.up.railway.app";
const TIMEOUT_MS = 10_000;

export function getBaseUrl(): string {
  return process.env.AGENTDEALS_API_URL || DEFAULT_BASE_URL;
}

async function apiFetch(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(path, getBaseUrl());
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error("AgentDeals API request timed out after 10 seconds. Try again later.");
    }
    throw new Error(
      `AgentDeals API is unreachable. Check your network connection or try again later. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    throw new Error(`AgentDeals API error (${res.status}): ${body || res.statusText}`);
  }

  return res.json();
}

export async function fetchCategories(): Promise<unknown> {
  const data = await apiFetch("/api/categories") as { categories: unknown };
  return data.categories;
}

export async function fetchOffers(params: {
  q?: string;
  category?: string;
  eligibility_type?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}): Promise<unknown> {
  const p: Record<string, string> = {};
  if (params.q) p.q = params.q;
  if (params.category) p.category = params.category;
  if (params.eligibility_type) p.eligibility_type = params.eligibility_type;
  if (params.sort) p.sort = params.sort;
  if (params.limit !== undefined) p.limit = String(params.limit);
  if (params.offset !== undefined) p.offset = String(params.offset);
  return apiFetch("/api/offers", p);
}

export async function fetchOfferDetails(vendor: string, alternatives?: boolean): Promise<unknown> {
  const p: Record<string, string> = {};
  if (alternatives) p.alternatives = "true";
  return apiFetch(`/api/details/${encodeURIComponent(vendor)}`, p);
}

export async function fetchNewOffers(days?: number): Promise<unknown> {
  const p: Record<string, string> = {};
  if (days !== undefined) p.days = String(days);
  return apiFetch("/api/new", p);
}

export async function fetchDealChanges(params: {
  since?: string;
  type?: string;
  vendor?: string;
}): Promise<unknown> {
  const p: Record<string, string> = {};
  if (params.since) p.since = params.since;
  if (params.type) p.type = params.type;
  if (params.vendor) p.vendor = params.vendor;
  return apiFetch("/api/changes", p);
}

export async function fetchStackRecommendation(useCase: string, requirements?: string[]): Promise<unknown> {
  const p: Record<string, string> = { use_case: useCase };
  if (requirements && requirements.length > 0) p.requirements = requirements.join(",");
  return apiFetch("/api/stack", p);
}

export async function fetchCosts(services: string[], scale?: string): Promise<unknown> {
  const p: Record<string, string> = { services: services.join(",") };
  if (scale) p.scale = scale;
  return apiFetch("/api/costs", p);
}

export async function fetchCompare(vendorA: string, vendorB: string): Promise<unknown> {
  return apiFetch("/api/compare", { a: vendorA, b: vendorB });
}

export async function fetchVendorRisk(vendor: string): Promise<unknown> {
  return apiFetch(`/api/vendor-risk/${encodeURIComponent(vendor)}`);
}

export async function fetchAuditStack(services: string[]): Promise<unknown> {
  return apiFetch("/api/audit-stack", { services: services.join(",") });
}

export async function fetchNewestDeals(params: {
  since?: string;
  limit?: number;
  category?: string;
}): Promise<unknown> {
  const p: Record<string, string> = {};
  if (params.since) p.since = params.since;
  if (params.limit !== undefined) p.limit = String(params.limit);
  if (params.category) p.category = params.category;
  return apiFetch("/api/newest", p);
}

export async function fetchExpiringDeals(withinDays?: number): Promise<unknown> {
  const p: Record<string, string> = {};
  if (withinDays !== undefined) p.within_days = String(withinDays);
  return apiFetch("/api/expiring", p);
}
