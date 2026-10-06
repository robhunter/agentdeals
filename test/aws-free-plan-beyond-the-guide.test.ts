import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");
const { rateCardFor, monthlyEgressGrantGb, monthlyEgressGrantSentence } = await import("../dist/storage-cost-model.js");

const S3_EGRESS = monthlyEgressGrantSentence(rateCardFor("AWS S3"));
const S3_EGRESS_GB = monthlyEgressGrantGb("AWS S3");
const S3_STORAGE_RATE = rateCardFor("AWS S3").publishedStorageRate;

const FREE_PLAN_CELL = "Free plan: $100 credit at sign-up + up to $100 more, 6 months";

const STACK_PAGES = ["/free-nextjs-stack", "/free-django-stack", "/free-fastapi-stack", "/free-go-stack", "/free-saas-stack"];

const S3_WHY_NOT = `Why not AWS S3: new accounts get no free storage, only Free plan credits that last at most 6 months; then storage costs ${S3_STORAGE_RATE}. Bandwidth is the part that does not expire`;

const CREDITS_EXPIRING_AT_12_MONTHS = /credits (?:that )?expire 12 months/;

const SES_ESTIMATE = `"slug":"amazon-ses","name":"Amazon SES","free":"None — $200 in expiring credits","starter":0,"growth":10,"scale":100,"notes":"$0.10/1K emails"`;

const WITHDRAWN: Record<string, Record<string, RegExp>> = {
  "/email-comparison-2026": {
    "SES's Free Tier credits expiring 12 months from account creation": CREDITS_EXPIRING_AT_12_MONTHS,
  },
  "/estimate": { "SES's credits expiring 12 months after sign-up": CREDITS_EXPIRING_AT_12_MONTHS },
  "/budget-builder": { "SES's credits expiring 12 months after sign-up": CREDITS_EXPIRING_AT_12_MONTHS },
  "/hosting-alternatives": {
    "750 free hours of t2.micro for 12 months": /750 hrs t2\.micro\/mo \(12 mo\)/,
    "a 12-month free tier": /Full cloud platform, 12-month free tier/,
    "AWS and Azure free tiers as 12-month introductory offers": /mostly 12-month introductory offers/,
    "12-month free t2.micro and B1 instances": /12-month free tiers with t2\.micro\/B1 instances/,
  },
  "/aws-app-runner-migration": {
    "750 free hours of t2.micro for 12 months": /750 hrs t2\.micro\/mo, 12 months/,
    "a free t2.micro for 12 months": /t2\.micro free 12 mo/,
  },
  "/free-django-stack": {
    "EC2 instances on a 12-month trial": /\(12-month trial\)/,
    "EC2 instances as the free part of Elastic Beanstalk": /No free tier for the EB service itself, only the underlying EC2 instances/,
  },
  "/free-go-stack": {
    "Lambda's free invocations expiring after 12 months": /free invocations expire after 12 months/,
    "Cloud Run preferred to Lambda for staying free": /Cloud Run is simpler and stays free forever/,
  },
  "/free-saas-stack": {
    "SQS and Lambda free for 12 months only": /12-month free tier expiration/,
    "most services expiring after 12 months": /most services expire after 12 months/,
  },
  "/gcp-free-tier-2026": {
    "12 months of free EC2 and RDS": /12-month EC2\/RDS/,
  },
  "/database-pricing": {
    "a free first year": /\$0 \(year 1\)/,
    "a 12-month free tier for new accounts": /12-month free tier for new AWS accounts/,
    "a 12-month free tier before costs jump": /12-month free tier only/,
    "20 GiB of free backup": /20 GiB backup|Backup beyond 20 GiB/,
  },
  "/storage-comparison-2026": {
    "S3 badged as free for 12 months": /AWS S3 ?<span class="caution-badge">12-MO(?:NTH FREE)? ONLY/,
    "5 GB of S3 storage for 12 months": /for 12 months only|5 GB of storage is part of the 12-month AWS Free Tier/,
    "S3 storage that expires after 12 months": /storage free tier expires after 12 months/,
  },
  "/free-tier-risk": {
    "a 12-month free tier alongside the always-free services": /12-month free tier \+ always-free services/,
    "the old grading reasons": /AWS is the market leader|Restructured Jan 2026 but expanded/,
  },
  "/cloud-free-tier-comparison-2026": {
    "free t2/t3.micro hours for 12 months": /EC2 t2\/t3\.micro/,
    "5 GB of S3 storage for 12 months": /S3: 5 GB standard|12 months \(S3 &amp; CF\)/,
    "a 12-month conversion with no warning": /12-month silent conversion/,
    "Aurora on a 12-month tier": /Aurora PostgreSQL Serverless \(12-month\)/,
    "a ranking of always-free databases": /best always-free managed database/,
    "AWS among the always-free compute options": /Only GCP and AWS offer always-free compute options/,
    "AWS and Azure instances free for 12 months": /AWS and Azure offer 12-month free instances/,
    "Azure's B1S VM, which new subscriptions cannot deploy": /B1S VM|750 hrs\/mo, 1 vCPU, 1 GB RAM/,
    "S3 and CloudFront expiring after 12 months": /(?:S3|CloudFront)[^.<]*expires? after 12 months/,
  },
  "/azure-free-tier-2026": {
    "750 free hours of AWS t3.micro": /AWS \(t3\.micro, 750 hrs total\)/,
  },
};
for (const page of STACK_PAGES) {
  WITHDRAWN[page] = { ...WITHDRAWN[page], "S3 storage that expires after 12 months": /storage free tier expires after 12 months/ };
}

const STATED: Record<string, string[]> = {
  "/email-comparison-2026": [
    "New accounts get up to $200 in AWS Free Tier credits spendable across eligible services, and a free plan that runs 6 months from account creation.",
  ],
  "/hosting-alternatives": [
    "AWS's Free plan credits last at most 6 months; Azure's free VM hours last 12 months. One AWS allowance does not expire and matters in the Bandwidth column: AWS's first",
    "AWS gives new accounts no free EC2 hours; EC2 is paid from the Free plan's credits for up to 6 months. Azure gives 750 hours a month each of B2pts v2 and B2ats v2 VMs for 12 months, for accounts that move to pay-as-you-go within 30 days.",
  ],
  "/free-django-stack": [
    "Why not AWS Elastic Beanstalk: it has no fee of its own, but you pay for the EC2 instances it runs, from the Free plan's credits on a new account. Overkill for a Django side project.",
  ],
  "/azure-free-tier-2026": [
    "Compare with AWS (new accounts get no free EC2 hours; EC2 is paid from the Free plan's credits) and GCP (",
  ],
  "/free-saas-stack": [
    "Why not AWS SQS/Lambda: Complex setup. Inngest and Trigger.dev give you managed, durable execution with a serverless DX.",
    "Why not AWS/GCP/Azure directly: Free tiers exist but are complex to configure. AWS credits last 6 months; GCP has $300 in credit plus always-free products; Azure offers free services for 12 months to new customers.",
  ],
  "/database-pricing": [
    "Aurora PostgreSQL serverless on the Free plan: up to 4 ACUs and 1 GiB per cluster, paid from the credits, for as long as the Free plan lasts. Upgrading to the Paid plan lifts the limits, and usage past the credits is billed.",
  ],
  "/storage-comparison-2026": [
    "Free tier: no storage allowance of its own for new accounts. New accounts' credits, up to $200, can pay for S3 while the Free plan lasts, at most 6 months. After that, standard rates from the first byte: $0.023/GB storage, $0.005/1K PUT, $0.0004/1K GET.",
    `AWS S3 gets a cross because new accounts get no free storage, only credits on a Free plan that closes after 6 months; but ${S3_EGRESS}, aggregated across all AWS services and regions, so the ${S3_EGRESS_GB} GB in its Free Egress cell does not expire.`,
    "S3 has no free storage for new accounts; its monthly egress allowance stays",
    `S3's 5 GB of free storage was part of the 12-month AWS Free Tier, which ended for the last eligible accounts in July 2026. New accounts pay for stored bytes from the first one, from their credits while the Free plan lasts. The egress allowance remains: ${S3_EGRESS}, aggregated across all AWS services and regions, so a project serving under ${S3_EGRESS_GB} GB a month pays nothing for bandwidth. Azure Blob Storage's 5 GB is free for the first 12 months only. GCS and Oracle are Always Free.`,
  ],
  "/free-tier-risk": [
    "On 2025-07-15 AWS replaced the 12-month free tier for new accounts with a Free plan: up to $200 in credits, closing after 6 months. 30+ services, including Lambda (1M requests a month) and DynamoDB (25 GB), stay always free on both plans.",
  ],
  "/cloud-free-tier-comparison-2026": [
    "GCP is the only provider of the four with a permanent free VM. AWS gives new accounts no free VM hours, with EC2 paid from the Free plan's credits, and the plan closes after 6 months unless upgraded. Azure's free VM hours last 12 months for accounts that move to pay-as-you-go within 30 days, and VMs still running after 12 months are billed at pay-as-you-go rates. If you need a persistent server",
    "Azure's Cosmos DB has a lifetime free tier.",
    "AWS has DynamoDB (always free, 25 GB) and Aurora PostgreSQL serverless (Free plan, paid from credits).",
    "Free plan closure: the account closes at 6 months or when credits run out, and content is deleted after 90 days unless you upgrade to the Paid plan.",
    "CloudFront is always free up to 1 TB of data transfer out and 10,000,000 requests a month. S3 is paid from the Free plan credits, which last up to 6 months.",
  ],
};
for (const page of STACK_PAGES) STATED[page] = [...(STATED[page] ?? []), S3_WHY_NOT];

const ROWS: Record<string, string[][]> = {
  "/hosting-alternatives": [["AWS", FREE_PLAN_CELL, "Full cloud platform, 6-month Free plan"]],
  "/aws-app-runner-migration": [
    ["Amazon ECS Express Mode", FREE_PLAN_CELL],
    ["Elastic Beanstalk", "No EB fee (pay for underlying resources)", "EC2 pricing"],
  ],
  "/gcp-free-tier-2026": [["AWS", "Always Free: Lambda 1M req/mo, DynamoDB 25 GB"]],
  "/database-pricing": [
    ["Amazon Aurora PostgreSQL", "PostgreSQL (Managed)", "1 GiB per cluster"],
    ["Amazon Aurora PostgreSQL", "—", "I/O costs on Aurora are separate. Multi-AZ doubles the instance cost."],
  ],
  "/storage-comparison-2026": [["AWS S3 CREDITS ONLY", "None (credits)"]],
  "/cloud-free-tier-comparison-2026": [
    ["AWS", "EC2", "No free hours; paid from Free plan credits (up to $200)", "Free plan: 6 months"],
    ["AWS", "S3: no free storage (paid from credits)", "CloudFront: 1 TB transfer, 10M requests/mo", "CloudFront always free; S3 from credits"],
    ["Azure", "B2pts v2 / B2ats v2 VMs", "750 hrs/mo each, 2 vCPU, 1 GiB RAM", "12 months only"],
  ],
};

const KEPT: Record<string, string[]> = {
  "/storage-comparison-2026": [
    "Azure Blob Storage 12-MO ONLY",
    "Azure Blob Storage 12-MONTH FREE ONLY",
    `Egress is the exception — ${S3_EGRESS}`,
  ],
};
for (const page of STACK_PAGES) KEPT[page] = [`Bandwidth is the part that does not expire — ${S3_EGRESS}`];

const PAGES = [...new Set([...Object.keys(WITHDRAWN), ...Object.keys(STATED), ...Object.keys(ROWS), ...Object.keys(KEPT)])].sort();

let server: ChildProcess;
const html = new Map<string, string>();

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
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

describe("pages beyond the AWS guide describe AWS's 6-month Free plan, not the 12-month tier", () => {
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

  it("serves none of the withdrawn 12-month AWS claims on the pages that carried them", () => {
    const found = Object.entries(WITHDRAWN).flatMap(([page, claims]) =>
      Object.entries(claims)
        .filter(([, pattern]) => pattern.test(html.get(page)!))
        .map(([claim, pattern]) => `${page}: ${claim} ("${html.get(page)!.match(pattern)![0]}")`));
    assert.deepStrictEqual(found, []);
  });

  it("states the Free plan in the given words on each page", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const text = textOf(html.get(page)!);
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("puts the Free plan in the AWS rows of each table and Azure's deployable VM sizes in its compute row", () => {
    const missing = Object.entries(ROWS).flatMap(([page, expected]) => {
      const rows = rowsOf(html.get(page)!);
      return expected
        .filter(([name, ...cells]) => !rows.some((row) => namedFor(row[0], name) && cells.every((cell) => row.includes(cell))))
        .map((cells) => `${page}: ${cells.join(" | ")}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("gives Amazon SES's row in both estimators its per-email price and no 12-month credit expiry", () => {
    assert.deepStrictEqual(["/estimate", "/budget-builder"].filter((page) => !html.get(page)!.includes(SES_ESTIMATE)), []);
  });

  it("keeps Azure's 12-month storage badges and every account's S3 egress allowance", () => {
    const missing = Object.entries(KEPT).flatMap(([page, lines]) => {
      const text = textOf(html.get(page)!);
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });
});
