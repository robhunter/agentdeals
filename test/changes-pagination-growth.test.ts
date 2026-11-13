import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function records(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    vendor: `Pagination ${index % 2 ? "A" : "B"} ${index}`,
    change_type: index % 3 ? "limits_increased" : "limits_reduced",
    date: index % 2 ? "2026-01-02" : "2026-01-01",
    summary: `Pagination record ${index}`,
    previous_state: "1 request per day",
    current_state: "2 requests per day",
    impact: "low",
    source_url: "https://example.com/pricing",
    category: index % 2 ? "Databases" : "Monitoring",
    alternatives: [],
    date_source: "hand_written",
  }));
}

async function startApi(changesPath: string): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(repo, "dist/serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("startup timeout"));
    }, 60000);
    let stderr = "";
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) {
        clearTimeout(timer);
        resolve({ proc, base: `http://127.0.0.1:${port}` });
      }
    });
    proc.once("error", error => { clearTimeout(timer); reject(error); });
    proc.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
}

describe("change history grows beyond one thousand records", () => {
  for (const count of [0, 1001, 2407]) {
    it(`returns the complete ${count}-record window through the stdio proxy`, async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "changes-pagination-"));
      const changesPath = path.join(scratch, "changes.json");
      const fixture = records(count);
      writeFileSync(changesPath, JSON.stringify({ changes: fixture }));
      let api: ChildProcess | undefined;
      let client: Client | undefined;
      try {
        const started = await startApi(changesPath);
        api = started.proc;
        const page = await (await fetch(`${started.base}/developers`)).text();
        const stated = page.match(/There is no maximum: <code>\?limit=(\d+)<\/code> returns the whole window in one response/);
        assert.ok(stated);
        const response = await fetch(`${started.base}/api/changes?since=2026-01-01&limit=${stated[1]}`);
        assert.equal(response.status, 200);
        const whole = await response.json() as { changes: unknown[]; total: number };
        assert.equal(whole.total, count);
        assert.equal(whole.changes.length, count);

        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [path.join(repo, "dist/index.js")],
          env: { ...process.env, AGENTDEALS_API_URL: started.base } as Record<string, string>,
          stderr: "pipe",
        });
        client = new Client({ name: "pagination-test", version: "1.0.0" });
        await client.connect(transport);
        for (const filters of [
          {},
          { categories: "Databases" },
          { vendor: "Pagination B", change_type: "limits_reduced" },
          { vendors: "Pagination A", include_retracted: true, include_index_housekeeping: true },
          { vendor: "Absent pagination vendor" },
        ]) {
          const query = new URLSearchParams({ since: "2026-01-01", limit: String(count) });
          for (const [key, value] of Object.entries(filters)) {
            query.set(key === "change_type" ? "type" : key, String(value));
          }
          const expected = await (await fetch(`${started.base}/api/changes?${query}`)).json() as Record<string, unknown>;
          const called = await client.callTool({
            name: "track_changes",
            arguments: { since: "2026-01-01", include_expiring: false, ...filters },
          });
          assert.equal(called.isError, undefined);
          const actual = JSON.parse((called.content as { text: string }[])[0].text);
          assert.equal(actual.total, expected.total);
          assert.equal(actual.returned, expected.total);
          assert.equal(actual.changes.length, expected.total);
          assert.deepEqual(actual.changes, expected.changes);
          assert.equal(actual.limit, expected.total);
          assert.equal(actual.offset, 0);
          for (const field of ["date_window", "name_match", "summary", "retracted_excluded", "index_housekeeping_excluded", "date_provenance", "change_census"]) {
            assert.deepEqual(actual[field], expected[field], field);
          }
        }
        const concise = await client.callTool({
          name: "track_changes",
          arguments: { since: "2026-01-01", response_format: "concise" },
        });
        assert.equal(concise.isError, undefined);
        const actual = JSON.parse((concise.content as { text: string }[])[0].text);
        assert.equal(actual.changes.length, count);
        assert.equal(actual.total, count);
        assert.ok(actual.expiring_deals);
        assert.deepEqual(actual.changes.map((row: { summary: string }) => row.summary), (whole.changes as { summary: string }[]).map(row => row.summary));
      } finally {
        await client?.close();
        if (api && api.exitCode === null && api.signalCode === null) {
          const exited = once(api, "exit");
          api.kill("SIGKILL");
          await exited;
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
