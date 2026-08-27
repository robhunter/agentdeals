export const SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

export const DEFAULT_SSE_KEEPALIVE_MS = 25_000;

export const MEASURED_EDGE_STREAM_CUTOFF_MS = 125_000;

export function keepaliveIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MCP_SSE_KEEPALIVE_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_SSE_KEEPALIVE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SSE_KEEPALIVE_MS;
  }
  return parsed;
}

export type SessionRecoveryCondition = "unknown_session" | "no_session";

export interface SessionRecoveryBody {
  jsonrpc: "2.0";
  id: null;
  error: {
    code: number;
    message: string;
    data: {
      condition: SessionRecoveryCondition;
      recovery: string;
    };
  };
}

const RECOVERY: Record<SessionRecoveryCondition, { code: number; message: string }> = {
  unknown_session: {
    code: -32001,
    message:
      "Unknown session: this server is not holding the session ID you sent, so it cannot serve this request. Send an initialize request to obtain a new session ID, then retry with that ID.",
  },
  no_session: {
    code: -32001,
    message:
      "No session: this request carried no Mcp-Session-Id header. Send an initialize request to obtain a session ID, then retry with that ID.",
  },
};

export function sessionRecoveryBody(condition: SessionRecoveryCondition): SessionRecoveryBody {
  const spec = RECOVERY[condition];
  return {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: spec.code,
      message: spec.message,
      data: { condition, recovery: "reinitialize" },
    },
  };
}
