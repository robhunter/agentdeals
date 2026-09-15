import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, type Population } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LINKED_PATH = /href="(\/(?:vendor|alternative-to)\/[^"]*)"/g;
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const SITEMAP_LOC = /<loc>([^<]+)<\/loc>/g;

let sitemapRoutes: string[] = [];

function routesTheSitemapLists(): Population {
  return { size: sitemapRoutes.length, read: "routes the sitemap lists" };
}

function linkedInternalPaths(html: string): string[] {
  const rendered = html.replace(SCRIPT_BLOCK, "");
  return [...rendered.matchAll(LINKED_PATH)].map((m) => m[1]!);
}

async function inBatches<T>(items: T[], size: number, each: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await each(item);
      }
    }),
  );
}

describe("every internal vendor path the site renders is a path the site answers", () => {
  let proc: ChildProcess;
  let base: string;
  const linkedFrom = new Map<string, Set<string>>();
  const answered = new Map<string, number>();
  let routesRead = 0;

  before(async () => {
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", TZ: "UTC" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1]!, 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;

    const index = await fetch(`${base}/sitemap.xml`);
    assert.strictEqual(index.status, 200, `/sitemap.xml answers ${index.status}`);
    const listed = new Set<string>();
    for (const [, loc] of (await index.text()).matchAll(SITEMAP_LOC)) {
      const sub = await fetch(`${base}${new URL(loc!).pathname}`);
      assert.strictEqual(sub.status, 200, `${new URL(loc!).pathname} answers ${sub.status}`);
      for (const [, route] of (await sub.text()).matchAll(SITEMAP_LOC)) {
        listed.add(new URL(route!).pathname);
      }
    }
    sitemapRoutes = [...listed].sort();

    await inBatches(sitemapRoutes, 12, async (route) => {
      const res = await fetch(`${base}${route}`);
      if (res.status !== 200) return;
      routesRead++;
      for (const href of linkedInternalPaths(await res.text())) {
        if (!linkedFrom.has(href)) linkedFrom.set(href, new Set());
        linkedFrom.get(href)!.add(route);
      }
    });

    await inBatches([...linkedFrom.keys()], 12, async (href) => {
      const res = await fetch(`${base}${href}`, { redirect: "manual" });
      answered.set(href, res.status);
    });
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("reads every route the sitemap lists", () => {
    assert.ok(sitemapRoutes.length > 0, "the sitemap lists no route to read");
    assertCoversPopulation(routesRead, routesTheSitemapLists(), "routes rendered and read for the vendor paths they link");
  });

  it("links at least one internal vendor path from the rendered site", () => {
    assert.ok(linkedFrom.size > 0, "the sweep found no internal vendor path, so it can prove nothing about them");
  });

  it("answers every internal vendor path it links", () => {
    const unanswered = [...answered.entries()]
      .filter(([, status]) => status === 404)
      .map(([href]) => `${href} (linked from ${[...linkedFrom.get(href)!].sort().join(", ")})`)
      .sort();
    assert.deepStrictEqual(unanswered, [], `${unanswered.length} internal vendor paths the site links answer 404`);
  });
});
