import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

let child: ChildProcess;
let html = "";

const plain = (value: string) => value
  .replace(/<(a|span)\b[^>]*class="[^"]*(?:unsourced-tag|figure-source|record-source)[^"]*"[^>]*>[\s\S]*?<\/\1>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

describe("Railway trial and recurring free credits", () => {
  before(async () => {
    let stderr = "";
    child = spawn(process.execPath, ["dist/serve.js"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.resume();
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stderr)); }, 60000);
      child.stderr!.on("data", chunk => {
        stderr += chunk;
        const found = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (found) { clearTimeout(timer); resolve(Number(found[1])); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}/state-of-free-tiers`, { redirect: "error" });
    assert.equal(response.status, 200);
    html = await response.text();
  });
  after(() => child?.kill("SIGKILL"));

  it("states the one-time trial and subsequent monthly credit in the startup table", () => {
    const section = html.split("Startup Credit Programs: The Hidden Goldmine</h2>")[1]?.split("</table>")[0];
    assert.ok(section);
    const rows = [...section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .filter(row => row[1].includes('href="/vendor/railway"'));
    assert.equal(rows.length, 1);
    const cells = [...rows[0][1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell => plain(cell[1]));
    assert.deepEqual(cells, ["Railway", "$5 trial credit, then $1 free/month", "Everyone", "No credit card, usage-based"]);
  });

  it("does not publish the trial grant as a monthly free allowance", () => {
    assert.ok(!html.includes("$5 free/month"));
  });
});
