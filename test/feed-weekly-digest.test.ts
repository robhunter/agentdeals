import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("/feed.xml weekly digest feed", () => {
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

  it("GET /feed.xml returns valid Atom feed", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("application/atom+xml"));
    const xml = await res.text();
    assert.ok(xml.startsWith("<?xml"), "Should start with XML declaration");
    assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'), "Should be Atom feed");
  });

  it("feed has proper channel metadata", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("<title>AgentDeals"), "Should have feed title");
    assert.ok(xml.includes("<subtitle>"), "Should have feed subtitle");
    assert.ok(xml.includes('rel="self"'), "Should have self link");
    assert.ok(xml.includes('rel="alternate"'), "Should have alternate link");
    assert.ok(xml.includes("<id>urn:agentdeals:weekly-digest</id>"), "Should have feed ID");
    assert.ok(xml.includes("<updated>"), "Should have updated timestamp");
  });

  it("feed contains weekly digest entries", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    const xml = await res.text();
    const entries = xml.match(/<entry>/g);
    assert.ok(entries && entries.length > 0, "Should have at least one entry");
    assert.ok(entries!.length <= 4, "Should have at most 4 weeks");
  });

  it("entries have correct structure", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("urn:agentdeals:weekly-digest:"), "Should have weekly digest entry IDs");
    assert.ok(xml.includes("/this-week"), "Should link to /this-week");
    assert.ok(xml.includes('summary type="html"'), "Should have HTML summary");
    assert.ok(xml.includes("Week of"), "Entry titles should start with 'Week of'");
  });

  it("entries link to correct /this-week URLs", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    const xml = await res.text();
    assert.ok(xml.includes('/this-week"'), "Current week should link to /this-week");
    assert.ok(xml.includes("/this-week?week=1"), "Previous week should link to /this-week?week=1");
  });

  it("CORS header is set", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
  });

  it("feed has author element", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("<author><name>AgentDeals</name></author>"), "Should have author element");
  });

  it("no entry has a future updated date", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/feed.xml`);
    const xml = await res.text();
    const now = new Date();
    const updatedDates = [...xml.matchAll(/<updated>([^<]+)<\/updated>/g)].map(m => new Date(m[1]));
    for (const d of updatedDates) {
      assert.ok(d <= now, `Date ${d.toISOString()} should not be in the future`);
    }
  });

  it("/api/feed returns same content as /feed.xml", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/feed`);
    assert.strictEqual(res.status, 200);
    const xml = await res.text();
    assert.ok(xml.includes("weekly-digest"), "API feed should also be weekly digest");
  });
});
