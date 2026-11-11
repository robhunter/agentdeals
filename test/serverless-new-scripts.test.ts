import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const route = "/serverless-free-tier-comparison-2026";
const catalogue = JSON.parse(readFileSync(join(repo, "data/index.json"), "utf8"));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&rarr;/g, "→").replace(/\s+/g, " ").trim();

async function readPage(description?: string, removeFreeListing = false): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "serverless-scripts-"));
  const index = structuredClone(catalogue);
  if (removeFreeListing) {
    index.offers = index.offers.filter((offer: { vendor: string; tier: string }) => offer.vendor !== "Cloudflare Workers" || offer.tier !== "Free");
  } else if (description !== undefined) {
    const workers = index.offers.find((offer: { vendor: string; tier: string }) => offer.vendor === "Cloudflare Workers" && offer.tier === "Free");
    assert.ok(workers);
    workers.description = description;
  }
  index.offers.sort((a: { tier: string }, b: { tier: string }) => Number(b.tier === "Student Program") - Number(a.tier === "Student Program"));
  const indexPath = join(scratch, "index.json");
  writeFileSync(indexPath, JSON.stringify(index));
  const child = spawn(process.execPath, ["dist/serve.js"], {
    cwd: repo,
    env: { ...process.env, AGENTDEALS_INDEX_PATH: indexPath, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    let stderr = "";
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 30000);
      child.stderr.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
}

function pick(html: string): string {
  const card = [...html.matchAll(/<div class="verdict-item">([\s\S]*?)<\/div>/g)].find(match => match[1].includes("Quick scripts and prototypes"));
  assert.ok(card);
  return textOf(card[1]);
}

describe("serverless choices for new scripts", () => {
  it("picks Workers and describes Val Town's winding down instead of recommending new work", async () => {
    const html = await readPage();
    assert.match(pick(html), /^Quick scripts and prototypes → Cloudflare Workers Cloudflare Workers: write a function in the Cloudflare dashboard and get a workers\.dev URL\./);
    const context = [...html.matchAll(/<div class="context-box">([\s\S]*?)<\/div>/g)].map(match => textOf(match[1])).find(text => text.startsWith("Val Town"));
    assert.ok(context?.startsWith("Val Town is winding down: new signups ended on November 10, 2026, it becomes read-only on December 10, 2026, and all services end on January 10, 2027."));
    const specialized = html.slice(html.indexOf('id="specialized"'), html.indexOf('id="billing-gotcha"'));
    const row = [...specialized.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].find(match => textOf(match[1]).startsWith("Val Town"));
    assert.ok(row);
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => textOf(match[1]));
    assert.equal(cells[4], "Existing vals until January 10, 2027; no new signups");
    for (const old of ["Quick scripts and prototypes → Val Town", "Val Town: write a function, get a URL", "is the easiest way to get serverless functions running", "Great for prototyping and small tools", "Quick scripts, prototypes, public APIs, MCP servers"]) assert.ok(!textOf(html).includes(old), old);
  });

  for (const [description, expected] of [
    ["Edge compute with 432K requests/day, 10ms CPU. Durable Objects: 100K requests/day.", "432,000"],
    ["Edge compute with 123,456 requests per day, 10ms CPU. Paid: 10 million requests/month.", "123,456"],
    ["Edge compute with 1.5K requests/day, 10ms CPU.", "1,500"],
  ]) {
    it(`reads the Free listing's ${expected} daily requests despite other allowances`, async () => {
      assert.ok(pick(await readPage(description)).endsWith(`The Free plan gives ${expected} requests a day.`));
    });
  }

  it("omits a request figure when only a different service or monthly grant has one", async () => {
    const html = await readPage("Edge compute with 10 million requests/month. Durable Objects: 100K requests/day.");
    assert.ok(pick(html).endsWith("See its listing for Free plan limits."));
    assert.doesNotMatch(pick(html), /\d/);
  });

  it("does not substitute the student allowance when the Free listing is absent", async () => {
    assert.ok(pick(await readPage(undefined, true)).endsWith("See its listing for Free plan limits."));
  });
});
