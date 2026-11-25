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
  "mongodb-alternatives", "redis-alternatives", "email-service-alternatives",
  "ai-free-tiers", "database-alternatives", "hosting-alternatives",
  "monitoring-alternatives", "ci-cd-alternatives", "security-alternatives",
  "storage-alternatives", "testing-alternatives", "analytics-alternatives",
  "ai-ml-alternatives", "design-alternatives", "email-alternatives",
  "project-management-alternatives", "ide-code-editors-alternatives",
  "free-llm-apis", "api-development-alternatives", "team-collaboration-alternatives",
  "free-startup-stack", "free-ai-stack", "free-devops-stack", "free-frontend-stack",
  "free-nextjs-stack", "free-django-stack", "free-fastapi-stack", "free-go-stack", "free-saas-stack",
];

const comparisonQuestions = [
  ["cloud-free-tier-comparison-2026", "cloud IaaS"],
  ["database-free-tier-comparison-2026", "database"],
  ["cicd-free-tier-comparison-2026", "CI/CD"],
  ["auth-comparison-2026", "auth"],
  ["email-comparison-2026", "email"],
  ["monitoring-comparison-2026", "monitoring"],
  ["storage-comparison-2026", "storage"],
  ["testing-free-tier-comparison-2026", "testing"],
  ["analytics-free-tier-comparison-2026", "analytics"],
  ["api-development-free-tier-comparison-2026", "API development"],
  ["security-free-tier-comparison-2026", "security"],
  ["hosting-free-tier-comparison-2026", "cloud hosting"],
];

const otherQuestions = [
  ["free-django-stack", "Can I host Django for free in YEAR?", false],
  ["free-fastapi-stack", "Can I host FastAPI for free in YEAR?", false],
  ["free-go-stack", "Can I host Go for free in YEAR?", false],
  ["free-saas-stack", "What's the cheapest way to launch a SaaS in YEAR?", false],
  ["free-tier-risk", "Which free tiers are safest to build on in YEAR?", true],
  ["ai-coding-tools-pricing", "Which AI coding tools are free in YEAR?", true],
  ["database-pricing", "Which database has the best free tier in YEAR?", true],
  ["hosting-pricing", "What is the best free cloud hosting platform in YEAR?", true],
  ["llm-api-pricing", "Which LLM API has the best free tier in YEAR?", true],
] as const;

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
      const saas = await (await fetch(`${base}/free-saas-stack`)).text();
      assert.ok(saas.includes(`<h1>The Complete Free SaaS Starter Stack for ${label}</h1>`), `${instant}: SaaS heading`);
      for (const [slug, template, visible] of otherQuestions) {
        const response = await fetch(`${base}/${slug}`);
        assert.equal(response.status, 200, `${instant}: ${slug} status`);
        const page = await response.text();
        const question = template.replace("YEAR", label);
        assert.ok(page.includes(`"name":${JSON.stringify(question)}`), `${instant}: ${slug} structured question`);
        if (visible) {
          const body = page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
          assert.ok(body.includes(question), `${instant}: ${slug} visible question`);
        }
      }
      for (const slug of ["ai-coding-tools-pricing", "ci-cd-pricing", "database-pricing", "vector-database-pricing", "hosting-pricing"]) {
        const page = await (await fetch(`${base}/${slug}`)).text();
        const title = page.match(/<title>(.*?)<\/title>/)?.[1].replace(/ (?:—|&mdash;) AgentDeals$/, "");
        assert.ok(title?.includes(label), `${instant}: ${slug} title`);
        assert.ok(page.match(/<h1>(.*?)<\/h1>/)?.[1].includes(label), `${instant}: ${slug} heading`);
        assert.ok(list.includes(title.replaceAll("&amp;", "&")), `${instant}: ${slug} guide title`);
        const article = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
          .map(match => JSON.parse(match[1])).find(value => value["@type"] === "Article");
        assert.ok(article?.headline.includes(label), `${instant}: ${slug} structured title`);
      }
      for (const slug of ["google-developer-program-2026", "aws-free-tier-2026", "gcp-free-tier-2026", "azure-free-tier-2026", "digitalocean-free-tier-2026"]) {
        const page = await (await fetch(`${base}/${slug}`)).text();
        const title = page.match(/<title>(.*?)<\/title>/)?.[1].replace(/ (?:—|&mdash;) AgentDeals$/, "");
        assert.ok(title?.includes(label), `${instant}: ${slug} title`);
        assert.ok(list.includes(title.replaceAll("&amp;", "&")), `${instant}: ${slug} guide title`);
        if (slug !== "google-developer-program-2026") {
          assert.ok(page.match(/<h1>(.*?)<\/h1>/)?.[1].includes(label), `${instant}: ${slug} heading`);
        }
        if (slug === "gcp-free-tier-2026" || slug === "digitalocean-free-tier-2026") {
          assert.ok(page.match(/<meta name="description" content="([^"]*)"/)?.[1].includes(label), `${instant}: ${slug} description`);
        }
        const article = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
          .map(match => JSON.parse(match[1])).find(value => value["@type"] === "Article");
        assert.ok(article?.headline.includes(label), `${instant}: ${slug} structured title`);
      }
      const llm = await (await fetch(`${base}/llm-api-pricing`)).text();
      assert.ok(llm.match(/<title>(.*?)<\/title>/)?.[1].includes(label), `${instant}: LLM title`);
      assert.ok(llm.match(/<h1>(.*?)<\/h1>/)?.[1].includes(label), `${instant}: LLM heading`);
      assert.ok(llm.match(/<meta name="description" content="([^"]*)"/)?.[1].includes(label), `${instant}: LLM description`);
      assert.ok(list.includes(`LLM API Free Tiers & Free Credits ${label}`), `${instant}: LLM guide title`);
      const serverless = await (await fetch(`${base}/serverless-free-tier-comparison-2026`)).text();
      assert.ok(serverless.match(/<title>(.*?)<\/title>/)?.[1].includes(label), `${instant}: serverless title`);
      assert.ok(serverless.match(/<h1>(.*?)<\/h1>/)?.[1].includes(label), `${instant}: serverless heading`);
      assert.ok(serverless.match(/<meta name="description" content="([^"]*)"/)?.[1].includes(label), `${instant}: serverless description`);
      for (const [slug, noun] of comparisonQuestions) {
        const page = await (await fetch(`${base}/${slug}`)).text();
        {
          const title = page.match(/<title>(.*?)<\/title>/)?.[1].replace(/ (?:—|&mdash;) AgentDeals$/, "");
          const heading = page.match(/<h1>(.*?)<\/h1>/)?.[1];
          const description = page.match(/<meta name="description" content="([^"]*)"/)?.[1];
          assert.ok(title?.includes(label), `${instant}: ${slug} title`);
          assert.ok(heading?.includes(label), `${instant}: ${slug} heading`);
          assert.ok(description?.includes(label), `${instant}: ${slug} description`);
          const article = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
            .map(match => JSON.parse(match[1])).find(value => value["@type"] === "Article");
          assert.ok(article?.headline.includes(label), `${instant}: ${slug} structured title`);
          assert.ok(article?.description.includes(label), `${instant}: ${slug} structured description`);
          assert.ok(list.includes(title.replaceAll("&amp;", "&")), `${instant}: ${slug} guide title`);
        }
        const question = `What is the best free ${noun} service in ${label}?`;
        assert.ok(page.includes(`<h3 style="margin:0 0 .5rem;font-size:1rem;color:var(--text)">${question}</h3>`), `${instant}: ${slug} visible question`);
        assert.ok(page.includes(`"name":"${question}"`), `${instant}: ${slug} structured question`);
      }
    }
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
