import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("/this-week page", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 10000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /this-week returns 200 with HTML content", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const html = await res.text();
    assert.ok(html.includes("<!DOCTYPE html>"), "Should be a full HTML page");
    assert.ok(html.includes("This Week in Developer Pricing"), "Should have page title");
  });

  it("page has OG meta tags for social sharing", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    const html = await res.text();
    assert.ok(html.includes('og:title'), "Should have og:title");
    assert.ok(html.includes('og:description'), "Should have og:description");
    assert.ok(html.includes('og:type" content="article'), "Should have og:type article");
    assert.ok(html.includes('og:url'), "Should have og:url");
    assert.ok(html.includes('og:image'), "Should have og:image");
    assert.ok(html.includes('twitter:card'), "Should have twitter:card");
  });

  it("page has JSON-LD structured data", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    const html = await res.text();
    assert.ok(html.includes('application/ld+json'), "Should have JSON-LD script");
    const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/);
    assert.ok(match, "Should extract JSON-LD");
    const jsonLd = JSON.parse(match![1]);
    assert.strictEqual(jsonLd["@type"], "Article");
    assert.ok(jsonLd.headline.includes("This Week in Developer Pricing"));
    assert.ok(jsonLd.publisher.name === "AgentDeals");
  });

  it("page has digest sections (Losses, Bright Spots, Other)", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    const html = await res.text();
    const hasSections = html.includes("Biggest Losses") || html.includes("Bright Spots") || html.includes("Other Notable Changes") || html.includes("No pricing changes tracked");
    assert.ok(hasSections, "Should have at least one content section or empty message");
  });

  it("page has share links", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    const html = await res.text();
    assert.ok(html.includes("twitter.com/intent/tweet"), "Should have Twitter share link");
    assert.ok(html.includes("linkedin.com/sharing"), "Should have LinkedIn share link");
    assert.ok(html.includes("news.ycombinator.com"), "Should have HN share link");
    assert.ok(html.includes("/feed.xml"), "Should have RSS link");
  });

  it("page has navigation to previous weeks", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    const html = await res.text();
    assert.ok(html.includes("this-week?week=1"), "Should link to previous week");
    assert.ok(html.includes("digest/archive"), "Should link to full archive");
  });

  it("?week=1 returns previous week's digest", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week?week=1`, {

    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Developer Pricing"), "Should have title");
    assert.ok(html.includes("Current week") || html.includes("Next week"), "Should have forward navigation");
  });

  it("page has global navigation with This Week active", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {

    });
    const html = await res.text();
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes('href="/this-week" class="nav-link active"'), "This Week nav link should be active");
  });

  it("page has canonical URL", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/this-week`, {


    });
    const html = await res.text();
    assert.ok(html.includes('rel="canonical"'), "Should have canonical URL");
    assert.ok(html.includes("/this-week"), "Canonical should reference /this-week");
  });

  it("/this-week appears in sitemap-reports.xml", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/sitemap-reports.xml`, {


    });
    const xml = await res.text();
    assert.ok(xml.includes("/this-week"), "Should include /this-week in sitemap");
  });
});
