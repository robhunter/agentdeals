import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getCategories, searchOffers } from "./data.js";

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
    const categories = getCategories();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(categories, null, 2),
        },
      ],
    };
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
    const results = searchOffers(query, category);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("agentdeals MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
