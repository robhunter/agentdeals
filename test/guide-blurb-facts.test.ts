import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const WITHDRAWN: Record<string, RegExp> = {
  "a self-hosted runner fee GitHub charges": /self-hosted runners? (?:now )?costs?\b|self-hosted runner (?:charges|costs) introduced|introduced self-hosted runner charges|private repos pay \$0\.002|private: \$0\.002|\$0\.002\/min \(private\)|runners now \$0\.002/i,
  "Mailgun's free tier removed": /Mailgun (?:had already |has )?(?:killed|eliminated|removed|dropped)|Mailgun and [^.;]{0,40} (?:have|has) (?:since )?dropped their free tiers|Mailgun free tier gone|Why not Mailgun: Free tier removed|Sinch 2021, free tier removed|Mailgun<span class="removed-badge">/i,
  "a SendGrid free tier of 100 a day": /SendGrid (?:restricted|down) to 100\/day|SendGrid gives you 100 emails\/day|SendGrid<\/strong> (?:cut|slashed) its free tier|SendGrid slashed its free tier/i,
  "Redis under the BSL": /Redis switched to BSL|Business Source License \(BSL\)|Redis \(BSL\)|free under BSL|<td>BSL restrictions<\/td>/i,
  "Auth0's Essentials at $240": /Essential plan starting at|\$240\/month for just 500/i,
  "30+ always-free GCP products": /30\+ always-free products/i,
};

const CONTROLS: Record<string, string> = {
  "/redis-alternatives": "<td>BSL 1.1</td>",
  "/email-comparison-2026": "SendGrid permanently eliminated its free tier",
  "/github-actions-alternatives": "Pricing Postponed",
};

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

describe("guides and their blurbs state the vendor facts the vendors' pages state", () => {
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
    const routes = new Set<string>(Object.keys(CONTROLS));
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads enough of the site to carry the guide list and every named guide", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    for (const route of ["/github-actions-alternatives", "/ci-cd-alternatives", "/auth0-alternatives", "/redis-alternatives", "/email-service-alternatives", "/q1-2026-developer-pricing-report"]) {
      assert.ok(served.has(route), `${route} was not read`);
    }
  });

  it("states none of the withdrawn vendor facts on any guide, report or page, in body, meta or structured data", () => {
    const found = [...served].flatMap(([route, html]) =>
      Object.entries(WITHDRAWN)
        .filter(([, pattern]) => pattern.test(html))
        .map(([claim, pattern]) => `${route}: ${claim} ("${html.match(pattern)![0]}")`)
    );
    assert.deepStrictEqual(found, []);
  });

  it("keeps the facts that were right: DragonflyDB's BSL, SendGrid's ended free plan and GitHub's postponed fee", () => {
    const missing = Object.entries(CONTROLS)
      .filter(([route, text]) => !served.get(route)?.includes(text))
      .map(([route, text]) => `${route}: ${text}`);
    assert.deepStrictEqual(missing, []);
  });
});
