import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const future = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
const vendors = ["AWS", "AWS Lambda", "Amazon DynamoDB", "GitHub Actions"];
const changes = [today, future].flatMap(date => vendors.map(vendor => ({
  vendor,
  date,
  date_source: "vendor_page",
  change_type: "limits_increased",
  summary: `${vendor} fixture allowance changes on ${date}.`,
  previous_state: "1 request per day",
  current_state: "2 requests per day",
  source_url: "https://example.com/pricing",
  category: "Cloud Hosting",
  impact: "low",
  alternatives: [],
})));

function section(html: string, anchor: string): string {
  const start = html.indexOf(`<h2 id="${anchor}">`);
  assert.notEqual(start, -1, anchor);
  const end = html.indexOf("<h2", start + 1);
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

describe("the AWS guide selects AWS change records", () => {
  let server: ChildProcess | undefined;
  let scratch: string;
  let html: string;

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "aws-guide-changes-"));
    const changesPath = path.join(scratch, "changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes }));
    server = spawn(process.execPath, [path.join(repo, "dist/serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const child = server;
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server startup timeout")), 60000);
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${port}`);
        }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(base + "/aws-free-tier-2026");
    assert.equal(response.status, 200);
    html = await response.text();
  });

  after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGKILL");
      await exited;
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  for (const [anchor, date] of [["changes", today], ["upcoming-changes", future]]) {
    it(`keeps GitHub Actions out of ${anchor} and retains each AWS vendor form`, () => {
      const table = section(html, anchor);
      assert.doesNotMatch(table, /GitHub Actions/);
      for (const vendor of vendors.slice(0, 3)) {
        assert.ok(table.includes(`${vendor} fixture allowance changes on ${date}.`), vendor);
      }
      assert.equal((table.match(/<tr>/g) ?? []).length, 4);
    });
  }

  it("counts only the six AWS records across both date windows", () => {
    const count = html.match(/We track \d+ AWS-related entries and (\d+) AWS pricing changes/);
    assert.ok(count);
    assert.equal(Number(count[1]), 6);
  });
});
