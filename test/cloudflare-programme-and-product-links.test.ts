import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROGRAMME_PRICING_PAGE = /href="https:\/\/www\.cloudflare\.com\/(?:for)?startups\/"/;
const NAMES_THE_PROGRAMME = /^Cloudflare (?:\$\d+K|Startup Program|for Startups)$/;

let server: ChildProcess;
let base = "";

async function page(route: string): Promise<string> {
  const response = await fetch(`${base}${route}`);
  assert.strictEqual(response.status, 200, `${route} renders`);
  return response.text();
}

function linksNamedLike(html: string, name: RegExp): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a href="(\/vendor\/[^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map(([, href, text]) => ({ href, text: text.trim() }))
    .filter(({ text }) => name.test(text));
}

describe("links that name Cloudflare land on the listing they name, before and after the programme's rename", () => {
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

  it("sends each mention of the startup programme on the tracker and the state-of-free-tiers report to the programme's own listing", async () => {
    const links = [
      ...linksNamedLike(await page("/free-tier-tracker"), NAMES_THE_PROGRAMME),
      ...linksNamedLike(await page("/state-of-free-tiers"), NAMES_THE_PROGRAMME),
    ];
    assert.ok(links.length >= 3, `${links.length} links name the programme`);
    for (const { href, text } of links) {
      const landing = await page(href);
      assert.ok(!landing.includes("Did you mean?"), `"${text}" (${href}) lands on a list of vendors`);
      assert.match(landing, PROGRAMME_PRICING_PAGE, `"${text}" (${href}) lands on a page that is not the programme's`);
    }
  });

  it("previews a Cloudflare product's badge on /badges, not the startup programme's", async () => {
    const previewed = [...(await page("/badges")).matchAll(/class="preview-badge">\s*<img src="[^"]*\/badge\/([^"]+)\.svg"/g)].map(([, slug]) => slug);
    assert.ok(previewed.includes("cloudflare-workers"), previewed.join(", "));
    assert.ok(!previewed.includes("cloudflare") && !previewed.includes("cloudflare-for-startups"), previewed.join(", "));
  });

  it("names Cloudflare Workers among the cloud providers whose free tiers are loss leaders", async () => {
    const html = await page("/state-of-free-tiers");
    const card = html.slice(html.indexOf("Cloud Provider Loss Leaders"), html.indexOf("Developer-First Companies"));
    assert.deepStrictEqual(linksNamedLike(card, /^Cloudflare/), [{ href: "/vendor/cloudflare-workers", text: "Cloudflare Workers" }]);
  });

  it("offers no startup programme as an alternative on the Django stack, whose storage pick is Cloudflare R2", async () => {
    const html = await page("/free-django-stack");
    assert.ok(html.includes("Cloudflare R2"));
    assert.deepStrictEqual([...html.matchAll(/class="alt-chip">([^<]+)<span class="chip-tier">Startup Program</g)].map(([, name]) => name.trim()), []);
  });
});
