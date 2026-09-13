import { PACKAGE_MANIFEST, PKG_VERSION, REPOSITORY_URL } from "./package-version.js";
import { loadOffers, loadDealChanges, getCategories } from "./data.js";
import { recordsStillInForce } from "./change-resolution.js";
import { MCP_TOOLS, MCP_PROTOCOL_VERSION } from "./mcp-tool-inventory.js";
import { CRITERIA_PATH } from "./ranking.js";
import { openapiSpec } from "./openapi.js";

export const AGENT_CARD_PATHS = [
  "/.well-known/agent.json",
  "/.well-known/agent-card.json",
  "/.well-known/agents.json",
  "/.well-known/agent",
  "/agents.json",
  "/agent-directory.json",
] as const;

export const OPENAPI_ALIAS_PATHS = ["/openapi.json", "/swagger.json"] as const;

export const OPENAPI_YAML_PATH = "/openapi.yaml";

export const OPENAPI_CANONICAL_PATH = "/api/openapi.json";

export const A2A_REQUIRED_INTERFACE_FIELDS = ["url", "protocol_binding", "protocol_version"] as const;

export const WHY_NO_A2A_AGENT_CARD =
  "AgentDeals is not an A2A agent. An A2A AgentCard requires at least one supported interface, and every interface must state a url, a protocol_binding and a protocol_version naming the version of A2A that url exposes. No url here exposes any version of A2A, so no truthful AgentCard exists for this service. This document describes what we do answer on instead, and declares no endpoint we do not serve.";

export interface CatalogueFigures {
  offers: number;
  categories: number;
  vendors: number;
  changes_tracked: number;
  verified_through: string;
}

export function catalogueFigures(): CatalogueFigures {
  const offers = loadOffers();
  const dates = offers.map((o) => o.verifiedDate).filter(Boolean).sort();
  return {
    offers: offers.length,
    categories: getCategories().length,
    vendors: new Set(offers.map((o) => o.vendor)).size,
    changes_tracked: recordsStillInForce(loadDealChanges()).length,
    verified_through: dates[dates.length - 1] ?? "",
  };
}

export interface ServiceDescriptionInput {
  baseUrl: string;
  version: string;
  license: { name: string; url: string };
  repositoryUrl: string;
  catalogue: CatalogueFigures;
  tools: readonly { name: string; brief: string }[];
}

export function buildServiceDescription(input: ServiceDescriptionInput) {
  const { baseUrl, catalogue } = input;
  return {
    document_type: "service-description",
    name: "AgentDeals",
    description: `An index of ${catalogue.offers} verified free tiers, startup credits and developer-tool discounts across ${catalogue.categories} categories, answered over MCP and a JSON HTTP API.`,
    version: input.version,
    homepage: baseUrl,
    documentation_url: `${baseUrl}/setup`,
    a2a: {
      supported: false,
      required_interface_fields: [...A2A_REQUIRED_INTERFACE_FIELDS],
      reason: WHY_NO_A2A_AGENT_CARD,
      what_we_serve_instead: `${baseUrl}/.well-known/mcp.json`,
    },
    interfaces: [
      {
        protocol: "MCP",
        protocol_version: MCP_PROTOCOL_VERSION,
        transport: "streamable-http",
        url: `${baseUrl}/mcp`,
        description_url: `${baseUrl}/.well-known/mcp.json`,
        documentation_url: `${baseUrl}/setup`,
        authentication: "none",
      },
      {
        protocol: "HTTP+JSON",
        url: `${baseUrl}/api/offers`,
        description_url: `${baseUrl}${OPENAPI_ALIAS_PATHS[0]}`,
        documentation_url: `${baseUrl}/developers`,
        authentication: "none",
      },
    ],
    tools: input.tools.map((t) => ({ name: t.name, description: t.brief })),
    catalogue,
    data: {
      license: input.license.name,
      license_url: input.license.url,
      terms_url: `${baseUrl}/developers`,
      attribution: "Every response carrying index data includes a _provenance object holding the page that publishes it and the oldest verification date behind it. If you use a figure, cite those two fields.",
    },
    ranking: {
      paid_placement: false,
      method_url: `${baseUrl}${CRITERIA_PATH}`,
      summary: "Offers start level and are only ever demoted, on a recorded fact with a date. No placement is for sale.",
    },
    contact: {
      homepage: baseUrl,
      repository: input.repositoryUrl,
      issues: `${input.repositoryUrl}/issues`,
    },
    discovery: {
      service_description: `${baseUrl}${AGENT_CARD_PATHS[0]}`,
      mcp_card: `${baseUrl}/.well-known/mcp.json`,
      openapi: `${baseUrl}${OPENAPI_ALIAS_PATHS[0]}`,
      llms_txt: `${baseUrl}/llms.txt`,
      sitemap: `${baseUrl}/sitemap.xml`,
    },
  };
}

export function serviceDescription(baseUrl: string) {
  const license = (openapiSpec as { info: { license: { name: string; url: string } } }).info.license;
  return buildServiceDescription({
    baseUrl,
    version: PKG_VERSION,
    license: { name: PACKAGE_MANIFEST.license, url: license.url },
    repositoryUrl: REPOSITORY_URL,
    catalogue: catalogueFigures(),
    tools: MCP_TOOLS,
  });
}

export function urlsDeclaredBy(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^https?:\/\//.test(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(document);
  return found;
}
