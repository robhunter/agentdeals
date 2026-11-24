import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { yearGuideRedirect } from "../dist/year-guide-redirect.js";

const guides = [
  "accounting-software-pricing", "analytics-free-tier-comparison", "api-development-free-tier-comparison",
  "auth-comparison", "aws-free-tier", "azure-free-tier", "business-bank-account-fees",
  "cicd-free-tier-comparison", "cloud-free-tier-comparison", "company-formation-pricing",
  "database-free-tier-comparison", "digitalocean-free-tier", "email-comparison", "gcp-free-tier",
  "google-developer-program", "hosting-free-tier-comparison", "mistral-api-pricing",
  "monitoring-comparison", "security-free-tier-comparison", "serverless-free-tier-comparison",
  "storage-comparison", "testing-free-tier-comparison",
];
const excluded = ["hetzner-pricing", "whatsapp-business-api-pricing", "gemini-api-pricing", "events/google-cloud-next", "events/google-io", "events/microsoft-build", "openai-assistants-migration", "q2-pricing-preview"];

describe("year-named guide redirects", () => {
  it("accepts later years through next year while preserving reserved and dated paths", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    for (const guide of guides) {
      for (const year of [2027, 2028]) assert.equal(yearGuideRedirect(`/${guide}-${year}`, now), `/${guide}-2026`);
      for (const year of [2025, 2026, 2029]) assert.equal(yearGuideRedirect(`/${guide}-${year}`, now), null);
    }
    for (const path of excluded) assert.equal(yearGuideRedirect(`/${path}-2027`, now), null);
  });

  let server: ChildProcess;
  let base: string;
  before(async () => {
    server = spawn("node", ["dist/serve.js"], { env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" }, stdio: ["ignore", "ignore", "pipe"] });
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 20000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
      });
      server.on("error", reject);
    });
  });
  after(() => server?.kill());

  it("serves each eligible 2027 path as a redirect and keeps excluded paths unavailable", async () => {
    for (const guide of guides) {
      const response = await fetch(`${base}/${guide}-2027`, { redirect: "manual" });
      assert.equal(response.status, 301, guide);
      assert.equal(response.headers.get("location"), `/${guide}-2026`);
    }
    for (const path of excluded) {
      const response = await fetch(`${base}/${path}-2027`, { redirect: "manual" });
      assert.equal(response.status, 404, path);
    }
    for (const name of ["vendors", "comparisons", "pages", "reports", "misc"]) {
      const sitemap = await (await fetch(`${base}/sitemap-${name}.xml`)).text();
      for (const guide of guides) assert.ok(!sitemap.includes(`/${guide}-2027`), `${name}: ${guide}`);
    }
  });
});
