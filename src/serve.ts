import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const mcpServer = createServer();

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/mcp") {
    // For POST requests, parse the JSON body
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      try {
        const parsedBody = JSON.parse(body);
        await transport.handleRequest(req, res, parsedBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    } else {
      // GET (SSE) and DELETE (session termination)
      await transport.handleRequest(req, res);
    }
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

async function main() {
  await mcpServer.connect(transport);
  httpServer.listen(PORT, () => {
    console.error(`agentdeals MCP server running on http://localhost:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
