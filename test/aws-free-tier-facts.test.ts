import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const PAGE = "/aws-free-tier-2026";

const WITHDRAWN: Record<string, RegExp> = {
  "the 12-Month Free tier as a current tier": /12-Month Free/,
  "12-month services that expire silently": /expire silently|silently convert/i,
  "a tier that ends with no automatic notification": /no automatic notification/i,
  "three free tiers with different rules": /Three tiers, very different rules/,
  "the old meta description": /Always Free, 12-month, and trial tiers|Serverless just added/,
  "5 GB of free S3 storage": /5 GB standard storage|S3 \(5 GB\)/,
  "750 hours of a 12-month instance": /750 hrs\/month (?:t2\.micro|db\.t2\.micro|cache\.t2\.micro|t2\.small\.search|dc2\.large)|750 hrs t3\.micro/,
  "unlimited ECR Public pulls": /unlimited public image pulls/i,
  "SES in the Always Free table": /No free tier — \$200 in expiring AWS credits/,
  "Aurora as paid-only before March 2026": /Previously paid-only/,
  "Aurora at no cost": /production workloads at scale — for free/,
  "Neon's storage as 512 MiB": /512 MiB/,
  "every stack at zero cost": /All stacks below can run at zero cost/,
  "every always-free service in the API stack": /scales to zero, always free within limits/,
};

const META = "AWS Free plan: up to $200 in credits over 6 months, 30+ always-free services, short-term trials, hidden costs, cheaper alternatives.";

const STATS = ["Up to $200 Credits", "6 months Free plan", "30+ Always free", "90+ Services on the Free plan"];

const STATED_ON_THE_PAGE = [
  "New AWS accounts choose a Free plan or a Paid plan; both get $100 in credits at sign-up and can earn up to $100 more. The Free plan covers over 90 services, charges nothing, and closes at 6 months or when the credits run out. 30+ services stay always free on both plans. Short-term trials are for the Paid plan.",
  "What's new: Aurora PostgreSQL serverless joined the Free plan on 2026-03-25 with up to 4 ACUs and 1 GiB per cluster, paid from the credits. The 12-month free tier ended for the last eligible accounts in July 2026.",
  "30+ services are free within monthly limits on both plans. Usage beyond these limits is first covered by credits, then billed at standard pay-as-you-go rates on the Paid plan.",
  "When the Free plan ends, the account closes. AWS retains content for 90 days before permanent deletion. Upgrading to a Paid plan within 90 days restores access and applies remaining credits to future bills. The plan excludes Savings Plans, Reserved Instances, and some AWS Marketplace offers.",
  "Joining AWS Organizations, setting up an AWS Control Tower landing zone, or joining the AWS Partner Network automatically upgrades a Free plan account to the Paid plan.",
  "Aurora PostgreSQL serverless on the Free plan: up to 4 ACUs and 1 GiB per cluster, paid from the credits, for as long as the Free plan lasts. Upgrading to the Paid plan lifts the limits, and usage past the credits is billed.",
  "Trials are for Paid plan services and start when you activate the service; credits cover usage past the trial limits.",
  "Only the always-free services stay at zero cost after the Free plan; S3, EC2, RDS and Aurora draw on the credits.",
  "On the Free plan nothing is billed: the account closes at 6 months or when credits run out, and content is deleted after 90 days unless you upgrade. On the Paid plan, usage past the credits is billed.",
];

const ALWAYS_FREE_ROWS: [string, string][] = [
  ["Amazon CloudFront", "1 TB data transfer out, 10M HTTP/HTTPS requests, 2M CloudFront Function invocations/month"],
  ["Amazon ECR Public", "50 GB storage, 500 GB/month transfer out anonymously, 5 TB/month with an AWS account"],
  ["Amazon Q Developer", "Inline suggestions, chat, 50 agent invocations/month (always free for individuals)"],
];

const CONTROL_ROWS: [string, string][] = [
  ["AWS Lambda", "1M requests/month, 400K GB-seconds compute"],
  ["Amazon DynamoDB", "25 GB storage, 25 WCU/RCU provisioned capacity"],
];

const CONTROL_TRIAL_ROWS: [string, string][] = [
  ["Amazon Lightsail", "750 hrs/month of 512 MB instance (3 months free)"],
];

let server: ChildProcess;
let base = "";
let html = "";

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&nearr;/g, "")
    .replace(/&nbsp;/g, " ");
}

function textOf(markup: string): string {
  return decode(
    markup
      .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

const CITATION_ANCHOR = new RegExp(`<a [^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

function rowsOf(table: string): string[][] {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), ""))))
    .filter((cells) => cells.length >= 2);
}

function tableAfter(anchor: string): string[][] {
  const at = html.indexOf(anchor);
  assert.ok(at !== -1, `no ${anchor} on the page`);
  const section = html.slice(at);
  return rowsOf(section.slice(0, section.indexOf("</table>")));
}

function rowsDifferingFrom(expected: [string, string][], rows: string[][], table: string): string[] {
  return expected.flatMap(([name, limits]) => {
    const row = rows.find(([cell]) => cell === name);
    if (!row) return [`no ${name} row in the ${table} table`];
    return row[1] === limits ? [] : [`${name}: ${row[1]}`];
  });
}

describe("the AWS free tier guide describes the 6-month Free plan as AWS's own pages state it", () => {
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
    const response = await fetch(`${base}${PAGE}`);
    assert.strictEqual(response.status, 200);
    html = await response.text();
  });
  after(() => {
    server?.kill();
  });

  it("serves none of the withdrawn claims in the guide's body, meta or structured data", () => {
    const found = Object.entries(WITHDRAWN)
      .filter(([, pattern]) => pattern.test(html))
      .map(([claim, pattern]) => `${claim} ("${html.match(pattern)![0]}")`);
    assert.deepStrictEqual(found, []);
  });

  it("describes the Free plan in the meta description and the structured data", () => {
    const meta = html.match(/<meta name="description" content="([^"]*)">/)?.[1];
    assert.strictEqual(decode(meta ?? ""), META);
    const article = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    assert.strictEqual(article.description, META);
  });

  it("gives AWS's own figures in the stat cards", () => {
    const stats = [...html.matchAll(/<div class="stat-number[^"]*">([^<]*)<\/div><div class="stat-label">([^<]*)<\/div>/g)]
      .map(([, number, label]) => `${decode(number)} ${decode(label)}`);
    assert.deepStrictEqual(stats, STATS);
  });

  it("states the Free plan's credits, closure, upgrade conditions and trials as written", () => {
    const text = textOf(html);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((line) => !text.includes(line)), []);
  });

  it("replaces the 12-month table with a Free plan section that lists no allowances", () => {
    assert.ok(!html.includes('id="twelve-month"'), "the 12-month section is still on the page");
    const start = html.indexOf('id="free-plan"');
    const end = html.indexOf('id="trials"');
    assert.ok(start !== -1 && end > start, "no Free plan section ahead of the trials");
    assert.ok(!html.slice(start, end).includes("<table"), "the Free plan section lists a table of allowances");
  });

  it("lists CloudFront, ECR Public and Amazon Q Developer as always free, and S3 and SES not at all", () => {
    const alwaysFree = tableAfter('id="always-free"');
    const trials = tableAfter('id="trials"').map(([name]) => name);
    assert.deepStrictEqual(rowsDifferingFrom(ALWAYS_FREE_ROWS, alwaysFree, "Always Free"), []);
    assert.deepStrictEqual(alwaysFree.map(([name]) => name).filter((name) => /\bS3\b|\bSES\b/.test(name)), []);
    assert.ok(!trials.includes("Amazon Q Developer"), "Amazon Q Developer is still listed as a trial");
  });

  it("keeps the rows the Free plan did not change", () => {
    assert.deepStrictEqual([
      ...rowsDifferingFrom(CONTROL_ROWS, tableAfter('id="always-free"'), "Always Free"),
      ...rowsDifferingFrom(CONTROL_TRIAL_ROWS, tableAfter('id="trials"'), "trials"),
    ], []);
  });
});
