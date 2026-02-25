import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, getDealChanges, getOfferDetails, searchOffers } from "./data.js";

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
        eligibility_type: z.enum(["public", "accelerator", "oss", "student", "fintech", "geographic", "enterprise"]).optional().describe("Filter by eligibility type: public, accelerator, oss, student, fintech, geographic, enterprise"),
        sort: z.enum(["vendor", "category", "newest"]).optional().describe("Sort results: vendor (alphabetical by vendor name), category (by category then vendor), newest (most recently verified first)"),
        limit: z.number().optional().describe("Maximum results to return (default: all results, or 20 when offset is provided)"),
        offset: z.number().optional().describe("Number of results to skip (default: 0)"),
      },
    },
    async ({ query, category, eligibility_type, sort, limit, offset }) => {
      try {
        const allResults = searchOffers(query, category, eligibility_type, sort);
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

  server.registerTool(
    "get_deal_changes",
    {
      description:
        "Get recent pricing and free tier changes for developer tools. Tracks free tier removals, limit reductions/increases, new free tiers, and pricing restructures.",
      inputSchema: {
        since: z.string().optional().describe("ISO date string (YYYY-MM-DD). Only return changes on or after this date. Default: 30 days ago"),
        change_type: z.enum(["free_tier_removed", "limits_reduced", "limits_increased", "new_free_tier", "pricing_restructured"]).optional().describe("Filter by type of change"),
        vendor: z.string().optional().describe("Filter by vendor name (case-insensitive partial match)"),
      },
    },
    async ({ since, change_type, vendor }) => {
      try {
        const result = getDealChanges(since, change_type, vendor);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_deal_changes error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting deal changes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}
