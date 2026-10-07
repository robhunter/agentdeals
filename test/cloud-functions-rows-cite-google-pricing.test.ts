import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { RECORD_SOURCE_CLASS } = await import("../dist/change-citation.js");

const SERVERLESS = "/serverless-free-tier-comparison-2026";
const CLOUD_FUNCTIONS = "Google Cloud Functions";
const FREE_COMPUTE = "400K GB-sec + 200K GHz-sec";
const CLOUD_FUNCTIONS_FIRST_GEN_PRICING = "https://cloud.google.com/functions/pricing-1stgen";
const STARTUP_PROGRAM_PAGE = "https://cloud.google.com/startup";

let server: ChildProcess;
let html = "";

const ANCHOR = /<a\b[^>]*>[\s\S]*?<\/a>/g;
const DECORATION = /<a\b[^>]*class="[^"]*"[^>]*>[\s\S]*?<\/a>|<a\b[^>]*style="display:inline-block[^>]*>[\s\S]*?<\/a>|<span\b[^>]*>[\s\S]*?<\/span>/g;

function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function rowsNamed(markup: string, name: string): string[][] {
  return [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell!))
    .filter((cells) => cells.length >= 2 && textOf(cells[0]!.replace(DECORATION, "")) === name);
}

function linksIn(cell: string, cls: string): string[] {
  return [...cell.matchAll(/<a\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes(`class="${cls}"`))
    .map((tag) => tag.match(/href="([^"]*)"/)?.[1] ?? "");
}

describe("the serverless guide's Google Cloud Functions rows cite Google's Cloud Functions pricing page, which states their figures", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const response = await fetch(`${base}${SERVERLESS}`);
    assert.strictEqual(response.status, 200, SERVERLESS);
    html = await response.text();
  });
  after(() => {
    server?.kill();
  });

  it("links the pricing page from the free compute cell of the main table's row and the Traditional FaaS table's row", () => {
    const rows = rowsNamed(html, CLOUD_FUNCTIONS);
    assert.strictEqual(rows.length, 2, `${SERVERLESS} has ${rows.length} ${CLOUD_FUNCTIONS} rows`);
    for (const cells of rows) {
      const holding = cells.slice(1).filter((cell) => textOf(cell.replace(ANCHOR, "")) === FREE_COMPUTE);
      assert.strictEqual(holding.length, 1, `one cell reads "${FREE_COMPUTE}"`);
      assert.deepStrictEqual(linksIn(holding[0]!, FIGURE_SOURCE_CLASS), [CLOUD_FUNCTIONS_FIRST_GEN_PRICING]);
    }
  });

  it("cites neither the catalogue record nor the startup program's page from either row", () => {
    const rows = rowsNamed(html, CLOUD_FUNCTIONS);
    assert.strictEqual(rows.length, 2);
    for (const cells of rows) {
      assert.deepStrictEqual(cells.flatMap((cell) => linksIn(cell, RECORD_SOURCE_CLASS)), []);
      assert.deepStrictEqual(cells.filter((cell) => cell.includes(STARTUP_PROGRAM_PAGE)), []);
    }
  });
});
