import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const UPSTASH_REDIS_PER_DAY = /10,000 commands\/day|10K commands\/day/;
const QSTASH_AT_500 = /500 messages\/day/;

const WITHDRAWN: Record<string, Record<string, RegExp>> = {
  "/free-django-stack": { "Upstash Redis counted per day": UPSTASH_REDIS_PER_DAY },
  "/free-fastapi-stack": { "Upstash Redis counted per day": UPSTASH_REDIS_PER_DAY },
  "/free-go-stack": { "Upstash Redis counted per day": UPSTASH_REDIS_PER_DAY },
  "/free-saas-stack": { "Upstash Redis counted per day": UPSTASH_REDIS_PER_DAY, "QStash at 500 messages a day": QSTASH_AT_500 },
  "/free-nextjs-stack": { "QStash at 500 messages a day": QSTASH_AT_500 },
  "/database-pricing": {
    "Upstash Redis counted per day": UPSTASH_REDIS_PER_DAY,
    "QStash at 500 messages a day": QSTASH_AT_500,
    "10 GiB of free Nile storage": /10 GiB free|Nile[\s\S]{0,600}?10 GiB/,
  },
  "/vector-database-pricing": {
    "Upstash Vector's free plan as 10K vectors": /~10K vectors|10,000 vectors|10K vectors is/,
    "Upstash Vector at 150K queries a day": /150K queries\/day|150,000 query units|150K query units/,
  },
  "/database-alternatives": { "Upstash Vector's free plan as 10K vectors": /256 MB \+ 10K vectors|\(10K vectors, serverless\)/ },
  "/database-free-tier-comparison-2026": { "Upstash Vector's free plan as 10K vectors": /Upstash Vector \(10K vectors\)/ },
  "/monitoring-comparison-2026": { "Sentry's Developer plan keeping data 90 days": /Developer tier\. 90-day retention/ },
  "/aws-app-runner-migration": { "Fly.io as a free alternative with 3 free VMs": /3 free VMs/ },
};

const STATED: Record<string, string[]> = {
  "/free-django-stack": [
    "Serverless Redis with a generous free tier: 500K commands/month, 256 MB storage.",
    "When you exceed 500K commands/month.",
    "Upstash's 500K commands/month free tier covers moderate task queue usage",
  ],
  "/free-fastapi-stack": [
    "Serverless Redis with async support. Free tier: 500K commands/month, 256 MB storage.",
    "When you exceed 500K commands/month.",
  ],
  "/free-go-stack": [
    "Serverless Redis with Go support. Free tier: 500K commands/month, 256 MB storage.",
    "Upstash's 500K commands/month covers moderate Asynq usage.",
  ],
  "/free-saas-stack": ["Upstash QStash (1,000 messages/day free)", "Upstash Redis (500K commands/month)"],
  "/free-nextjs-stack": ["QStash (Upstash) offers 1,000 messages/day"],
  "/database-pricing": [
    "Redis: 256 MB, 500K commands/month, 1 database. QStash: 1,000 messages/day, 3 retries.",
    "500K commands/month is tight for production use.",
    "1 GB storage, unlimited tenants, built-in tenant isolation for SaaS applications.",
    "built-in isolation. 1 GB free. The only database with first-class tenant primitives.",
  ],
  "/vector-database-pricing": [
    "Serverless vector database: 200M vectors × dimensions, 1,536 dimensions, 10,000 queries/day.",
    "Upstash Vector (10K queries/day free)",
  ],
  "/database-alternatives": ["Upstash Vector (200M vectors × dimensions free, serverless)"],
  "/database-free-tier-comparison-2026": ["For simple RAG prototypes, Upstash Vector (200M vectors × dimensions free) gets you started fastest."],
  "/monitoring-comparison-2026": ["5K errors/month on Developer tier. 30-day retention."],
  "/aws-app-runner-migration": [
    "Google Cloud Run (2M requests/mo free, scale to zero) and Render (free tier with 750 hrs/mo) both offer container deployment with free tiers",
  ],
};

const ROWS: Record<string, string[][]> = {
  "/database-pricing": [
    ["Nile", "PostgreSQL (Multi-tenant)", "1 GB", "500", "$15/mo (Pro)"],
    ["Nile", "Generous free tier", "1 GB"],
    ["Nile", "$0", "$15+"],
  ],
  "/vector-database-pricing": [["Upstash Vector", "Serverless (HTTP)", "200M vectors × dimensions", "1 GB", "1,536"]],
  "/database-alternatives": [["Upstash", "Redis / Vector", "256 MB + 200M vectors × dimensions"]],
};

const PAGES = [...new Set([...Object.keys(WITHDRAWN), ...Object.keys(STATED), ...Object.keys(ROWS)])].sort();

let server: ChildProcess;
const html = new Map<string, string>();

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&times;/g, "×")
    .replace(/&nearr;/g, "")
    .replace(/&nbsp;/g, " ");
}

function textOf(markup: string): string {
  return decode(
    markup
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

const CITATION_ANCHOR = new RegExp(`<a [^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

function namedFor(firstCell: string, name: string): boolean {
  return firstCell === name || firstCell.startsWith(`${name} `);
}

function rowsOf(markup: string): string[][] {
  return [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), ""))))
    .filter((cells) => cells.length >= 2);
}

describe("database and stack pages state Upstash, QStash, Upstash Vector, Nile, Sentry and Fly.io free terms as each vendor's page does", () => {
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
    for (const page of PAGES) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, page);
      html.set(page, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("serves none of the withdrawn figures on the pages that carried them", () => {
    const found = Object.entries(WITHDRAWN).flatMap(([page, claims]) =>
      Object.entries(claims)
        .filter(([, pattern]) => pattern.test(html.get(page)!))
        .map(([claim, pattern]) => `${page}: ${claim} ("${html.get(page)!.match(pattern)![0].slice(0, 80)}")`));
    assert.deepStrictEqual(found, []);
  });

  it("states each vendor's free figures in the corrected sentences", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const text = textOf(html.get(page)!);
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("puts the corrected figures in the Nile, Upstash Vector and Upstash table rows", () => {
    const missing = Object.entries(ROWS).flatMap(([page, expected]) => {
      const rows = rowsOf(html.get(page)!);
      return expected
        .filter(([name, ...cells]) => !rows.some((row) => namedFor(row[0], name) && cells.every((cell) => row.includes(cell))))
        .map((cells) => `${page}: ${cells.join(" | ")}`);
    });
    assert.deepStrictEqual(missing, []);
  });
});
