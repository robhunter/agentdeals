import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCategories, searchOffers } from "./data.js";

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
        "Search developer tool offers by keyword, category, or vendor name. Returns matching deals with details and URLs.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to search for in vendor names, descriptions, and tags"),
        category: z.string().optional().describe("Filter results to a specific category (e.g. 'Databases', 'Cloud Hosting')"),
      },
    },
    async ({ query, category }) => {
      try {
        const results = searchOffers(query, category);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
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

  return server;
}
