import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const GUIDES_LISTING_PART_OF_THE_VENDORS_FREE_SERVICES = ["azure-free-tier-2026", "aws-free-tier-2026"];
const GUIDE_LISTING_ALL_OF_THE_VENDORS_FREE_SERVICES = "gcp-free-tier-2026";

const CLAIMS_TO_COVER_EVERYTHING = /\bcomplete\b|\bcomprehensive\b|\bevery (?:free|AWS|Azure)\b/i;

let server: ChildProcess;
let base = "";

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

async function pageText(route: string): Promise<string> {
  const response = await fetch(`${base}${route}`);
  assert.strictEqual(response.status, 200, route);
  return response.text();
}

async function placesNaming(slug: string): Promise<Record<string, string>> {
  const guides = await pageText("/guides");
  const alternatives = await pageText("/localstack-alternatives");
  const relatedOn = await pageText("/digitalocean-free-tier-2026");
  const { getGuideList } = await import("../dist/guides.js");
  const mcp = getGuideList().find((guide: { slug: string }) => guide.slug === slug);
  return {
    "/guides card": textOf(guides.match(new RegExp(`<a href="/${slug}" class="guide-card">([\\s\\S]*?)</a>`))?.[1] ?? ""),
    "/localstack-alternatives guide list": textOf(alternatives.match(new RegExp(`<li><a href="/${slug}">([\\s\\S]*?)</li>`))?.[1] ?? ""),
    "/digitalocean-free-tier-2026 related link": textOf(relatedOn.match(new RegExp(`href="/${slug}" class="related-page-link">([\\s\\S]*?)</a>`))?.[1] ?? ""),
    "MCP guide list": mcp ? `${mcp.title} ${mcp.description}` : "",
  };
}

describe("the guides whose tables list part of the vendor's free services are not called complete where other pages name them", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
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
  });
  after(() => {
    server?.kill();
  });

  it("finds each guide on the guide list, an alternatives page's guide list, another guide's related links and the MCP guide list", async () => {
    for (const slug of [...GUIDES_LISTING_PART_OF_THE_VENDORS_FREE_SERVICES, GUIDE_LISTING_ALL_OF_THE_VENDORS_FREE_SERVICES]) {
      const missing = Object.entries(await placesNaming(slug)).filter(([, text]) => text === "").map(([place]) => place);
      assert.deepStrictEqual(missing, [], slug);
    }
  });

  it("names and describes the Azure and AWS guides nowhere as complete or as covering every free service", async () => {
    const claims: string[] = [];
    for (const slug of GUIDES_LISTING_PART_OF_THE_VENDORS_FREE_SERVICES) {
      for (const [place, text] of Object.entries(await placesNaming(slug))) {
        if (CLAIMS_TO_COVER_EVERYTHING.test(text)) claims.push(`${slug} on ${place}: ${text}`);
      }
    }
    assert.deepStrictEqual(claims, []);
  });

  it("still calls the GCP guide complete, since its table lists every product on Google's free list", async () => {
    const places = await placesNaming(GUIDE_LISTING_ALL_OF_THE_VENDORS_FREE_SERVICES);
    assert.ok(CLAIMS_TO_COVER_EVERYTHING.test(places["/guides card"]), places["/guides card"]);
  });
});
