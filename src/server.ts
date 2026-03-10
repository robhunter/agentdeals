import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, getDealChanges, getNewOffers, getOfferDetails, searchOffers } from "./data.js";
import { recordToolCall } from "./stats.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "agentdeals",
    version: "0.1.0",
    description: "Find free tiers, startup credits, and discounts for developer tools — databases, cloud hosting, CI/CD, monitoring, APIs, and more. 1,500+ verified offers across 52 categories with pricing change tracking.",
  });

  server.registerTool(
    "list_categories",
    {
      description:
        "Browse 52 categories of developer infrastructure deals (databases, cloud hosting, CI/CD, monitoring, auth, search, and more). Call this first to see what's available before searching.",
    },
    async () => {
      try {
        recordToolCall("list_categories");
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
        "Find free tiers, credits, and discounts for developer tools. Use when choosing infrastructure for a new project, comparing vendor pricing, or finding cost savings. Covers 1,500+ offers from vendors like AWS, Vercel, Supabase, Cloudflare, and more. Supports filtering by category, eligibility (public, startup, OSS, student), and sorting by recency.",
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
        recordToolCall("search_offers");
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
        "Get full pricing details for a specific vendor's free tier or deal. Use include_alternatives to compare up to 5 similar vendors in the same category — ideal for recommending alternatives or evaluating options.",
      inputSchema: {
        vendor: z.string().describe("Vendor name (case-insensitive match)"),
        include_alternatives: z.boolean().optional().describe("When true, includes full deal objects for up to 5 alternative vendors in the same category"),
      },
    },
    async ({ vendor, include_alternatives }) => {
      try {
        recordToolCall("get_offer_details");
        const result = getOfferDetails(vendor, include_alternatives ?? false);
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
    "get_new_offers",
    {
      description:
        "Check what developer tool deals were recently added or updated. Returns offers verified within the last N days, sorted newest first. Use for periodic checks to stay current on new free tiers and credits.",
      inputSchema: {
        days: z.number().optional().describe("Number of days to look back (default: 7, max: 30)"),
      },
    },
    async ({ days }) => {
      try {
        recordToolCall("get_new_offers");
        const result = getNewOffers(days ?? 7);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error("get_new_offers error:", err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error getting new offers: ${err instanceof Error ? err.message : String(err)}`,
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
        "Check which developer tools recently changed their pricing or free tiers. Tracks removals, limit reductions, limit increases, new free tiers, and restructures. Use when advising on vendor lock-in risk or staying current on pricing shifts.",
      inputSchema: {
        since: z.string().optional().describe("ISO date string (YYYY-MM-DD). Only return changes on or after this date. Default: 30 days ago"),
        change_type: z.enum(["free_tier_removed", "limits_reduced", "limits_increased", "new_free_tier", "pricing_restructured"]).optional().describe("Filter by type of change"),
        vendor: z.string().optional().describe("Filter by vendor name (case-insensitive partial match)"),
      },
    },
    async ({ since, change_type, vendor }) => {
      try {
        recordToolCall("get_deal_changes");
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
