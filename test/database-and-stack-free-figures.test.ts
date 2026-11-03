import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const UPSTASH_REDIS_PER_DAY = /10,000 (?:Redis )?commands|10K (?:Redis )?(?:commands|cmds)\/day/;
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
    "Serverless Redis with a generous free tier: 500K commands/month, 250 MB of data.",
    "When you exceed 500K commands/month.",
    "Upstash's 500K commands/month free tier covers moderate task queue usage",
    "When you exceed 500,000 Redis commands a month.",
    "cache/Redis (500K cmds/mo)",
  ],
  "/free-fastapi-stack": [
    "Serverless Redis with async support. Free tier: 500K commands/month, 250 MB of data.",
    "When you exceed 500K commands/month.",
    "When you exceed 500,000 Redis commands a month or need more than a single worker process.",
    "cache/Redis (500K cmds/mo)",
  ],
  "/free-go-stack": [
    "Serverless Redis with Go support. Free tier: 500K commands/month, 250 MB of data.",
    "Upstash's 500K commands/month covers moderate Asynq usage.",
    "Upstash Redis (500K commands a month free) works as the Asynq backend.",
    "cache/Redis (500K cmds/mo)",
  ],
  "/free-saas-stack": ["Upstash QStash (1,000 messages/day free)", "Upstash Redis (500K commands/month)"],
  "/free-nextjs-stack": ["QStash (Upstash) offers 1,000 messages/day"],
  "/database-pricing": [
    "Redis: 250 MB, 500K commands/month, 1 database. QStash: 1,000 messages/day, 3 retries.",
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
  "/free-django-stack": [
    ["Cache/Redis", "500K cmds/mo", "Pay-as-you-go $0.2/100K"],
    ["Task Queue", "500K cmds/mo", "Pay-as-you-go $0.2/100K"],
  ],
  "/free-fastapi-stack": [
    ["Cache/Redis", "500K cmds/mo", "Pay-as-you-go $0.2/100K"],
    ["Background Tasks", "500K cmds/mo", "Pay-as-you-go $0.2/100K"],
  ],
  "/free-go-stack": [["Cache/Redis", "500K cmds/mo", "Pay-as-you-go $0.2/100K"]],
};

const DJANGO_REDIS_ANSWER = "Upstash Redis offers 500,000 commands a month and 256 MB of data free.";

function faqAnswersOf(markup: string): string[] {
  const answers: string[] = [];
  for (const [, raw] of markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(raw);
    if (data["@type"] !== "FAQPage") continue;
    for (const question of data.mainEntity) answers.push(question.acceptedAnswer.text);
  }
  return answers;
}

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

  it("gives the Django stack's Redis answer the monthly figure in its FAQ structured data", () => {
    const answers = faqAnswersOf(html.get("/free-django-stack")!);
    assert.ok(answers.length > 0, "the Django stack page publishes no FAQPage structured data");
    assert.deepStrictEqual(answers.filter((answer) => answer.includes(DJANGO_REDIS_ANSWER)).length, 1);
  });

  for (const page of ["/free-django-stack", "/free-fastapi-stack", "/free-go-stack"]) {
    function railwaySection(): string {
      const sections = html.get(page)!.split('<div class="stack-category"');
      const railway = sections.filter((section) => {
        const name = section.match(/class="pick-name"[^>]*>([^<]+)</);
        return name && textOf(name[1]) === "Railway";
      });
      assert.strictEqual(railway.length, 1, page);
      return railway[0];
    }

    it(`${page} explains the Free credit's RAM budget and optional Serverless sleep`, () => {
      const section = railwaySection();
      const why = section.match(/<p class="pick-why">([\s\S]*?)<\/p>/);
      assert.ok(why, page);
      assert.ok(textOf(why[1]).includes("Railway does not put idle services to sleep unless Serverless is turned on. The Free plan gives $1 of credit a month. That pays for about 100 MB of RAM for a whole month at Railway's $10 per GB of RAM a month, before CPU. An always-on app that holds more than 100 MB uses more than $1."), page);
    });

    it(`${page} distinguishes outgrowing Free from Hobby's included usage`, () => {
      const section = railwaySection();
      const outgrow = section.match(/<div class="outgrow-box">([\s\S]*?)<\/div>/);
      assert.ok(outgrow, page);
      assert.ok(textOf(outgrow[1]).startsWith("When you'll outgrow it: You outgrow the Free plan when the app uses more than $1 of resources a month. Hobby costs $5 a month and includes $5 of usage, then charges only for usage beyond it."), page);
    });

    it(`${page} carries neither an always-warm promise nor the old Free threshold`, () => {
      assert.doesNotMatch(html.get(page)!, /stays warm|When you exceed the \$5 of usage that Hobby/i, page);
      assert.doesNotMatch(textOf(html.get(page)!), /stays warm|When you exceed the \$5 of usage that Hobby/i, page);
    });
  }

});
