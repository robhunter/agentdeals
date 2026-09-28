import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let server: ChildProcess;
const webBlurbs = new Map<string, string>();

function collectionItems(html: string): { url: string; description: string }[] {
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(raw);
    if (data["@type"] === "CollectionPage") {
      return data.mainEntity.itemListElement.map((element: { item: { url: string; description: string } }) => element.item);
    }
  }
  return [];
}

describe("the MCP guide list describes each guide with the blurb the web guide list shows", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const response = await fetch(`${base}/guides`);
    assert.strictEqual(response.status, 200);
    for (const item of collectionItems(await response.text())) {
      webBlurbs.set(new URL(item.url).pathname.slice(1), item.description);
    }
  });
  after(() => {
    server?.kill();
  });

  it("gives every guide both lists carry the same description", async () => {
    const { getGuideList } = await import("../dist/guides.js");
    const shared = getGuideList().filter((guide: { slug: string }) => webBlurbs.has(guide.slug));
    assert.ok(shared.length > 50, `only ${shared.length} guides are on both lists`);
    const differing = shared
      .filter((guide: { slug: string; description: string }) => guide.description !== webBlurbs.get(guide.slug))
      .map((guide: { slug: string; description: string }) => `${guide.slug}: MCP "${guide.description}", web "${webBlurbs.get(guide.slug)}"`);
    assert.deepStrictEqual(differing, []);
  });

  it("describes the three reports on both lists with no count that moves when the catalogue does", async () => {
    const { getGuideBySlug } = await import("../dist/guides.js");
    const expected: Record<string, string> = {
      "q1-2026-developer-pricing-report": "Pricing changes in Q1 2026 — free tiers removed, narrative analysis, category breakdown, monthly timeline, Cloudflare counter-trend, Q2 outlook",
      "free-tier-risk": "Predictive risk analysis for developer free tiers — grades dated and scored against what happened next, category heatmap, pattern analysis, counter-trends",
      "state-of-free-tiers": "Data-driven analysis of developer tool free tiers by category — trends, risks, and recommendations",
    };
    const wrong = Object.entries(expected).flatMap(([slug, blurb]) => [
      webBlurbs.get(slug) === blurb ? null : `${slug} web: "${webBlurbs.get(slug)}"`,
      getGuideBySlug(slug)?.description === blurb ? null : `${slug} MCP: "${getGuideBySlug(slug)?.description}"`,
    ]).filter((line): line is string => line !== null);
    assert.deepStrictEqual(wrong, []);
  });
});
