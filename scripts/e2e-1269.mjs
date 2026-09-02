import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const failures = [];
function check(ok, message) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("server startup timeout"));
    }, 60000);
    proc.stderr.on("data", (data) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function mcpSession(base) {
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentdeals-e2e-1269", version: "1.0.0" } },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  let id = 1;
  return {
    ok: init.status === 200 && !!sessionId,
    async call(name, args) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id + 100, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
      const payload = JSON.parse(line.replace(/^data: /, ""));
      const content = payload?.result?.content?.[0]?.text ?? "";
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { parsed = null; }
      return { status: res.status, isError: payload?.result?.isError === true, text: content, json: parsed };
    },
  };
}

const WORDS = ["hosting", "models", "memory", "projects", "testing", "community"];

const { proc, base } = await startLocalServer();
try {
  console.log(`server: ${base}\n`);

  console.log("--- /api/vendor-risk answers a word that names no vendor with 404");
  for (const word of WORDS) {
    const res = await fetch(`${base}/api/vendor-risk/${encodeURIComponent(word)}`);
    const body = await res.json();
    check(res.status === 404 && !body.vendor, `${word} -> ${res.status} ${body.vendor ?? "no vendor"}`);
  }

  console.log("\n--- /api/vendor-risk still answers a real vendor, and types the match");
  for (const [query, vendor, type] of [["Vercel", "Vercel", "exact"], ["AWS Lambda Free", "AWS", "inferred"]]) {
    const res = await fetch(`${base}/api/vendor-risk/${encodeURIComponent(query)}`);
    const body = await res.json();
    check(
      res.status === 200 && body.vendor === vendor && body.vendor_match?.type === type && body.vendor_match?.requested === query,
      `${query} -> ${res.status} ${body.vendor} ${JSON.stringify(body.vendor_match)}`,
    );
  }

  console.log("\n--- /api/compare refuses a word that names no vendor");
  const cmp = await fetch(`${base}/api/compare?a=hosting&b=netlify`);
  const cmpBody = await cmp.json();
  check(cmp.status === 404 && !cmpBody.vendor_a, `?a=hosting&b=netlify -> ${cmp.status}`);

  const cmpOk = await fetch(`${base}/api/compare?a=Supabase&b=Neon`);
  const cmpOkBody = await cmpOk.json();
  check(
    cmpOk.status === 200 && cmpOkBody.vendor_a_match?.type === "exact" && cmpOkBody.vendor_b_match?.type === "exact",
    `?a=Supabase&b=Neon -> ${cmpOk.status} ${JSON.stringify(cmpOkBody.vendor_a_match)}`,
  );

  console.log("\n--- /api/audit-stack reports what it could not match");
  const audit = await fetch(`${base}/api/audit-stack?services=${encodeURIComponent("hosting,memory,models,redis")}`);
  const auditBody = await audit.json();
  check(
    auditBody.services.every((s) => s.status === "not_found") && auditBody.risks_found === 0,
    `four words -> ${auditBody.services.map((s) => s.status).join(",")} risks_found=${auditBody.risks_found}`,
  );

  console.log("\n--- openapi.json publishes the match type");
  const spec = await (await fetch(`${base}/api/openapi.json`)).json();
  check(!!spec.components?.schemas?.VendorMatch, "components.schemas.VendorMatch is published");
  check(
    spec.paths?.["/api/vendor-risk/{vendor}"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.vendor_match?.$ref === "#/components/schemas/VendorMatch",
    "the vendor-risk 200 references it",
  );

  console.log("\n--- a real MCP session");
  const mcp = await mcpSession(base);
  check(mcp.ok, "initialize returned a session");

  const stack = await mcp.call("plan_stack", { mode: "audit", services: ["hosting", "memory", "models", "redis"] });
  const statuses = (stack.json?.services ?? []).map((s) => `${s.vendor}=${s.status}`);
  check(
    (stack.json?.services ?? []).every((s) => s.status === "not_found" && !s.cheaper_alternative),
    `plan_stack audit -> ${statuses.join(" ")}`,
  );
  check(
    (stack.json?.services ?? []).every((s) => WORDS.concat("redis").includes(s.vendor)),
    "every row still carries the name the caller sent",
  );

  const stackReal = await mcp.call("plan_stack", { mode: "audit", services: ["Vercel", "Supabase"] });
  check(
    (stackReal.json?.services ?? []).every((s) => s.status === "found"),
    `plan_stack audit of a real stack -> ${(stackReal.json?.services ?? []).map((s) => `${s.vendor}=${s.status}`).join(" ")}`,
  );

  const risk = await mcp.call("compare_vendors", { vendors: ["memory"] });
  check(risk.isError === true, `compare_vendors["memory"] -> ${risk.isError ? "error" : risk.json?.vendor}`);

  const inferred = await mcp.call("compare_vendors", { vendors: ["AWS Lambda Free"] });
  check(
    inferred.json?.vendor === "AWS" && inferred.json?.vendor_match?.type === "inferred",
    `compare_vendors["AWS Lambda Free"] -> ${inferred.json?.vendor} ${JSON.stringify(inferred.json?.vendor_match)}`,
  );
  check(
    (inferred.json?.summary ?? "").includes("AWS Lambda Free"),
    "the summary names the name the caller sent",
  );

  const pair = await mcp.call("compare_vendors", { vendors: ["hosting", "netlify"] });
  check(pair.isError === true, `compare_vendors["hosting","netlify"] -> ${pair.isError ? "error" : "comparison"}`);
} finally {
  proc.kill();
}

console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
