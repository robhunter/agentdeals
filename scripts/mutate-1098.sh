#!/usr/bin/env bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

SERVE="src/serve.ts"
STREAM="src/mcp-stream.ts"
BACKUP_DIR="$(mktemp -d)"
cp "$SERVE" "$BACKUP_DIR/serve.ts"
cp "$STREAM" "$BACKUP_DIR/mcp-stream.ts"

restore() {
  cp "$BACKUP_DIR/serve.ts" "$SERVE"
  cp "$BACKUP_DIR/mcp-stream.ts" "$STREAM"
}
trap restore EXIT

killed=0
survived=0

run_mutation() {
  local name="$1"
  shift
  echo "=== $name"
  restore
  "$@"
  if ! npm run build > /tmp/mutate-1098-build.log 2>&1; then
    echo "    KILLED (does not compile)"
    killed=$((killed + 1))
    return
  fi
  if timeout 300 node --test --test-concurrency 1 test/mcp-stream.test.ts > /tmp/mutate-1098-test.log 2>&1; then
    echo "    SURVIVED"
    survived=$((survived + 1))
  else
    echo "    KILLED: $(grep -c '✖' /tmp/mutate-1098-test.log) failing test(s)"
    grep '✖' /tmp/mutate-1098-test.log | head -4
    killed=$((killed + 1))
  fi
}

m_no_keepalive_write() {
  python3 - <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""    try {
      res.write(SSE_KEEPALIVE_FRAME);
    } catch {
      releaseStandaloneStream(sessionId, entry, "keepalive_write_failed", res);
    }
  }, SSE_KEEPALIVE_INTERVAL_MS);""", """  }, SSE_KEEPALIVE_INTERVAL_MS);""")
open(p, "w").write(s)
PY
}

m_no_prime() {
  python3 - <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("  primeStandaloneStream(res);\n", "")
open(p, "w").write(s)
PY
}

m_no_replace() {
  python3 - <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""        if (entry.sse) {
          releaseStandaloneStream(sessionId, entry, "replaced_by_reconnect");
          await new Promise<void>(resolve => setImmediate(resolve));
        }
""", "")
open(p, "w").write(s)
PY
}

m_no_close_release() {
  python3 - <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""  res.on("close", () => releaseStandaloneStream(sessionId, entry, "client_disconnect", res));\n""", "")
open(p, "w").write(s)
PY
}

m_bare_400_body() {
  python3 - <<'PY'
p = "src/serve.ts"
s = open(p).read()
s = s.replace("""        res.end(JSON.stringify(sessionRecoveryBody(sessionId ? "unknown_session" : "no_session")));
      }
    } else if (req.method === "DELETE") {""", """        res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      }
    } else if (req.method === "DELETE") {""")
open(p, "w").write(s)
PY
}

m_shared_recovery_message() {
  python3 - <<'PY'
p = "src/mcp-stream.ts"
s = open(p).read()
s = s.replace("""      "No session: this request carried no Mcp-Session-Id header. Send an initialize request to obtain a session ID, then retry with that ID.",""", """      "Unknown session: this server is not holding the session ID you sent, so it cannot serve this request. Send an initialize request to obtain a new session ID, then retry with that ID.",""")
open(p, "w").write(s)
PY
}

m_interval_above_cutoff() {
  python3 - <<'PY'
p = "src/mcp-stream.ts"
s = open(p).read()
s = s.replace("export const DEFAULT_SSE_KEEPALIVE_MS = 25_000;", "export const DEFAULT_SSE_KEEPALIVE_MS = 130_000;")
open(p, "w").write(s)
PY
}

m_data_frame_not_comment() {
  python3 - <<'PY'
p = "src/mcp-stream.ts"
s = open(p).read()
s = s.replace('export const SSE_KEEPALIVE_FRAME = ": keepalive\\n\\n";', 'export const SSE_KEEPALIVE_FRAME = "data: keepalive\\n\\n";')
open(p, "w").write(s)
PY
}

m_drop_recovery_field() {
  python3 - <<'PY'
p = "src/mcp-stream.ts"
s = open(p).read()
s = s.replace('      data: { condition, recovery: "reinitialize" },', '      data: { condition, recovery: "retry" },')
open(p, "w").write(s)
PY
}

m_env_override_ignored() {
  python3 - <<'PY'
p = "src/mcp-stream.ts"
s = open(p).read()
s = s.replace("""  const raw = env.MCP_SSE_KEEPALIVE_MS;""", """  const raw = undefined as string | undefined;""")
open(p, "w").write(s)
PY
}

run_mutation "keepalive frame is never written" m_no_keepalive_write
run_mutation "no priming byte when the stream opens" m_no_prime
run_mutation "reconnect does not replace the held stream" m_no_replace
run_mutation "slot is not released when the client disconnects" m_no_close_release
run_mutation "session 400 loses its recovery body" m_bare_400_body
run_mutation "both session conditions share one message" m_shared_recovery_message
run_mutation "keepalive interval moves above the measured cutoff" m_interval_above_cutoff
run_mutation "keepalive becomes a data frame instead of a comment" m_data_frame_not_comment
run_mutation "recovery field stops saying re-initialize" m_drop_recovery_field
run_mutation "environment override is ignored" m_env_override_ignored

restore
npm run build > /dev/null 2>&1

echo
echo "killed $killed, survived $survived"
[ "$survived" -eq 0 ]
