import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const shutdown = {
  vendor: "Google Gemini",
  date: "2026-12-01",
  change_type: "product_deprecated",
  summary: "Gemini 2.5 Pro and Flash shut down.",
};
const priceRise = { ...shutdown, change_type: "pricing_restructured", summary: "Gemini 4 Argon input and output prices rise." };

it("REST and initialized MCP retain distinct same-day deadlines and collapse exact duplicates", async (t) => {
  const cases = [
    { label: "shutdown before price rise", expected: [shutdown, priceRise] },
    { label: "price rise before shutdown", expected: [priceRise, shutdown] },
    { label: "same summary, different types", expected: [shutdown, { ...shutdown, change_type: "pricing_restructured" }] },
    { label: "same type, different summaries", expected: [shutdown, { ...shutdown, summary: "Another Gemini model shuts down." }] },
  ];
  for (const { label, expected } of cases) {
    await t.test(label, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "digest-record-identity-"));
      const changesPath = path.join(dir, "deal_changes.json");
      const indexPath = path.join(dir, "index.json");
      const records = [...expected, ...expected].map(record => ({ ...record, date_source: "vendor_page", recorded_date: "2026-11-09" }));
      writeFileSync(changesPath, JSON.stringify({ changes: records }));
      writeFileSync(indexPath, JSON.stringify({ offers: [] }));
      const client = new Client({ name: "digest-record-identity", version: "1" });
      let child: ChildProcess | undefined;
      try {
        const url = await new Promise<string>((resolve, reject) => {
          child = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
            stdio: ["ignore", "ignore", "pipe"],
            env: {
              ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC",
              AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_CHANGES_PATH: changesPath,
              AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2026-11-10T12:00:00Z") - Date.now()),
            },
          });
          const timer = setTimeout(() => { child?.kill(); reject(new Error("Digest server startup timeout")); }, 30000);
          let output = "";
          child.stderr!.on("data", chunk => {
            output += chunk.toString();
            const port = output.match(/running on http:\/\/localhost:(\d+)/)?.[1];
            if (port) { clearTimeout(timer); resolve(`http://localhost:${port}`); }
          });
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("exit", code => { clearTimeout(timer); reject(new Error(`Digest server exited with ${code}: ${output}`)); });
        });
        const response = await fetch(`${url}/api/digest`, { redirect: "error" });
        assert.equal(response.status, 200);
        const rest = await response.json();
        assert.deepEqual(rest.upcoming_deadlines, expected);
        assert.match(rest.summary, /2 upcoming deadlines through 2026-12-01\./);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
        const call = await client.callTool({ name: "track_changes", arguments: {} });
        assert.notEqual(call.isError, true);
        assert.ok(Array.isArray(call.content));
        const text = call.content.find(block => block.type === "text");
        assert.ok(text && text.type === "text");
        const mcp = JSON.parse(text.text);
        assert.deepEqual(mcp.upcoming_deadlines, expected);
        assert.equal(mcp.summary, rest.summary);
      } finally {
        await client.close();
        child?.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
