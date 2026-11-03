import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const comparison = "/database-free-tier-comparison-2026";
const vector = "/vector-database-pricing";
const pages: Record<string, string> = {};
let server: ChildProcess;

async function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; base: string }> {
  const child = spawn("node", ["dist/serve.js"], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off", ...env },
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited with ${code}`)); });
    child.stderr!.on("data", (chunk: Buffer) => {
      const port = chunk.toString().match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timeout); resolve(`http://localhost:${port}`); }
    });
  });
  return { child, base };
}

function text(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").replace(/ ([.,;:])/g, "$1").trim();
}

function cells(route: string, vendor: string, columns = 6): string[] {
  const rows = [...pages[route].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell)))
    .filter((row) => row.length === columns && (row[0] === vendor || row[0]?.startsWith(`${vendor} `)));
  assert.equal(rows.length, 1, `${route} must carry one ${vendor} comparison row`);
  return rows[0];
}

describe("database comparisons distinguish free-plan limits and closed cloud signup", () => {
  before(async () => {
    const running = await startServer();
    server = running.child;
    const base = running.base;
    for (const route of [comparison, vector]) {
      const response = await fetch(base + route, { redirect: "error" });
      assert.equal(response.status, 200, route);
      pages[route] = await response.text();
    }
  });

  after(() => { server?.kill(); });

  it("states Redis Cloud's throughput and connection caps beside its 30 MB free plan", () => {
    assert.deepEqual(cells(comparison, "Redis Cloud").slice(1, 4), ["Redis", "30 MB", "100 ops/sec, 30 connections"]);
  });

  it("says the free Redis Cloud plan has no persistence, with the negative cell style", () => {
    assert.equal(cells(comparison, "Redis Cloud")[4], "No (not on the free plan)");
    assert.match(pages[comparison], /<td class="cross">No \(not on the free plan\)<\/td>/);
  });

  it("states the Redis 8 open-source license option and preserves the surrounding cache guidance", () => {
    const note = text(pages[comparison]).match(/Upstash is the standout[\s\S]*?Dragonfly a source-available one\./)?.[0];
    assert.equal(note, "Upstash is the standout for serverless Redis — 256 MB data and 500K commands/month with true pay-per-request pricing beyond the free tier. Cloudflare KV has more storage (1 GB) but very low write limits (1K/day) making it best for read-heavy config data. Redis Cloud's 30 MB free tier is tiny but useful for development. Note: Redis 8 added AGPLv3, an open-source license, besides RSALv2 and SSPLv1. Valkey is the leading open-source alternative, and Dragonfly a source-available one.");
  });

  it("distinguishes LanceDB's unlimited embedded offer from its closed cloud signup", () => {
    assert.deepEqual(cells(comparison, "LanceDB", 5).slice(1), ["Unlimited (embedded)", "Unlimited (embedded)", "OSS: free. Cloud: closed to new accounts", "Embedded vector search, local development"]);
  });

  it("shows closed LanceDB cloud signup in the vector pricing table", () => {
    const row = cells(vector, "LanceDB", 7);
    assert.equal(row[5], "Cloud: closed to new accounts");
    assert.deepEqual(row.slice(2, 5), ["Unlimited (OSS)", "Unlimited (OSS)", "Unlimited"]);
  });

  it("shows closed LanceDB cloud signup in its vector description without offering credits", () => {
    const card = pages[vector].match(/<h3><a href="\/vendor\/lancedb">LanceDB<\/a><\/h3>[\s\S]*?(?=<h3|<h2)/)?.[0];
    assert.ok(card, "LanceDB's vector description is present");
    assert.match(text(card), /LanceDB Cloud is closed to new accounts\./);
    assert.doesNotMatch(text(card), /\$100|one-time free credits/);
  });

  it("preserves Turso storage, Upstash commands and Pinecone storage", () => {
    assert.equal(cells(comparison, "Turso")[2], "5 GB");
    assert.equal(cells(comparison, "Upstash")[3], "500K commands/mo");
    assert.equal(cells(vector, "Pinecone", 7)[3], "2 GB");
  });

  it("compares Vectorize's stored dimensions, vector size and Workers Paid minimum", () => {
    assert.deepEqual(cells(vector, "Cloudflare Vectorize", 7).slice(1), [
      "Serverless (Workers)", "~6,500 at 768 dimensions (5M stored vector dimensions)",
      "5M stored vector dimensions", "Up to 1,536", "$5/mo minimum (Workers Paid)",
      "Per queried and stored vector dimension",
    ]);
    const section = pages[vector].match(/<h2 id="pricing-table">[\s\S]*?(?=<h2)/)?.[0];
    assert.match(section!, /href="\/vendor\/cloudflare-vectorize"/);
    const names = [...section!.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell));
    assert.equal(names.indexOf("Cloudflare Vectorize"), names.indexOf("Turbopuffer") + 1);
  });

  it("explains Vectorize's query allowance separately from its standing storage allowance", () => {
    const section = pages[vector].match(/<h3>Serverless Vector DB<\/h3>[\s\S]*?(?=<h2)/)?.[0];
    const card = section?.match(/<h3><a href="\/vendor\/cloudflare-vectorize">Cloudflare Vectorize<\/a><\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(card, "the serverless category contains Vectorize's description");
    assert.equal(text(card), "Vectorize is Cloudflare's vector database for Workers. Workers Free includes 30 million queried vector dimensions a month and 5 million stored vector dimensions (about 6,500 vectors of 768 dimensions). Up to 1,536 dimensions per vector. Workers Paid starts at $5 a month per account.");
    assert.deepEqual(cells(vector, "Cloudflare Vectorize", 4).slice(1), [
      "$0 (Workers Free)", "$5+ (Workers Paid minimum plus usage)", "Per queried and stored vector dimension",
    ]);
  });

  it("keeps Vectorize and the service count in page metadata and the route registry", () => {
    const html = pages[vector];
    const section = html.match(/<h2 id="pricing-table">[\s\S]*?(?=<h2)/)?.[0];
    const count = [...section!.matchAll(/<tr\b[^>]*>\s*<td\b/g)].length;
    assert.equal(count, 12);
    assert.match(text(html), new RegExp(`${count} services compared`));
    assert.match(text(html), new RegExp(`${count} services across five categories`));
    assert.match(html, new RegExp(`class="stat-number">${count}</div><div class="stat-label">Services Compared`));
    const descriptions = [...html.matchAll(/<meta (?:name="description"|property="og:description") content="([^"]+)"/g)].map(([, value]) => value);
    const article = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(([, value]) => JSON.parse(value)).find(value => value["@type"] === "Article");
    descriptions.push(article.description);
    const source = readFileSync(path.join(root, "src/serve.ts"), "utf8");
    descriptions.push(source.match(/slug: "vector-database-pricing",\s*title: "[^"]+",\s*metaDesc: "([^"]+)"/)![1]);
    assert.equal(descriptions.length, 4);
    for (const description of descriptions) {
      assert.match(description, new RegExp(`^Compare ${count} vector databases:`));
      assert.match(description, /Cloudflare Vectorize/);
    }
  });

  it("includes a sourced Vectorize change in the vector pricing timeline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vectorize-timeline-"));
    let child: ChildProcess | undefined;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const file = path.join(dir, "changes.json");
      const summary = "Vectorize query allowance increased for Workers Free.";
      const source = "https://developers.cloudflare.com/vectorize/platform/pricing/";
      writeFileSync(file, JSON.stringify({ changes: [{
        vendor: "Cloudflare Vectorize", category: "Databases", date: today, recorded_date: today,
        date_source: "vendor_page", change_type: "limits_increased", summary,
        previous_state: "Earlier query allowance", current_state: "Increased query allowance",
        source_url: source, impact: "medium", alternatives: [],
      }] }));
      const running = await startServer({ AGENTDEALS_CHANGES_PATH: file });
      child = running.child;
      const response = await fetch(running.base + vector, { redirect: "error" });
      assert.equal(response.status, 200);
      const section = (await response.text()).match(/<h2 id="changes">[\s\S]*?(?=<h2|$)/)?.[0];
      assert.ok(section, "the page contains its change timeline");
      assert.match(text(section), /Cloudflare Vectorize/);
      assert.ok(text(section).includes(summary));
      assert.ok(section.includes(`href="${source}"`));
    } finally {
      child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
