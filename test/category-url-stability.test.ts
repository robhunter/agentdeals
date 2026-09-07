import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const SLUGS_PUBLISHED_BEFORE_THE_SCOPE_REGISTRY = [
  "ai-coding", "ai-ml", "analytics", "api-development", "api-gateway", "auth",
  "background-jobs", "banking-finance", "browser-automation", "cdn", "ci-cd",
  "cloud-hosting", "cloud-iaas", "cloud-storage", "code-quality", "communication",
  "communication-messaging", "consumer-email", "container-registry", "databases",
  "design", "design-creative", "dev-utilities", "diagramming", "dns-domain-management",
  "documentation", "education", "email", "error-tracking", "feature-flags",
  "fitness-health", "forms", "headless-cms", "ide-code-editors", "infrastructure",
  "localization", "logging", "low-code-platforms", "maps-geolocation",
  "meditation-wellness", "messaging", "mobile-development", "monitoring",
  "news-reading", "notebooks-data-science", "password-managers", "payments",
  "productivity-notes", "project-management", "search", "secrets-management",
  "security", "server-management", "source-control", "startup-perks",
  "startup-programs", "status-pages", "storage", "streaming-media",
  "team-collaboration", "testing", "tunneling-networking", "video", "vpn-privacy",
  "web-scraping", "workflow-automation",
];

let server: ChildProcess;
let port = 0;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

before(async () => { server = await startServer(); });
after(() => { server?.kill(); });

describe("a category URL published once keeps resolving", () => {
  it("answers every category path the site published before the scope registry", async () => {
    const orphaned: string[] = [];
    for (const slug of SLUGS_PUBLISHED_BEFORE_THE_SCOPE_REGISTRY) {
      const res = await fetch(`http://localhost:${port}/category/${slug}`, { redirect: "manual" });
      if (res.status === 200) continue;
      if (res.status === 301) {
        const followed = await fetch(`http://localhost:${port}${res.headers.get("location")}`, { redirect: "manual" });
        if (followed.status === 200) continue;
        orphaned.push(`${slug} -> ${res.headers.get("location")} -> ${followed.status}`);
        continue;
      }
      orphaned.push(`${slug} -> ${res.status}`);
    }
    assert.deepStrictEqual(orphaned, [], `category paths that no longer resolve: ${orphaned.join(", ")}`);
  });

  it("redirects the merged name rather than serving it", async () => {
    const res = await fetch(`http://localhost:${port}/category/startup-programs`, { redirect: "manual" });
    assert.strictEqual(res.status, 301);
    assert.strictEqual(res.headers.get("location"), "/category/startup-perks");
  });

  it("still filters offers by a name it no longer publishes", async () => {
    const merged = await (await fetch(`http://localhost:${port}/api/offers?category=Startup%20Programs&limit=5`)).json() as { total: number; offers: { category: string }[] };
    const surviving = await (await fetch(`http://localhost:${port}/api/offers?category=Startup%20Perks&limit=5`)).json() as { total: number };
    assert.strictEqual(merged.total, surviving.total);
    assert.ok(merged.total > 0);
    for (const offer of merged.offers) assert.strictEqual(offer.category, "Startup Perks");
  });
});

describe("the directory says what a name holds", () => {
  it("publishes a scope statement and family for every category", async () => {
    const body = await (await fetch(`http://localhost:${port}/api/categories`)).json() as {
      categories: { name: string; slug: string; count: number; scope: string; audience: string; also_answering: { name: string }[]; example_members: string[] }[];
      retired_names: Record<string, string>;
    };
    assert.ok(body.categories.length > 0);
    for (const category of body.categories) {
      assert.ok(category.scope.length > 0, `${category.name} publishes no scope statement`);
      assert.ok(["developer", "personal"].includes(category.audience));
      assert.ok(category.slug.length > 0);
    }
    assert.strictEqual(body.retired_names["Startup Programs"], "Startup Perks");
  });

  it("tells a caller asking for cloud storage that the object stores are under another name", async () => {
    const body = await (await fetch(`http://localhost:${port}/api/categories`)).json() as {
      categories: { name: string; audience: string; scope: string; also_answering: { name: string; count: number }[]; example_members: string[] }[];
    };
    const cloudStorage = body.categories.find((c) => c.name === "Cloud Storage")!;
    assert.strictEqual(cloudStorage.audience, "personal");
    const storage = cloudStorage.also_answering.find((s) => s.name === "Storage");
    assert.ok(storage, "Cloud Storage does not send a caller to Storage");
    assert.ok(storage.count > 0);
    assert.ok(cloudStorage.example_members.includes("Google Drive"));
  });

  it("tells a caller asking for error tracking that the suites are under Monitoring", async () => {
    const body = await (await fetch(`http://localhost:${port}/api/categories`)).json() as {
      categories: { name: string; scope: string; also_answering: { name: string }[] }[];
    };
    const errorTracking = body.categories.find((c) => c.name === "Error Tracking")!;
    assert.ok(errorTracking.scope.includes("Monitoring"));
    assert.ok(errorTracking.also_answering.some((s) => s.name === "Monitoring"));
  });
});

describe("a category page states its own scope", () => {
  it("prints the same scope statement the directory publishes", async () => {
    const body = await (await fetch(`http://localhost:${port}/api/categories`)).json() as {
      categories: { name: string; slug: string; scope: string }[];
    };
    for (const name of ["Storage", "Cloud Storage", "Error Tracking", "Messaging", "Startup Perks"]) {
      const category = body.categories.find((c) => c.name === name)!;
      const html = await (await fetch(`http://localhost:${port}/category/${category.slug}`)).text();
      const published = category.scope
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      assert.ok(html.includes(published), `/category/${category.slug} does not print its own scope statement`);
    }
  });

  it("links a category to the names answering alongside it", async () => {
    const html = await (await fetch(`http://localhost:${port}/category/cloud-storage`)).text();
    assert.ok(html.includes("where do my files live"));
    assert.ok(html.includes('href="/category/storage"'));
  });
});
