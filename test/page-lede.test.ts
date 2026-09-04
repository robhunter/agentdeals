import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTextContent } from "../scripts/monitor-pricing.js";
import { getGuideList } from "../dist/guides.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
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

const LEDE_WINDOW = 200;

const NAV_LABELS = [
  "Categories", "Best Of", "Alternatives", "Agent Stacks",
  "Budget Builder", "Health Check", "Compare Tool", "How We Rank", "Marketplace",
];

interface ClaimPage {
  path: string;
  needWords: string[];
}

const CLAIM_PAGES: ClaimPage[] = [
  { path: "/monitoring-comparison-2026", needWords: ["free tier", "error tracking", "monitoring"] },
  { path: "/llm-api-pricing", needWords: ["free tier", "free credits"] },
];

function claimOf(html: string): string | null {
  const match = html.match(/<p class="page-claim">([\s\S]*?)<\/p>/);
  if (!match) return null;
  return match[1].replace(/&amp;/g, "&").replace(/&mdash;/g, "—").trim();
}

function titleOf(html: string): string {
  return (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/&amp;/g, "&").trim();
}

function h1Of(html: string): string {
  return (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .trim();
}

function metaDescOf(html: string): string {
  return (html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? "")
    .replace(/&amp;/g, "&")
    .trim();
}

async function fetchPage(pathname: string): Promise<string> {
  const response = await fetch(base + pathname);
  assert.strictEqual(response.status, 200, `${pathname} did not return 200`);
  return response.text();
}

async function sitemapPaths(name: string): Promise<string[]> {
  const xml = await fetchPage(name);
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
}

describe("Page lede", () => {
  before(async () => {
    server = await startServer();
  });

  after(() => {
    server?.kill();
  });

  for (const page of CLAIM_PAGES) {
    it(`${page.path} announces what it answers in its title, heading and description`, async () => {
      const html = await fetchPage(page.path);
      const title = titleOf(html);
      const h1 = h1Of(html);
      const metaDesc = metaDescOf(html);

      for (const word of page.needWords) {
        assert.ok(
          title.toLowerCase().includes(word),
          `${page.path} title omits "${word}": ${title}`,
        );
        assert.ok(
          h1.toLowerCase().includes(word),
          `${page.path} heading omits "${word}": ${h1}`,
        );
        assert.ok(
          metaDesc.toLowerCase().includes(word),
          `${page.path} meta description omits "${word}": ${metaDesc}`,
        );
      }
    });

    it(`${page.path} opens its extracted text with its own claim, not the site menu`, async () => {
      const html = await fetchPage(page.path);
      const claim = claimOf(html);
      assert.ok(claim, `${page.path} renders no page claim`);

      const extracted = extractTextContent(html);
      const window = extracted.slice(0, LEDE_WINDOW);

      assert.ok(
        extracted.startsWith(claim.slice(0, LEDE_WINDOW)),
        `${page.path} does not open with its claim. Opens with: ${window}`,
      );

      for (const label of NAV_LABELS) {
        assert.ok(
          !window.includes(label),
          `${page.path} opens with the site menu — "${label}" is inside the first ${LEDE_WINDOW} characters: ${window}`,
        );
      }

      for (const word of page.needWords) {
        assert.ok(
          window.toLowerCase().includes(word),
          `${page.path} opening ${LEDE_WINDOW} characters omit "${word}": ${window}`,
        );
      }
    });

    it(`${page.path} publishes one title across the page, the guide index and the hub`, async () => {
      const html = await fetchPage(page.path);
      const served = titleOf(html).replace(/ — AgentDeals$/, "");
      const shortTitle = served.split(" — ")[0];

      const guide = getGuideList().find((g: { slug: string }) => g.slug === page.path.slice(1));
      assert.ok(guide, `${page.path} has no entry in the guide index`);
      assert.strictEqual(
        guide.title,
        shortTitle,
        `${page.path} guide index title disagrees with the served title`,
      );

      const hub = await fetchPage("/alternatives");
      assert.ok(
        hub.includes(shortTitle.replace(/&/g, "&amp;")),
        `/alternatives does not name ${page.path} as "${shortTitle}"`,
      );
    });
  }

  it("no page renders its claim below the site menu", async () => {
    const paths = [...await sitemapPaths("/sitemap-pages.xml"), ...await sitemapPaths("/sitemap-misc.xml")];
    const withClaim: string[] = [];

    for (const pathname of paths) {
      const response = await fetch(base + pathname);
      if (response.status !== 200) continue;
      const html = await response.text();
      const claimAt = html.indexOf('<p class="page-claim">');
      if (claimAt === -1) continue;
      withClaim.push(pathname);

      const navAt = html.indexOf('<nav class="global-nav">');
      assert.ok(navAt !== -1, `${pathname} renders a claim and no site menu`);
      assert.ok(
        claimAt < navAt,
        `${pathname} renders its claim after the site menu, so extraction still opens with navigation`,
      );

      const claim = claimOf(html);
      assert.ok(claim, `${pathname} renders an empty claim`);
      assert.ok(
        extractTextContent(html).startsWith(claim.slice(0, LEDE_WINDOW)),
        `${pathname} does not open its extracted text with its claim`,
      );
    }

    for (const page of CLAIM_PAGES) {
      assert.ok(
        withClaim.includes(page.path),
        `${page.path} no longer renders a claim`,
      );
    }
  });
});
