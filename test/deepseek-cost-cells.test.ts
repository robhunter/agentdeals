import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

interface CostCell {
  tier: string;
  style: string;
  cost: string;
}

function deepSeekCostCells(html: string): CostCell[] {
  const table = html.match(/<th>DeepSeek<\/th>[\s\S]*?<\/table>/)?.[0] ?? "";
  return [...table.matchAll(/<tr><td style="font-weight:600">([A-Za-z]+)<div[\s\S]*?<\/tr>/g)].map((row) => {
    const costs = [...row[0].matchAll(/<td class="cost-highlight ([a-z-]+)">([^<]*)<\/td>/g)];
    const lastColumn = costs[costs.length - 1];
    return { tier: row[1], style: lastColumn?.[1] ?? "", cost: lastColumn?.[2] ?? "" };
  });
}

describe("/gemini-api-pricing-changes prices DeepSeek as the paid API it is", () => {
  before(async () => {
    server = await startServer();
  });

  after(() => {
    server?.kill();
  });

  it("states each usage tier's DeepSeek cost per month, in the paid style", async () => {
    const response = await fetch(`${base}/gemini-api-pricing-changes`);
    assert.strictEqual(response.status, 200);
    const cells = deepSeekCostCells(await response.text());
    assert.deepStrictEqual(
      cells.map((cell) => [cell.tier, cell.cost]),
      [["Light", "~$0.25/mo"], ["Moderate", "~$2.50/mo"], ["Heavy", "~$25/mo"]],
    );
    for (const cell of cells) {
      assert.strictEqual(cell.style, "cost-low", `the ${cell.tier} cell renders as ${cell.style}`);
    }
  });
});
