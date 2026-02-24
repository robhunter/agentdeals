import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

// Map of session ID → transport + last activity for multi-session support
const sessions = new Map<string, SessionEntry>();

function touchSession(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
  }
}

// Periodic cleanup of idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    const idleMs = now - entry.lastActivity;
    if (idleMs > SESSION_IDLE_TIMEOUT_MS) {
      const idleMinutes = Math.round(idleMs / 60000);
      console.error(`Cleaned up idle session ${sid} after ${idleMinutes}m`);
      entry.transport.close?.();
      sessions.delete(sid);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((msg) => msg?.method === "initialize");
  }
  return (body as { method?: string })?.method === "initialize";
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/mcp") {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — route to its transport
        touchSession(sessionId);
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, parsedBody);
      } else if (!sessionId && isInitializeRequest(parsedBody)) {
        // New session — create transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, lastActivity: Date.now() });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
          }
        };

        const mcpServer = createServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } else {
        // Invalid: has session ID but unknown, or missing session ID on non-init request
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Bad Request: No valid session. Send an initialize request first." },
          id: null,
        }));
      }
    } else if (req.method === "GET") {
      // SSE stream — route to existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        touchSession(sessionId);
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      }
    } else if (req.method === "DELETE") {
      // Session termination
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

httpServer.listen(PORT, () => {
  console.error(`agentdeals MCP server running on http://localhost:${PORT}/mcp`);
});
