const DROPPED_CONNECTIONS = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

function droppedConnection(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && DROPPED_CONNECTIONS.has(String(error.code))) return true;
    error = "cause" in error ? error.cause : null;
  }
  return false;
}

export function retryLocalGets(base: string, request: typeof fetch = globalThis.fetch): typeof fetch {
  const origin = new URL(base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error(`Expected a local test server: ${base}`);
  }
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (new URL(url).origin !== origin.origin || method.toUpperCase() !== "GET") return request(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await request(input, init);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const body = await response.arrayBuffer();
        return new Response(response.status === 204 || response.status === 205 ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        if (attempt === 3 || signal?.aborted || !droppedConnection(error)) {
          throw new Error(`GET ${url} failed on attempt ${attempt}`, { cause: error });
        }
      }
    }
  };
}

if (process.env.AGENTDEALS_TEST_HTTP_ORIGIN) {
  globalThis.fetch = retryLocalGets(process.env.AGENTDEALS_TEST_HTTP_ORIGIN);
}
