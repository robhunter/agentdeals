import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATED: Record<string, string[]> = {
  "/free-django-stack": [
    "Supabase Storage gives 1 GB free. Image transformations require the Pro plan or above.",
    "When you exceed 50,000 records or 10,000 searches/month.",
    "Meilisearch Cloud has no free plan. It starts at $20 a month and offers a 14-day free trial with no credit card required.",
    "Inngest offers 50,000 executions/month free but",
    "50,000 records and 10,000 search requests/month on the free tier.",
    "Clerk gives 50,000 MRU per app free with pre-built UI components.",
    "search (50K records)",
    "5M spans"
  ],
  "/free-fastapi-stack": [
    "Supabase Storage gives 1 GB free. Image transformations require the Pro plan or above.",
    "Clerk offers 50,000 MRU per app free with pre-built UI components",
    "5M spans"
  ],
  "/free-go-stack": [
    "Supabase Storage gives 1 GB free. Image transformations require the Pro plan or above.",
    "Clerk offers 50,000 MRU per app free with pre-built UI",
    "5M spans"
  ],
  "/free-nextjs-stack": [
    "When you exceed 50,000 records or 10,000 searches/month.",
    "Meilisearch Cloud has no free plan. It starts at $20 a month and offers a 14-day free trial with no credit card required.",
    "When you exceed 50,000 executions/month.",
    "Trigger.dev's free plan includes $5 of compute credits monthly and allows 20 concurrent runs. It has a more code-first approach.",
    "When you exceed 50,000 MRU per app, Pro costs $25 a month with 50,000 MRU included, then $0.02 per extra MRU. At 100,000 MRU, it costs $1,025 a month.",
    "Free tier: 50,000 executions/month",
    "50,000 records and 10,000 search requests/month on the free tier.",
    "auth (Clerk 50K MRU)",
    "search (Algolia 50K records)",
    "background jobs (Inngest 50K executions)",
    "auth (50K MRU)",
    "search (50K records)",
    "jobs (50K executions)",
    "5M spans",
    "Free tier: 50,000 monthly retained users (MRU) per app, unlimited social logins, email/password, organizations, and webhooks. MFA needs Pro ($25/month)."
  ],
  "/free-saas-stack": [
    "When you exceed 50,000 executions/month. Trigger.dev's free plan includes $5 of compute credits monthly and allows 20 concurrent runs.",
    "Free tier: 50,000 executions/month with 5 concurrent steps.",
    "Inngest (50K background job executions)",
    "5M spans"
  ],
  "/security-alternatives": [
    "Clerk (50K MRU per app free)"
  ],
  "/stacks/saas-mvp": [
    "Most generous free auth. Drop-in components and organizations, free up to 50K MRU per app; MFA needs Pro."
  ]
};

const WITHDRAWN: Record<string, string[]> = {
  "/free-django-stack": [
    "Supabase Storage gives 1 GB free with image transformations.",
    "When you exceed 10,000 records or 10,000 searches/month.",
    "Meilisearch Cloud offers 100,000 documents free.",
    "Inngest offers 25,000 function runs/month but",
    "10,000 records and 10,000 search requests/month on the free tier.",
    "Clerk gives 10,000 MAU with pre-built UI components.",
    "search (10K records)",
    "10,000 performance transactions"
  ],
  "/free-fastapi-stack": [
    "Supabase Storage gives 1 GB free with image transformations.",
    "Clerk offers 10,000 MAU free with pre-built UI components",
    "10,000 performance transactions"
  ],
  "/free-go-stack": [
    "Supabase Storage gives 1 GB free with image transformations.",
    "Clerk offers 10,000 MAU with pre-built UI",
    "10,000 performance transactions"
  ],
  "/free-nextjs-stack": [
    "When you exceed 10,000 records or 10,000 searches/month.",
    "Meilisearch Cloud offers 100,000 documents free.",
    "When you exceed 25,000 runs/month.",
    "Trigger.dev gives 50,000 runs/month with a more code-first approach.",
    "When you exceed 10,000 MAU ($0.02/MAU overage \u2014 $1,800/month at 100K MAU).",
    "Free tier: 25,000 function runs/month",
    "10,000 records and 10,000 search requests/month on the free tier.",
    "auth (Clerk 10K MAU)",
    "search (Algolia 10K records)",
    "background jobs (Inngest 25K runs)",
    "auth (10K MAU)",
    "search (10K records)",
    "jobs (25K runs)",
    "10,000 performance transactions",
    "Free tier: 10,000 monthly active users, unlimited social logins, email/password, MFA, organizations, and webhooks."
  ],
  "/free-saas-stack": [
    "When you exceed 25,000 runs/month. Trigger.dev offers 10,000 runs/month free with a similar developer experience.",
    "Free tier: 25,000 function runs/month with 5 concurrent steps.",
    "Inngest (25K background job runs)",
    "10,000 performance transactions"
  ],
  "/security-alternatives": [
    "Clerk (10K MAU)"
  ]
};

const ROWS: Record<string, string[][]> = {
  "/security-alternatives": [
    [
      "Clerk",
      "Identity / Auth",
      "50K MRU per app"
    ]
  ],
  "/free-nextjs-stack": [
    [
      "Auth",
      "50,000 MRU per app",
      "Pro $25/mo",
      "50,000 MRU, then $0.02 each; no Clerk branding"
    ],
    [
      "Search",
      "50,000 records",
      "Grow, $0.50 per 1K requests past 10K",
      "100,000 records, then $0.40 per 1K records"
    ],
    [
      "Jobs",
      "50,000 executions/mo",
      "Pro from $99/mo",
      "1M executions, 100+ concurrent steps"
    ]
  ],
  "/free-django-stack": [
    [
      "Search",
      "50,000 records",
      "Grow, $0.50 per 1K requests past 10K",
      "100,000 records, then $0.40 per 1K records"
    ]
  ],
  "/free-saas-stack": [
    [
      "Background Jobs",
      "50K executions/mo",
      "Pro from $99/mo",
      "$99/mo (1M executions)"
    ]
  ]
};

function textOf(markup: string): string {
  return markup.replace(/<\/?(?:a|strong|span|em|b|code|small)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

const pages = [...new Set([...Object.keys(STATED), ...Object.keys(ROWS), "/estimate", "/budget-builder"])];
const html = new Map<string, string>();
let server: ChildProcess;

describe("stack guides state current free allowances and paid upgrade terms", () => {
  before(async () => {
    server = spawn("node", [path.join(ROOT, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const port = data.toString().match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve(`http://localhost:${port}`); }
      });
      server.on("error", error => { clearTimeout(timer); reject(error); });
    });
    for (const page of pages) {
      const response = await fetch(base + page);
      assert.equal(response.status, 200, page);
      html.set(page, await response.text());
    }
  });
  after(() => server?.kill());

  for (const page of Object.keys(STATED)) {
    it(`states corrected terms and omits withdrawn figures on ${page}`, () => {
      const body = textOf(html.get(page)!);
      for (const line of STATED[page]) assert.ok(body.includes(line), `${page}: ${line}`);
      for (const line of WITHDRAWN[page] ?? []) assert.ok(!body.includes(line), `${page}: ${line}`);
    });
  }

  for (const [page, expected] of Object.entries(ROWS)) {
    it(`puts each free allowance and paid price in its own table column on ${page}`, () => {
      const rows = [...html.get(page)!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
        .map(([, row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell)));
      for (const cells of expected) {
        const matches = rows.filter(row => row[0] === cells[0] || row[0]?.startsWith(`${cells[0]} `));
        assert.equal(matches.length, 1, `${page}: ${cells[0]}`);
        assert.deepEqual(matches[0].slice(0, cells.length), cells);
      }
    });
  }

  it("includes Clerk's complete 100K price in the SaaS template row and total", () => {
    const markup = html.get("/stacks/saas-mvp")!;
    const row = [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(([, body]) => [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell)))
      .find(cells => cells[0] === "Auth");
    assert.ok(row);
    assert.match(row[1], /^Clerk/);
    assert.deepEqual(row.slice(3), ["$0", "$0", "$0", "$1,025"]);
    const summary = markup.match(/<div class="cost-summary">([\s\S]*?)<\/div>\s*<\/div>/)?.[1];
    assert.ok(summary);
    assert.ok(textOf(summary).includes("$1,441/mo"));
  });

  for (const page of ["/estimate", "/budget-builder"]) {
    it(`carries Clerk's retained-user allowance and complete 100K price into ${page}`, () => {
      const data = html.get(page)!;
      assert.match(data, /"slug":"clerk","name":"Clerk","free":"50K MRU","starter":0,"growth":0,"scale":1025,"notes":"Pro \$25\/mo, then \$0\.02\/MRU past 50K"/);
      assert.ok(!data.includes("Pro $0.02/MAU after 10K on Pro plan"));
    });
  }
});
