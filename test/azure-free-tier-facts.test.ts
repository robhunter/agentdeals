import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const PAGE = "/azure-free-tier-2026";

const WITHDRAWN: Record<string, RegExp> = {
  "SQL Database on the S0 tier": /\bS0\b/,
  "B1S VMs, which new subscriptions cannot deploy": /\bB1[Ss]\b/,
  "Log Analytics' free ingestion counted per day": /5 GB\/day/,
  "inter-region transfer at $0.01-0.05/GB": /\$0\.01-0\.05\/GB/,
  "250K Azure Maps transactions": /250K/,
  "unlimited Notification Hubs namespaces": /unlimited namespaces/i,
  "Azure Cache for Redis as a free service": /Azure Cache for Redis/,
  "Phi-3, which is retired": /Phi-3/,
  "GPT-4o mini, which new customers cannot use": /GPT-4o mini/,
  "the Founders Hub name": /Founders Hub/,
  "the Cognitive Search name": /Cognitive Search/,
  "the Azure AI Studio name": /Azure AI Studio/,
  "a free account with no spend cap": /no automatic spend cap|no built-in spend cap|lack of automatic spend caps/i,
  "free tier services that bill a free account": /free tier services start billing|charged even with a free tier subscription/i,
  "a trial credit that works with every service": /works with every service|credit for any service|access to any Azure service/i,
  "12-month services that end without notice": /No automatic notification|silently convert/i,
  "a spending limit set in Cost Management": /set spending limits on your subscription/i,
  "a Log Analytics workspace that ingests logs by default": /Every Azure subscription gets a Log Analytics workspace/i,
  "5 GB of bandwidth in the first 12 months": /5 GB first 12 months/,
  "a P6 disk at about $9.60 a month": /\$9\.60/,
  "Container Apps as a 12-month service": /Container Apps \(12-month\)/,
  "Blob Storage as an always-free service": /Azure Storage \(Blob\)/,
  "unlimited policy assignments, tags and resource groups": /Unlimited policy assignments|Unlimited template deployments, tags, resource groups/i,
  "a Basic Service Bus namespace": /750 hrs\/month Basic namespace/,
  "a free parallel pipeline with no subscription linked": /free parallel CI\/CD pipeline/,
  "a title that claims every Azure free service": /Azure Free Tier Complete Guide 2026 — Every Free Service/,
};

const TITLE = "Azure Free Tier 2026 — Always-Free and 12-Month Services, Limits, and Billing Rules";

const STATED_ON_THE_PAGE = [
  "The free account has the spending limit turned on by default, so your card is not charged. At 30 days or when the credit runs out, your account and services are disabled unless you move to pay-as-you-go. Only pay-as-you-go has no spending cap: once you exceed free limits there, charges start immediately.",
  "Customers who try Azure free must move to pay as you go within 30 days to continue receiving 12 months free services.",
  "When the 12 months end, pay-as-you-go rates apply, and Microsoft will send you an email notifying you when it's time to upgrade.",
  "It does not cover Marketplace purchases or Spot VMs, and free trials start with zero GPU quota and aren't eligible for limit or quota increases.",
  "Once you move to pay-as-you-go, services bill the moment you exceed free limits: a spending limit isn't shown in the Azure portal and you can't enable one. Budgets send alerts, but your consumption isn't stopped.",
  "When the 12 months end, these services are billed at pay-as-you-go rates. Microsoft will send you an email notifying you when it's time to upgrade.",
  "The first 5 GB a month per billing account are free. After that, ingestion is billed per GB at a regional rate: $2.30/GB in East US. Resource logs are collected only once you create a diagnostic setting.",
  "$0.02/GB within North America or Europe, $0.05/GB from those continents to others, and up to $0.16/GB elsewhere.",
  "A 64 GB P6 SSD costs $9.29/month in East US 2 and $10.21/month in East US.",
  "You get 750 hours a month of each, for Linux and again for Windows. New subscriptions can't deploy the earlier B-series v1 VMs.",
];

const ALWAYS_FREE_ROWS: [string, string][] = [
  ["Azure SQL Database", "Up to 10 General Purpose serverless databases, each with 100,000 vCore seconds and 32 GB/month, for the lifetime of your subscription"],
  ["Container Apps", "180,000 vCPU seconds, 360,000 GiB seconds and 2 million requests/month"],
  ["Azure Functions", "Flex Consumption: 250,000 executions and 100,000 GB-s/month. Legacy Consumption plan: 1M executions and 400,000 GB-s/month"],
  ["Foundry Tools: Language", "5,000 text records/month"],
  ["Foundry Tools: Translator", "2 million characters/month"],
  ["Azure AI Search", "3 indexes, 50 MB storage per service (F tier)"],
  ["Bandwidth", "100 GB outbound data transfer/month (15 GB outbound for the first 12 months is separate)"],
  ["Azure Maps", "1,000 to 5,000 transactions/month for specific mapping and location insights features"],
  ["Notification Hubs", "1 million pushes, 100 free namespaces, 500 active devices per namespace"],
  ["Azure Policy", "Free, up to 200 policy assignments per scope"],
  ["Azure Resource Manager", "Free, up to 980 resource groups per subscription and 50 tags per resource"],
  ["Azure DevOps", "5 users, unlimited private Git repos, 1 Microsoft-hosted CI/CD job (60 min a run, 1,800 min/mo) once the organization is linked to an Azure subscription"],
  ["Azure Active Directory (Entra ID)", "50,000 stored objects (300,000 with a verified domain), SSO for all apps"],
];

const TWELVE_MONTH_ROWS: [string, string][] = [
  ["Azure Virtual Machines", "750 hours/month each of B2pts v2 (Arm-based) and B2ats v2 (AMD-based) burstable VMs, for Linux and again for Windows"],
  ["Azure Database for PostgreSQL", "750 hours/month of Flexible Server, Burstable B1MS instance, with 32 GB storage and 32 GB backup storage"],
  ["Azure Database for MySQL", "750 hours/month of Flexible Server, Burstable B1MS instance, with 32 GB storage and 32 GB backup storage"],
  ["Azure Blob Storage", "5 GB LRS hot storage, 20K read / 10K write operations"],
  ["Foundry Tools: Vision", "5,000 transactions/month for each S1, S2 and S3 tier"],
  ["Azure Service Bus", "750 hours and 13 million operations/month, Standard tier base unit"],
];

const TRIAL_ROWS: [string, string][] = [
  ["$200 Azure Credit", "$200 credit, valid for 30 days. Not for Marketplace purchases or Spot VMs"],
  ["Microsoft Foundry", "Access to GPT-4o and Llama models with credit"],
  ["Azure OpenAI Service", "GPT-4o, Whisper with trial credit"],
];

const CONTROL_ROWS: [string, string][] = [
  ["Azure Cosmos DB", "1,000 RU/s throughput + 25 GB storage (lifetime)"],
  ["App Service", "10 web/mobile/API apps (F1 tier), 1 GB storage, 60 min/day compute"],
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
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), "")).replace(/^★ /, "")))
    .filter((cells) => cells.length >= 2);
}

function tableAfter(anchor: string): string[][] {
  const section = html.slice(html.indexOf(anchor));
  return rowsOf(section.slice(0, section.indexOf("</table>")));
}

function rowsDifferingFrom(expected: [string, string][], rows: string[][], table: string): string[] {
  return expected.flatMap(([name, limits]) => {
    const row = rows.find(([cell]) => cell === name);
    if (!row) return [`no ${name} row in the ${table} table`];
    return row[1] === limits ? [] : [`${name}: ${row[1]}`];
  });
}

describe("the Azure free tier guide states Microsoft's terms as Microsoft's own pages state them", () => {
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

  it("states the free account's spending limit, the move to pay-as-you-go and the credit's exclusions as written", () => {
    const text = textOf(html);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((line) => !text.includes(line)), []);
  });

  it("lists SQL Database and Container Apps as always free, and Blob Storage only for 12 months", () => {
    const alwaysFree = tableAfter('id="always-free"').map(([name]) => name);
    const twelveMonth = tableAfter('id="twelve-month"').map(([name]) => name);
    assert.ok(alwaysFree.includes("Azure SQL Database"), "no SQL Database row in the Always Free table");
    assert.ok(alwaysFree.includes("Container Apps"), "no Container Apps row in the Always Free table");
    assert.ok(!twelveMonth.includes("Azure SQL Database"), "SQL Database is still in the 12-month table");
    assert.ok(!twelveMonth.includes("Container Apps"), "Container Apps is still in the 12-month table");
    assert.ok(twelveMonth.includes("Azure Blob Storage"), "no Blob Storage row in the 12-month table");
    assert.deepStrictEqual(alwaysFree.filter((name) => /Blob|Storage \(/.test(name)), []);
  });

  it("states each corrected row's name and limits", () => {
    assert.deepStrictEqual([
      ...rowsDifferingFrom(ALWAYS_FREE_ROWS, tableAfter('id="always-free"'), "Always Free"),
      ...rowsDifferingFrom(TWELVE_MONTH_ROWS, tableAfter('id="twelve-month"'), "12-month"),
      ...rowsDifferingFrom(TRIAL_ROWS, tableAfter('id="trial"'), "trial"),
    ], []);
  });

  it("gives Microsoft's own counts of always-free and 12-month services", () => {
    const stats = [...html.matchAll(/<div class="stat-number[^"]*">([^<]*)<\/div><div class="stat-label">([^<]*)<\/div>/g)]
      .map(([, number, label]) => `${number} ${label}`);
    assert.deepStrictEqual(stats.slice(0, 2), ["65+ Always-Free Services", "20+ Services Free for 12 Months"]);
  });

  it("titles the guide by what its tables cover in the title, social card and structured data", () => {
    const titles = [
      html.match(/<title>([^<]*) — AgentDeals<\/title>/)?.[1],
      html.match(/<meta property="og:title" content="([^"]*)">/)?.[1],
      html.match(/"@type":"Article","headline":"([^"]*)"/)?.[1],
    ].map((title) => (title === undefined ? title : decode(title)));
    assert.deepStrictEqual(titles, [TITLE, TITLE, TITLE]);
  });

  it("is named by the same title where the other cloud guides link to it", async () => {
    const linking = await (await fetch(`${base}/aws-free-tier-2026`)).text();
    const linkTitle = linking.match(/href="\/azure-free-tier-2026"[^>]*>\s*<div class="link-title">([^<]*)<\/div>/)?.[1];
    assert.strictEqual(linkTitle === undefined ? linkTitle : decode(linkTitle), TITLE);
  });

  it("keeps the Cosmos DB and App Service rows", () => {
    assert.deepStrictEqual(rowsDifferingFrom(CONTROL_ROWS, tableAfter('id="always-free"'), "Always Free"), []);
  });
});
