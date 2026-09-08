export type ApiMethod = "GET" | "POST" | "DELETE";

export type ApiGroup = "product" | "meta" | "referral";

export interface ApiEndpoint {
  method: ApiMethod;
  path: string;
  desc: string;
  params: string;
  group: ApiGroup;
  request?: string;
  requiresParams?: true;
}

export interface ExampleSubjects {
  vendor: string;
  otherVendor: string;
  codedVendor: string;
}

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  { method: "GET", path: "/api/offers", desc: "Search and browse offers", params: "q, category, limit, offset", group: "product", request: "/api/offers?q=database" },
  { method: "GET", path: "/api/categories", desc: "List all categories with counts, what each name holds, and the other names answering the same question", params: "", group: "product" },
  { method: "GET", path: "/api/new", desc: "Recently added or updated offers", params: "days", group: "product", request: "/api/new?days=7" },
  { method: "GET", path: "/api/newest", desc: "Newest deals by verification date", params: "limit", group: "product", request: "/api/newest?limit=10" },
  { method: "GET", path: "/api/changes", desc: "Pricing and deal changes", params: "since, type, vendor, vendors, category, categories, limit, offset", group: "product", request: "/api/changes?since=2025-01-01" },
  { method: "GET", path: "/api/details/:vendor", desc: "Vendor detail with alternatives", params: "", group: "product", request: "/api/details/{vendor}" },
  { method: "GET", path: "/api/compare", desc: "Compare two vendors side by side", params: "a, b", group: "product", request: "/api/compare?a={vendor}&b={otherVendor}" , requiresParams: true },
  { method: "GET", path: "/api/audit-stack", desc: "Audit your infrastructure stack", params: "services", group: "product", request: "/api/audit-stack?services={vendor},{otherVendor}" , requiresParams: true },
  { method: "GET", path: "/api/vendor-risk/:vendor", desc: "Check vendor pricing risk", params: "", group: "product", request: "/api/vendor-risk/{vendor}" },
  { method: "GET", path: "/api/deadlines", desc: "Future-dated changes with countdown", params: "type", group: "product" },
  { method: "GET", path: "/api/ai-coding-pricing", desc: "AI coding tools pricing comparison data", params: "type (ide, cli, cloud-agent, app-builder)", group: "product" },
  { method: "GET", path: "/api/hosting-pricing", desc: "Cloud hosting & PaaS pricing comparison data", params: "type (traditional-paas, edge-serverless, full-featured, static-specialized)", group: "product" },
  { method: "GET", path: "/api/llm-pricing", desc: "LLM API pricing comparison data", params: "type (frontier, inference, open-source-host, specialized)", group: "product" },
  { method: "GET", path: "/api/startup-credits", desc: "Startup credits & programs comparison data", params: "type (cloud-infrastructure, fintech-banking, developer-tools, ai-tools)", group: "product" },
  { method: "GET", path: "/api/referral-programs", desc: "Developer tools with referral/affiliate programs", params: "category", group: "product" },
  { method: "GET", path: "/api/expiring", desc: "Get expiring deals", params: "days", group: "product", request: "/api/expiring?within_days=30" },
  { method: "GET", path: "/api/freshness", desc: "Data freshness metrics", params: "", group: "product" },
  { method: "GET", path: "/api/digest", desc: "Weekly pricing digest", params: "", group: "product" },
  { method: "GET", path: "/api/digest/weekly", desc: "Formatted weekly digest with multiple output formats", params: "format (json|markdown|html), limit, weeks_ago", group: "product", request: "/api/digest/weekly?format=markdown&weeks_ago=1" },
  { method: "GET", path: "/api/stack", desc: "Free-tier stack recommendation", params: "use_case, requirements", group: "product", request: "/api/stack?use_case=SaaS+app" , requiresParams: true },
  { method: "GET", path: "/api/costs", desc: "Estimate infrastructure costs", params: "services, scale", group: "product", request: "/api/costs?services={vendor},{otherVendor}" , requiresParams: true },
  { method: "GET", path: "/api/query-log", desc: "Recent request log", params: "limit", group: "product", request: "/api/query-log?limit=10" },
  { method: "GET", path: "/api/pageviews", desc: "Page view analytics", params: "path, period", group: "product" },
  { method: "GET", path: "/api/traffic", desc: "Traffic attributed by client class (AI agent / crawler / browser), with web-vs-MCP comparison", params: "", group: "product" },
  { method: "GET", path: "/api/stats", desc: "Service statistics", params: "", group: "product" },
  { method: "GET", path: "/api/feed", desc: "Atom feed of pricing changes", params: "", group: "product" },
  { method: "GET", path: "/api/openapi.json", desc: "OpenAPI 3.0 description of this API", params: "", group: "meta" },
  { method: "GET", path: "/api/docs", desc: "Browsable API reference", params: "", group: "meta" },
  { method: "POST", path: "/api/watchlist", desc: "Subscribe to vendor pricing changes via webhook", params: "vendor, webhook_url (body)", group: "product" },
  { method: "GET", path: "/api/watchlist", desc: "List active watchlist subscriptions", params: "webhook_url", group: "product" },
  { method: "GET", path: "/api/watchlist/:id", desc: "Get subscription status", params: "", group: "product", request: "/api/watchlist/{watchlistId}" },
  { method: "DELETE", path: "/api/watchlist/:id", desc: "Unsubscribe from vendor watch", params: "", group: "product" },
  { method: "GET", path: "/api/referral-codes", desc: "List all active referral codes (platform + marketplace)", params: "source (platform|agent), category", group: "referral" },
  { method: "GET", path: "/api/referral-codes/:vendor", desc: "Get best referral code for a specific vendor", params: "", group: "referral", request: "/api/referral-codes/{codedVendor}" },
  { method: "POST", path: "/api/referral-codes", desc: "Submit a marketplace referral code (agents only, auth required)", params: "vendor, code, referral_url (body) — Authorization: Bearer <api-key>", group: "referral" },
];

export function endpointsInGroups(groups: readonly ApiGroup[]): ApiEndpoint[] {
  return API_ENDPOINTS.filter((e) => groups.includes(e.group));
}

export function readableEndpoints(groups: readonly ApiGroup[]): ApiEndpoint[] {
  return endpointsInGroups(groups).filter((e) => e.method === "GET");
}

export function pickSubject(available: readonly string[], preferred: readonly string[], exclude: readonly string[] = []): string {
  const held = new Set(available);
  const barred = new Set(exclude);
  for (const name of preferred) {
    if (held.has(name) && !barred.has(name)) return name;
  }
  for (const name of available) {
    if (!barred.has(name)) return name;
  }
  return preferred[0] ?? "";
}

export const PREFERRED_EXAMPLE_VENDORS = ["Supabase", "Vercel", "Netlify", "Railway", "Render"] as const;

export const PREFERRED_EXAMPLE_COMPARISONS = ["Neon", "Render", "Railway", "Fly.io", "Vercel"] as const;

export function exampleSubjects(vendors: readonly string[], codedVendors: readonly string[]): ExampleSubjects {
  const vendor = pickSubject(vendors, PREFERRED_EXAMPLE_VENDORS);
  const otherVendor = pickSubject(vendors, PREFERRED_EXAMPLE_COMPARISONS, [vendor]);
  const codedVendor = codedVendors.length > 0 ? pickSubject(codedVendors, PREFERRED_EXAMPLE_VENDORS) : vendor;
  return { vendor, otherVendor, codedVendor };
}

export function exampleRequest(endpoint: ApiEndpoint, subjects: ExampleSubjects, watchlistId = "sub_example"): string {
  const template = endpoint.request ?? endpoint.path;
  return template
    .replace(/\{vendor\}/g, encodeURIComponent(subjects.vendor))
    .replace(/\{otherVendor\}/g, encodeURIComponent(subjects.otherVendor))
    .replace(/\{codedVendor\}/g, encodeURIComponent(subjects.codedVendor))
    .replace(/\{watchlistId\}/g, encodeURIComponent(watchlistId));
}

export function endpointHref(endpoint: ApiEndpoint, subjects: ExampleSubjects): string | null {
  if (endpoint.method !== "GET") return null;
  if (endpoint.path === "/api/watchlist/:id") return null;
  return exampleRequest(endpoint, subjects);
}

export function endpointPathHref(endpoint: ApiEndpoint, subjects: ExampleSubjects): string | null {
  if (endpointHref(endpoint, subjects) === null) return null;
  if (endpoint.requiresParams) return exampleRequest(endpoint, subjects);
  const codedRoute = endpoint.path === "/api/referral-codes/:vendor";
  return endpoint.path.replace(/:vendor/, encodeURIComponent(codedRoute ? subjects.codedVendor : subjects.vendor));
}

export function readableRequestLines(groups: readonly ApiGroup[], subjects: ExampleSubjects): string[] {
  return readableEndpoints(groups)
    .filter((e) => endpointHref(e, subjects) !== null)
    .map((e) => `GET ${exampleRequest(e, subjects)}`);
}

export function readableRequestCount(groups: readonly ApiGroup[], subjects: ExampleSubjects): number {
  return readableRequestLines(groups, subjects).length;
}

export const HOMEPAGE_GROUPS: readonly ApiGroup[] = ["product", "meta"];

export const DOCUMENTED_GROUPS: readonly ApiGroup[] = ["product", "referral"];
