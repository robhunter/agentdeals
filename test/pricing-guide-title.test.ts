import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pricingGuideTitle } from "../dist/pricing-guide-title.js";

const guides = [
  ["accounting-software-pricing-2026", "Accounting Software 2026: Free Plans and Price Increases", "Accounting Software YEAR: Free Plans and Recent Price Increases"],
  ["business-bank-account-fees-2026", "Business Bank Accounts 2026: Free Plans, Fees and Changes", "Business Bank Accounts YEAR: Free Plans, Fees and Recent Changes"],
  ["company-formation-pricing-2026", "Forming a US Company in 2026: Costs and Changes", "Forming a US Company in YEAR: Costs and Recent Changes"],
];

const alternatives = [
  "localstack-alternatives", "postman-alternatives", "freshping-alternatives",
  "firebase-alternatives", "github-actions-alternatives", "cursor-alternatives",
  "datadog-alternatives", "vercel-alternatives", "auth0-alternatives",
  "mongodb-alternatives", "redis-alternatives",
];

describe("pricing guide titles", () => {
  it("rolls over on December 10 and adopts recent-change wording in 2027", () => {
    for (const [slug, original, future] of guides) {
      assert.equal(pricingGuideTitle(slug, original, new Date("2026-12-09T23:59:59Z")), original);
      assert.equal(pricingGuideTitle(slug, original, new Date("2026-12-10T00:00:00Z")), original.replace("2026", "2026–2027"));
      assert.equal(pricingGuideTitle(slug, original, new Date("2027-01-01T00:00:00Z")), future.replace("YEAR", "2027"));
      assert.equal(pricingGuideTitle(slug, original, new Date("2027-12-15T00:00:00Z")), future.replace("YEAR", "2027–2028"));
    }
  });
});

it("renders the same title in the page and guide list across the boundary", async () => {
  const { spawn } = await import("node:child_process");
  for (const [instant, label, recent] of [
    ["2026-12-09T12:00:00Z", "2026", false],
    ["2026-12-10T12:00:00Z", "2026–2027", false],
    ["2027-01-01T12:00:00Z", "2027", true],
    ["2027-12-15T12:00:00Z", "2027–2028", true],
  ] as const) {
    const server = spawn("node", ["--import", "./scripts/shifted-clock.mjs", "dist/serve.js"], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(instant) - Date.now()) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const base = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server startup timeout")), 20000);
        server.stderr!.on("data", (data: Buffer) => {
          const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
          if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
        });
        server.on("error", reject);
        server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
      });
      const llms = await (await fetch(`${base}/llms.txt`)).text();
      for (const [slug, original, future] of guides) {
        const expected = recent ? future.replace("YEAR", label) : original.replace("2026", label);
        const page = await (await fetch(`${base}/${slug}`)).text();
        assert.ok(page.includes(`<h1>${expected}</h1>`), `${instant}: ${slug} heading`);
        assert.ok(page.includes(`<title>${expected} — AgentDeals</title>`), `${instant}: ${slug} title`);
        assert.ok(page.includes(`"headline":"${expected}"`), `${instant}: ${slug} structured data`);
        assert.ok(llms.includes(`[${expected}](`), `${instant}: ${slug} guide list`);
      }
    } finally {
      server.kill();
    }
  }
});

it("updates guide metadata when a running server crosses the year boundaries", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "guide-clock-"));
  const clock = join(dir, "clock");
  const setClock = (instant: string) => writeFileSync(clock, String(Date.parse(instant)));
  setClock("2026-12-09T23:59:59Z");
  const server = spawn("node", ["--import", "./test/fixtures/file-clock.mjs", "dist/serve.js"], {
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", TEST_CLOCK_FILE: clock },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 20000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
      });
      server.on("error", reject);
      server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    });
    for (const [instant, label, recent] of [
      ["2026-12-09T23:59:59Z", "2026", false],
      ["2026-12-10T00:00:00Z", "2026–2027", false],
      ["2027-01-01T00:00:00Z", "2027", true],
      ["2027-12-15T00:00:00Z", "2027–2028", true],
    ] as const) {
      setClock(instant);
      const list = await (await fetch(`${base}/guides`)).text();
      for (const [slug, original, future] of guides) {
        const expected = recent ? future.replace("YEAR", label) : original.replace("2026", label);
        const page = await (await fetch(`${base}/${slug}`)).text();
        assert.ok(page.includes(`<h1>${expected}</h1>`), `${instant}: ${slug} heading`);
        assert.ok(list.includes(expected), `${instant}: ${slug} guide metadata`);
      }
      for (const slug of alternatives) {
        const page = await (await fetch(`${base}/${slug}`)).text();
        const title = page.match(/<title>(.*?) — AgentDeals<\/title>/)?.[1];
        assert.ok(title?.includes(label), `${instant}: ${slug} page title`);
        assert.ok(list.includes(title.replaceAll("&amp;", "&")), `${instant}: ${slug} guide metadata`);
      }
    }
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
