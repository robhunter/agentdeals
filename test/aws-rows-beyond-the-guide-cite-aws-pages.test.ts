import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { RECORD_SOURCE_CLASS } = await import("../dist/change-citation.js");
const { monthlyEgressGrantGb } = await import("../dist/storage-cost-model.js");

const AWS_FREE_PAGE = "https://aws.amazon.com/free/";
const LAMBDA_PRICING = "https://aws.amazon.com/lambda/pricing/";
const COGNITO_PRICING = "https://aws.amazon.com/cognito/pricing/";

const SERVERLESS = "/serverless-free-tier-comparison-2026";
const AUTH = "/auth-comparison-2026";
const STORAGE = "/storage-comparison-2026";
const ALTERNATIVES_GUIDES = ["/gcp-free-tier-2026", "/azure-free-tier-2026", "/digitalocean-free-tier-2026"];
const AWS_GUIDE = "/aws-free-tier-2026";
const CI_CD_PRICING = "/ci-cd-pricing";
const CLOUD_COMPARISON = "/cloud-free-tier-comparison-2026";

const CLOUD_ROWS_ON_AWS_FREE_PAGE = ["EC2", "RDS (MySQL/PostgreSQL)"];
const CLOUD_S3_AND_CLOUDFRONT = "S3: no free storage (paid from credits)";

const APP_RUNNER_FREE_TIER = "Closed to new customers since April 30, 2026. Existing customers only.";
const APP_RUNNER_BEST_FOR = "For existing App Runner customers. New customers use ECS Express Mode.";
const APP_RUNNER_SENTENCES = "AWS App Runner closed to new customers on April 30, 2026. New AWS accounts cannot use it. AWS recommends Amazon ECS Express Mode instead.";

const CITED_CELLS: Array<{ page: string; row: string; cell: string; source: string }> = [
  { page: SERVERLESS, row: "AWS Lambda", cell: "400K GB-sec/mo", source: LAMBDA_PRICING },
  { page: SERVERLESS, row: "AWS Lambda", cell: "400K GB-sec", source: LAMBDA_PRICING },
  { page: SERVERLESS, row: "AWS App Runner", cell: APP_RUNNER_FREE_TIER, source: "https://aws.amazon.com/apprunner/" },
  { page: AUTH, row: "AWS Cognito", cell: "10K MAU (50K for Lite pools created by Nov 22, 2024)", source: COGNITO_PRICING },
  { page: AUTH, row: "AWS Cognito", cell: "10,000", source: COGNITO_PRICING },
  { page: AUTH, row: "AWS Cognito", cell: "$0 (free)", source: COGNITO_PRICING },
  { page: STORAGE, row: "AWS S3", cell: `${monthlyEgressGrantGb("AWS S3")} GB/mo, no expiry`, source: "https://aws.amazon.com/s3/pricing/" },
  { page: CLOUD_COMPARISON, row: "AWS", cell: "$100 + up to $100", source: "https://aws.amazon.com/free/free-tier-faqs/" },
  { page: CLOUD_COMPARISON, row: "AWS", cell: "25 GB, 25 WCU/RCU", source: "https://aws.amazon.com/dynamodb/pricing/" },
  { page: CLOUD_COMPARISON, row: "AWS", cell: "Up to 4 ACUs and 1 GiB per cluster, paid from the Free plan's credits", source: "https://aws.amazon.com/rds/aurora/pricing/" },
  { page: CLOUD_COMPARISON, row: "AWS", cell: "1M requests/mo", source: LAMBDA_PRICING },
  { page: CLOUD_COMPARISON, row: "AWS", cell: "Up to $200K", source: "https://aws.amazon.com/activate/credits/" },
];

const PAGES = [SERVERLESS, AUTH, STORAGE, ...ALTERNATIVES_GUIDES, AWS_GUIDE, CI_CD_PRICING];
const FETCHED = [...PAGES, CLOUD_COMPARISON];

let server: ChildProcess;
const html = new Map<string, string>();

function textOf(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ANCHOR = /<a\b[^>]*>[\s\S]*?<\/a>/g;
const BADGE = /<span\b[^>]*>[\s\S]*?<\/span>/g;

function rowsOf(markup: string): string[][] {
  return [...markup.replace(/<script[\s\S]*?<\/script>/g, " ").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell))
    .filter((cells) => cells.length >= 2);
}

function nameOf(cell: string): string {
  return textOf(cell
    .replace(/<a\b[^>]*class="[^"]*"[^>]*>[\s\S]*?<\/a>|<a\b[^>]*style="display:inline-block[^>]*>[\s\S]*?<\/a>/g, "")
    .replace(BADGE, ""));
}

function figuresOf(cell: string): string {
  return textOf(cell.replace(ANCHOR, ""));
}

function linksIn(cell: string, cls: string): string[] {
  return [...cell.matchAll(/<a\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes(`class="${cls}"`))
    .map((tag) => tag.match(/href="([^"]*)"/)?.[1] ?? "");
}

function rowsNamed(page: string, name: string): string[][] {
  return rowsOf(html.get(page)!).filter((cells) => nameOf(cells[0]!) === name);
}

describe("AWS rows beyond the AWS guide cite a page that states their figures, or no page", () => {
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
    for (const page of FETCHED) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, page);
      html.set(page, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("links the AWS page that states the figures from the cell that holds them", () => {
    const wrong = CITED_CELLS.flatMap(({ page, row, cell, source }) => {
      const holding = rowsNamed(page, row).flatMap((cells) => cells.slice(1)).filter((one) => figuresOf(one) === cell);
      if (holding.length !== 1) return [`${page}: ${row}: ${holding.length} cells read "${cell}"`];
      const cited = linksIn(holding[0]!, FIGURE_SOURCE_CLASS);
      return cited.length === 1 && cited[0] === source ? [] : [`${page}: ${row}: "${cell}" links ${JSON.stringify(cited)}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("drops the catalogue record's link from every row that cites its own page", () => {
    const kept = CITED_CELLS.flatMap(({ page, row, cell }) =>
      rowsNamed(page, row)
        .filter((cells) => cells.slice(1).some((one) => figuresOf(one) === cell))
        .filter((cells) => cells.some((one) => linksIn(one, RECORD_SOURCE_CLASS).length > 0))
        .map(() => `${page}: ${row}: "${cell}"`));
    assert.deepStrictEqual(kept, []);
  });

  it("links no page from the AWS row of the alternatives table on the GCP, Azure and DigitalOcean guides", () => {
    const found = ALTERNATIVES_GUIDES.map((page) => {
      const rows = rowsNamed(page, "AWS");
      if (rows.length !== 1) return `${page}: ${rows.length} rows named AWS`;
      const outbound = rows[0]!.flatMap((cell) => [...cell.matchAll(/<a\b[^>]*href="(https?:[^"]*)"/g)].map(([, href]) => href));
      return outbound.length === 0 ? null : `${page}: AWS links ${JSON.stringify(outbound)}`;
    }).filter((line) => line !== null);
    assert.deepStrictEqual(found, []);
  });

  it("puts AWS's free page beside no table row on these pages", () => {
    const rows = PAGES.flatMap((page) =>
      rowsOf(html.get(page)!)
        .filter((cells) => cells.some((cell) => [...linksIn(cell, RECORD_SOURCE_CLASS), ...linksIn(cell, FIGURE_SOURCE_CLASS)].includes(AWS_FREE_PAGE)))
        .map((cells) => `${page}: ${nameOf(cells[0]!)}`));
    assert.deepStrictEqual(rows, []);
  });

  it("keeps AWS's free page beside the cloud comparison's EC2 and RDS rows only", () => {
    const rows = rowsNamed(CLOUD_COMPARISON, "AWS")
      .filter((cells) => cells.some((cell) => [...linksIn(cell, RECORD_SOURCE_CLASS), ...linksIn(cell, FIGURE_SOURCE_CLASS)].includes(AWS_FREE_PAGE)))
      .map((cells) => figuresOf(cells[1]!));
    assert.deepStrictEqual(rows, CLOUD_ROWS_ON_AWS_FREE_PAGE);
  });

  it("links no page from the cloud comparison's S3 and CloudFront row", () => {
    const rows = rowsNamed(CLOUD_COMPARISON, "AWS").filter((cells) => figuresOf(cells[1]!) === CLOUD_S3_AND_CLOUDFRONT);
    assert.strictEqual(rows.length, 1);
    const outbound = rows[0]!.flatMap((cell) => [...cell.matchAll(/<a\b[^>]*href="(https?:[^"]*)"/g)].map(([, href]) => href));
    assert.deepStrictEqual(outbound, []);
  });

  it("gives AWS Activate no duration on the cloud comparison, since the credits page states none", () => {
    const rows = rowsNamed(CLOUD_COMPARISON, "AWS").filter((cells) => figuresOf(cells[1]!) === "Activate");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]![3]!.trim(), "&mdash;");
  });

  it("states App Runner's closure in its row and in the paragraph under the table", () => {
    const [row, ...others] = rowsNamed(SERVERLESS, "AWS App Runner");
    assert.strictEqual(others.length, 0);
    assert.strictEqual(figuresOf(row![1]!), APP_RUNNER_FREE_TIER);
    assert.strictEqual(figuresOf(row![5]!), APP_RUNNER_BEST_FOR);
    const text = textOf(html.get(SERVERLESS)!);
    assert.ok(text.includes(APP_RUNNER_SENTENCES), "the paragraph under the table states the closure");
    assert.deepStrictEqual(["No always-free tier (trial credits only)", "non-starter for free-tier comparisons"].filter((old) => text.includes(old)), []);
  });

  it("states CodePipeline's V1 and V2 allowances in the AWS guide's CI/CD stack, and both of CodeBuild's free instance types on /ci-cd-pricing", () => {
    assert.ok(textOf(html.get(AWS_GUIDE)!).includes(
      "CodeBuild (100 min/month) + CodePipeline (1 V1 pipeline or 100 V2 action minutes/month) + ECR Public (50 GB)."));
    const ciCd = textOf(html.get(CI_CD_PRICING)!);
    assert.ok(ciCd.includes("100 build minutes/month on general1.small or arm1.small (Always Free)."));
    assert.ok(!ciCd.includes("general1.small (Always Free)"));
  });
});
