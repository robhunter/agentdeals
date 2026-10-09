import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGuideBySlug, getGuideList } from "../dist/guides.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const RETIRED_PAGE = "/ai-coding-pricing-2026";
const SUCCESSOR_PAGE = "/ai-coding-tools-pricing";
const NAMES_THE_RETIRED_PAGE = new RegExp(`${RETIRED_PAGE}(?![\\w-])`);
const UNLISTED_SURFACES = ["/feed.xml", "/llms.txt", "/llms-full.txt"];
const PAGES_THAT_LISTED_IT_BESIDE_OTHER_GUIDES = [
  "/openai-assistants-alternatives",
  "/openai-assistants-migration-2026",
  "/firebase-studio-shutdown",
];

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
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

async function locs(sitemap: string): Promise<string[]> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, "") || "/");
}

async function sitemapsAndTheirRoutes(): Promise<{ sitemaps: string[]; routes: string[] }> {
  const sitemaps = ["/sitemap.xml", ...(await locs("/sitemap.xml"))];
  const routes = new Set<string>(["/"]);
  for (const child of sitemaps.slice(1)) {
    for (const p of await locs(child)) routes.add(p);
  }
  return { sitemaps, routes: [...routes].filter((p) => !p.endsWith(".xml")) };
}

type Crawl = { unread: string[]; naming: string[]; served: Map<string, string> };

async function crawl(paths: string[]): Promise<Crawl> {
  const result: Crawl = { unread: [], naming: [], served: new Map() };
  const queue = [...paths];
  const worker = async () => {
    for (let route = queue.pop(); route !== undefined; route = queue.pop()) {
      const response = await fetch(`${base}${route}`);
      if (!response.ok) {
        result.unread.push(`${route} answered ${response.status}`);
        continue;
      }
      const body = await response.text();
      result.served.set(route, body);
      if (NAMES_THE_RETIRED_PAGE.test(body)) result.naming.push(route);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return result;
}

describe(`${RETIRED_PAGE} is retired in favor of ${SUCCESSOR_PAGE}`, () => {
  let sitemaps: string[] = [];
  let routes: string[] = [];
  let found: Crawl = { unread: [], naming: [], served: new Map() };

  before(async () => {
    server = await startServer();
    ({ sitemaps, routes } = await sitemapsAndTheirRoutes());
    found = await crawl([...sitemaps, ...routes, ...UNLISTED_SURFACES]);
  });
  after(() => {
    server?.kill();
  });

  it("reads every sitemap, every route they list, the feed and the llms files", () => {
    assertPopulationFloor(routes.length, 1850, "routes the sitemaps list");
    assert.deepStrictEqual(found.unread.sort(), []);
    assert.ok(routes.includes(SUCCESSOR_PAGE), `${SUCCESSOR_PAGE} is in no sitemap`);
  });

  it("is named by no sitemap, page, feed or llms file", () => {
    assert.ok(!routes.includes(RETIRED_PAGE), `${RETIRED_PAGE} is in a sitemap`);
    assert.deepStrictEqual(found.naming.sort(), []);
  });

  it("is no longer a guide on the list the MCP transports serve", () => {
    const slugs = getGuideList().map((guide) => guide.slug);
    assert.ok(!slugs.includes(RETIRED_PAGE.slice(1)), `${RETIRED_PAGE} is still on the guide list`);
    assert.ok(slugs.includes(SUCCESSOR_PAGE.slice(1)), `${SUCCESSOR_PAGE} is not on the guide list`);
    assert.strictEqual(getGuideBySlug(RETIRED_PAGE.slice(1)), null);
  });

  it("is replaced by the guide that succeeded it where a page listed it among related guides", () => {
    const missing = PAGES_THAT_LISTED_IT_BESIDE_OTHER_GUIDES.filter(
      (page) => !found.served.get(page)?.includes(`<a href="${SUCCESSOR_PAGE}" class="related-page-link">`),
    );
    assert.deepStrictEqual(missing, []);
  });
});
