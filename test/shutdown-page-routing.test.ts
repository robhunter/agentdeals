import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import { readPageLastmod } from "../dist/page-lastmod.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let base: string;
let paths: string[];

before(async () => {
  child = spawn("node", [path.join(root, "dist/serve.js")], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off" },
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
    child.stderr!.on("data", chunk => {
      const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("error", reject);
    child.on("exit", code => reject(new Error(`Server exited: ${code}`)));
  });
  base = `http://localhost:${port}`;
  const sitemap = await (await fetch(`${base}/sitemap-pages.xml`)).text();
  paths = [...sitemap.matchAll(/<loc>http:\/\/localhost(\/shutdowns\/[^<]+)<\/loc>/g)].map(match => match[1]);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

describe("shutdown page routes", () => {
  it("serves every ledgered shutdown path or redirects it to a served page", async () => {
    const ledgered = Object.keys(readPageLastmod().pages).filter(route => route.startsWith("/shutdowns/"));
    assert.ok(ledgered.length > 0);
    for (const route of ledgered) {
      const response = await fetch(base + route, { redirect: "manual" });
      if (response.status === 200) continue;
      assert.equal(response.status, 301, route);
      const target = response.headers.get("location");
      assert.ok(target && paths.includes(target), route);
      const destination = await fetch(base + target, { redirect: "manual" });
      assert.equal(destination.status, 200, route);
    }
  });

  it("serves each sitemap entry with its title and tracker link", async () => {
    assert.ok(paths.length > 0);
    assert.equal(new Set(paths).size, paths.length);
    const tracker = createDocument(await (await fetch(`${base}/shutdowns`)).text());
    assert.ok(paths.length < tracker.querySelectorAll(".shutdown-card").length);
    for (const route of paths) {
      const response = await fetch(base + route, { redirect: "manual" });
      assert.equal(response.status, 200, route);
      const document = createDocument(await response.text());
      assert.ok(document.title, route);
      assert.equal(document.querySelector("h1")?.textContent, document.title, route);
      assert.ok(document.querySelector('a[href="/shutdowns"]'), route);
      const vendor = document.querySelector('a[href^="/vendor/"]');
      if (vendor) {
        const vendorResponse = await fetch(base + vendor.getAttribute("href"), { redirect: "follow" });
        assert.equal(vendorResponse.status, 200, route);
      }
    }
  });

  it("links the vendor exactly when its page is served", async () => {
    for (const route of paths) {
      const slug = route.match(/^\/shutdowns\/(.+?)-\d{4}-\d{2}/)?.[1];
      assert.ok(slug, route);
      const response = await fetch(`${base}/vendor/${slug}`, { redirect: "follow" });
      const document = createDocument(await (await fetch(base + route)).text());
      const link = document.querySelector('a[href^="/vendor/"]');
      assert.equal(Boolean(link), response.status === 200, route);
      if (link) assert.equal(link.getAttribute("href"), `/vendor/${slug}`, route);
    }
  });

  it("returns 404 for an unknown shutdown path", async () => {
    assert.equal((await fetch(`${base}/shutdowns/no-such-shutdown`, { redirect: "manual" })).status, 404);
  });
});
