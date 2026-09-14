import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, vendorsInTheCatalogue } from "./population-floor.ts";
import { API_ENDPOINTS, WITHDRAWN_ENDPOINTS, withdrawalReasonFor } from "../dist/api-inventory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverPort = 0;
let serverProc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const DELIVERY_MARKERS = [
  "/api/watchlist",
  "signed POST to your endpoint",
  "notified via webhook",
  "Set up watchlist alerts via API",
  "/developer-hub",
  "/developers#watchlist",
];

async function allSitemapPaths(): Promise<string[]> {
  const indexRes = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
  assert.strictEqual(indexRes.status, 200);
  const children = [...(await indexRes.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(children.length >= 4, `sitemap index listed ${children.length} sitemaps`);

  const paths = new Set<string>(["/"]);
  for (const child of children) {
    const childPath = new URL(child, "http://localhost").pathname;
    const res = await fetch(`http://localhost:${serverPort}${childPath}`);
    assert.strictEqual(res.status, 200, `${childPath} answered ${res.status}`);
    for (const m of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      paths.add(new URL(m[1], "http://localhost").pathname);
    }
  }
  return [...paths];
}

describe("no published page offers to deliver a webhook", () => {
  before(async () => { serverProc = await startServer(); });
  after(() => { serverProc?.kill(); serverProc = null; });

  it("every route in the sitemap is clean", async () => {
    const paths = await allSitemapPaths();
    assertCoversPopulation(paths.length, vendorsInTheCatalogue(), "routes in the sitemap the sweep read");

    const offenders: string[] = [];
    for (const p of paths) {
      const res = await fetch(`http://localhost:${serverPort}${p}`);
      if (res.status !== 200) {
        offenders.push(`${p}: answered ${res.status}`);
        continue;
      }
      const body = await res.text();
      const found = DELIVERY_MARKERS.filter(marker => body.includes(marker));
      if (found.length > 0) offenders.push(`${p}: ${found.join(", ")}`);
    }
    assert.deepStrictEqual(offenders.slice(0, 20), [], `${offenders.length} routes of ${paths.length}`);
  });

  it("each marker is one the sweep would actually flag", () => {
    for (const marker of DELIVERY_MARKERS) {
      const page = `<html><body><p>lorem ${marker} ipsum</p></body></html>`;
      assert.deepStrictEqual(DELIVERY_MARKERS.filter(m => page.includes(m)), [marker]);
    }
  });

  it("the subscription route accepts nothing and says why", async () => {
    const attempts: { method: string; path: string; body?: string }[] = [
      { method: "POST", path: "/api/watchlist", body: JSON.stringify({ vendor: "Supabase", webhook_url: "https://example.com/hook" }) },
      { method: "GET", path: "/api/watchlist" },
      { method: "GET", path: "/api/watchlist/sub_example" },
      { method: "DELETE", path: "/api/watchlist/sub_example" },
    ];
    assert.strictEqual(attempts.length, WITHDRAWN_ENDPOINTS.length, "every withdrawn route is attempted here");

    for (const attempt of attempts) {
      const res = await fetch(`http://localhost:${serverPort}${attempt.path}`, {
        method: attempt.method,
        headers: attempt.body ? { "Content-Type": "application/json" } : undefined,
        body: attempt.body,
      });
      assert.strictEqual(res.status, 410, `${attempt.method} ${attempt.path} answered ${res.status}`);
      const body = await res.json() as { error: string; instead: { request: string }[] };
      assert.ok(body.error.length > 20, `${attempt.method} ${attempt.path} is withdrawn without a reason a reader can use`);
      assert.ok(body.instead.length > 0, `${attempt.method} ${attempt.path} names nothing that works`);
      for (const alternative of body.instead) {
        const href = new URL(alternative.request);
        const probe = await fetch(`http://localhost:${serverPort}${href.pathname}${href.search}`);
        assert.strictEqual(probe.status, 200, `${alternative.request} answered ${probe.status}`);
      }
    }
  });

  it("no register still publishes the route", async () => {
    for (const { method, path: route, reason } of WITHDRAWN_ENDPOINTS) {
      assert.ok(reason.length > 20, `${method} ${route} is withdrawn without a reason a reader can use`);
      assert.ok(
        !API_ENDPOINTS.some((e) => e.path === route && e.method === method),
        `${method} ${route} is in both registers`,
      );
    }

    const spec = await (await fetch(`http://localhost:${serverPort}/api/openapi.json`)).json() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    const documented = Object.keys(spec.paths).filter((p) => withdrawalReasonFor(p.replace(/\{[^}]+\}/g, "x")) !== null);
    assert.deepStrictEqual(documented, [], "the spec still describes a withdrawn route");
    assert.deepStrictEqual(
      Object.keys(spec.components.schemas).filter((name) => name.toLowerCase().includes("watchlist")),
      [],
      "the spec still carries the withdrawn route's schema",
    );
  });

  it("the vendor page offers a way to watch that answers", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    const start = html.indexOf('<div class="section change-watch-cta-section">');
    assert.ok(start > 0, "the vendor page no longer offers any way to watch the vendor");
    const section = html.slice(start, html.indexOf("</div>", start));

    const requests = [...section.matchAll(/curl (http[^\s<]+)/g)].map(m => m[1].replace(/&amp;/g, "&"));
    assert.ok(requests.length >= 2, `the block offers ${requests.length} requests`);
    for (const request of requests) {
      const href = new URL(request);
      const probe = await fetch(`http://localhost:${serverPort}${href.pathname}${href.search}`);
      assert.strictEqual(probe.status, 200, `${request} answered ${probe.status}`);
    }

    for (const href of [...section.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1])) {
      const probe = await fetch(`http://localhost:${serverPort}${href}`, { redirect: "manual" });
      assert.ok(probe.status < 400, `${href} answered ${probe.status}`);
    }
  });
});

describe("the per-vendor change feed filters on the vendor it names", () => {
  before(async () => { if (serverProc === null) serverProc = await startServer(); });
  after(() => { serverProc?.kill(); serverProc = null; });

  async function feed(query: string): Promise<{ status: number; vendors: string[]; body: string }> {
    const res = await fetch(`http://localhost:${serverPort}/pricing-changes/feed.xml${query}`);
    const body = await res.text();
    const vendors = [...body.matchAll(/<entry>[\s\S]*?<title>([^<:]+):/g)].map(m => m[1]);
    return { status: res.status, vendors, body };
  }

  it("names one vendor and returns only that vendor", async () => {
    const unfiltered = await feed("");
    assert.strictEqual(unfiltered.status, 200);
    assert.ok(unfiltered.vendors.length > 1, `the unfiltered feed carried ${unfiltered.vendors.length} entries`);

    const subject = unfiltered.vendors[0];
    const filtered = await feed(`?vendor=${encodeURIComponent(subject)}`);
    assert.strictEqual(filtered.status, 200);
    assert.ok(filtered.vendors.length > 0, `${subject} is in the unfiltered feed and its own feed is empty`);
    assert.deepStrictEqual([...new Set(filtered.vendors)], [subject]);
    assert.ok(filtered.vendors.length < unfiltered.vendors.length, "the filter returned the whole collection");
    assert.ok(filtered.body.includes(`vendor=${encodeURIComponent(subject)}`), "the feed does not name itself as its own source");
  });

  it("resolves the slug a vendor page is served under", async () => {
    const byName = await feed("?vendor=Vercel");
    const bySlug = await feed("?vendor=vercel");
    assert.strictEqual(byName.status, 200);
    assert.strictEqual(bySlug.status, 200);
    assert.deepStrictEqual(bySlug.vendors, byName.vendors);
    assert.deepStrictEqual([...new Set(bySlug.vendors)], ["Vercel"], "the slug form is not scoped to the vendor it names");
  });

  it("refuses a vendor we hold nothing for rather than answering with every vendor", async () => {
    const unknown = await feed("?vendor=NotARealVendorXyz");
    assert.strictEqual(unknown.status, 404, "an unrecognised filter was accepted and ignored");
    assert.deepStrictEqual(unknown.vendors, []);
  });
});
