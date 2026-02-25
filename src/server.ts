import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, getOfferDetails, searchOffers } from "./data.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agentdeals",
    version: "0.1.0",
  });

  server.registerTool(
    "list_categories",
    {
      description:
        "List available categories of developer tool offers (cloud hosting, databases, CI/CD, etc.)",
    },
    async () => {
      try {
        const categories = getCategories();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(categories, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("list_categories error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error listing categories: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "search_offers",
    {
      description:
        "Search developer tool offers by keyword, category, or vendor name. Returns matching deals with details and URLs. Supports pagination via limit/offset.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to search for in vendor names, descriptions, and tags"),
        category: z.string().optional().describe("Filter results to a specific category (e.g. 'Databases', 'Cloud Hosting')"),
        limit: z.number().optional().describe("Maximum results to return (default: all results, or 20 when offset is provided)"),
        offset: z.number().optional().describe("Number of results to skip (default: 0)"),
      },
    },
    async ({ query, category, limit, offset }) => {
      try {
        const allResults = searchOffers(query, category);
        const total = allResults.length;
        const usePagination = limit !== undefined || offset !== undefined;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? (usePagination ? 20 : total);
        const results = allResults.slice(effectiveOffset, effectiveOffset + effectiveLimit);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results, total, limit: effectiveLimit, offset: effectiveOffset }, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("search_offers error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error searching offers: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_offer_details",
    {
      description:
        "Get full details for a specific vendor by name, including related vendors in the same category.",
      inputSchema: {
        vendor: z.string().describe("Vendor name (case-insensitive match)"),
      },
    },
    async ({ vendor }) => {
      try {
        const result = getOfferDetails(vendor);
        if ("error" in result) {
          const msg = result.suggestions.length > 0
            ? `${result.error} Did you mean: ${result.suggestions.join(", ")}?`
            : `${result.error} No similar vendors found.`;
          return {
            isError: true,
            content: [{ type: "text" as const, text: msg }],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.offer, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_offer_details error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting offer details: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}
