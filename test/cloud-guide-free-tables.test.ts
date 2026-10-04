import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const AZURE = "/azure-free-tier-2026";
const AWS = "/aws-free-tier-2026";
const GCP = "/gcp-free-tier-2026";
const PAGES = [AZURE, AWS, GCP];
const PAGES_WITH_TWO_FREE_TERMS = [AZURE, AWS];

const FREE_OFFER_SECTIONS = ["always-free", "twelve-month", "free-plan", "trial", "trials"];
const VENDOR_WORDS = new Set(["azure", "amazon", "aws", "microsoft"]);

const MICROSOFT_FREE_ACCOUNT_LIST = "https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account";
const LISTS_NO_QUOTA = ["https://azure.microsoft.com/en-us/pricing/free-services/"];

const STATED_IN_FULL_ON_THE_ACCOUNT_LIST = [
  "Azure Cosmos DB",
  "App Service",
  "Container Apps",
  "Azure AI Search",
  "Foundry Tools: Translator",
  "Azure Maps",
  "Azure IoT Hub",
  "Azure Advisor",
  "Foundry Tools: Vision",
  "Azure Database for PostgreSQL",
  "Azure Database for MySQL",
];

const AZURE_SUBSCRIPTION_LIMITS = "https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits";

const STATED_ON_THE_PRODUCTS_OWN_PAGE: Record<string, string> = {
  "Azure Functions": "https://azure.microsoft.com/en-us/pricing/details/functions/",
  "Azure SQL Database": "https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer?view=azuresql",
  "Azure DevOps": "https://azure.microsoft.com/en-us/pricing/details/devops/azure-devops-services/",
  "Notification Hubs": "https://azure.microsoft.com/en-us/pricing/details/notification-hubs/",
  "Azure Resource Manager": AZURE_SUBSCRIPTION_LIMITS,
  "Azure Policy": AZURE_SUBSCRIPTION_LIMITS,
  "Foundry Tools: Language": "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/language-service/",
  "Azure Active Directory (Entra ID)": "https://learn.microsoft.com/en-us/entra/identity/users/directory-service-limits-restrictions",
  "Bandwidth": "https://azure.microsoft.com/en-us/pricing/details/bandwidth/",
};

const NO_STATIC_PAGE_STATES_THE_ROW: Record<string, string[]> = {
  [AZURE]: [
    "Azure Virtual Machines",
    "Managed Disks",
    "Azure Blob Storage",
    "Azure Files",
    "Azure Service Bus",
    "$200 Azure Credit",
    "Microsoft Foundry",
    "Azure Kubernetes Service (AKS)",
    "Microsoft Fabric",
    "Azure OpenAI Service",
  ],
  [AWS]: [
    "AWS Lambda",
    "Amazon DynamoDB",
    "Amazon CloudFront",
    "Amazon SNS",
    "Amazon SQS",
    "Amazon CloudWatch",
    "Amazon ECR Public",
    "AWS CloudFormation",
    "Amazon Cognito",
    "AWS CodeCommit",
    "AWS CodePipeline",
    "AWS CodeBuild",
    "AWS X-Ray",
    "AWS Step Functions",
    "Amazon Q Developer",
    "Amazon SageMaker",
    "Amazon Bedrock",
    "Amazon AppStream 2.0",
    "Amazon Lightsail",
  ],
  [GCP]: [
    "Firebase Auth",
    "Firebase Hosting",
    "Firebase Realtime Database",
  ],
};

const RECORD_SOURCE_LINK = /<a\b[^>]*class="record-source"/g;

let server: ChildProcess;
const html = new Map<string, string>();

interface Row {
  section: string;
  name: string;
  citations: string[];
  recordSources: number;
}

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nearr;/g, "")
    .replace(/★/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CITATION = new RegExp(`<a href="([^"]+)"[^>]*class="${FIGURE_SOURCE_CLASS}"`, "g");

function sectionMarkup(page: string, id: string): string {
  const markup = html.get(page)!;
  const start = markup.indexOf(`<h2 id="${id}"`);
  if (start < 0) return "";
  const end = markup.indexOf("<h2", start + 1);
  return markup.slice(start, end < 0 ? undefined : end);
}

function freeOfferRows(page: string): Row[] {
  return FREE_OFFER_SECTIONS.flatMap((section) =>
    [...sectionMarkup(page, section).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell))
      .filter((cells) => cells.length >= 2)
      .map((cells) => ({
        section,
        name: textOf(cells[0].replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), "")),
        citations: cells.flatMap((cell) => [...cell.matchAll(CITATION)].map(([, href]) => href)),
        recordSources: cells.reduce((count, cell) => count + (cell.match(RECORD_SOURCE_LINK) ?? []).length, 0),
      })));
}

function serviceKey(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((word) => !VENDOR_WORDS.has(word)))].sort().join(" ");
}

describe("the cloud guides' free-offer tables name each service once and cite pages that state the quota", () => {
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

  it("reads a populated free-offer table on each guide, and two on the Azure and AWS guides", () => {
    for (const page of PAGES) {
      const rows = freeOfferRows(page);
      const sections = new Set(rows.map((row) => row.section));
      const tablesNeeded = PAGES_WITH_TWO_FREE_TERMS.includes(page) ? 2 : 1;
      assert.ok(sections.size >= tablesNeeded && rows.length >= 15, `${page}: ${rows.length} rows in ${[...sections].join(", ")}`);
    }
  });

  it("lists no service in two of the Azure or AWS guide's free-offer tables", () => {
    const listedTwice = PAGES_WITH_TWO_FREE_TERMS.flatMap((page) => {
      const sectionsByService = new Map<string, Set<string>>();
      for (const row of freeOfferRows(page)) {
        const key = serviceKey(row.name);
        sectionsByService.set(key, (sectionsByService.get(key) ?? new Set()).add(row.section));
      }
      return [...sectionsByService]
        .filter(([, sections]) => sections.size > 1)
        .map(([service, sections]) => `${page}: ${service} in ${[...sections].join(" and ")}`);
    });
    assert.deepStrictEqual(listedTwice, []);
  });

  it("keeps Visual Studio Code, a desktop editor, out of Azure's free services", () => {
    const named = freeOfferRows(AZURE).filter((row) => /Visual Studio Code/.test(row.name));
    assert.deepStrictEqual(named.map((row) => `${row.section}: ${row.name}`), []);
  });

  it("cites Microsoft's free account list on each Azure row whose whole quota that list states", () => {
    const rows = freeOfferRows(AZURE);
    const uncited = STATED_IN_FULL_ON_THE_ACCOUNT_LIST.filter((name) =>
      !rows.some((row) => row.name === name && row.citations.includes(MICROSOFT_FREE_ACCOUNT_LIST)));
    assert.deepStrictEqual(uncited, []);
  });

  it("cites no page that lists no quota as a row's own source", () => {
    const cited = PAGES.flatMap((page) =>
      freeOfferRows(page)
        .filter((row) => row.citations.some((href) => LISTS_NO_QUOTA.includes(href)))
        .map((row) => `${page}: ${row.name}`));
    assert.deepStrictEqual(cited, []);
  });

  it("cites the product's own page on each Azure row whose quota only that page states", () => {
    const rows = freeOfferRows(AZURE);
    const uncited = Object.entries(STATED_ON_THE_PRODUCTS_OWN_PAGE)
      .filter(([name, page]) => !rows.some((row) => row.name === name && row.citations.includes(page)))
      .map(([name]) => name);
    assert.deepStrictEqual(uncited, []);
  });

  it("gives every free-offer row a citation of its own, except the rows no static page states, named here", () => {
    const uncited = PAGES.flatMap((page) =>
      freeOfferRows(page).filter((row) => row.citations.length === 0).map((row) => `${page}: ${row.name}`)).sort();
    const named = Object.entries(NO_STATIC_PAGE_STATES_THE_ROW)
      .flatMap(([page, names]) => names.map((name) => `${page}: ${name}`)).sort();
    assert.deepStrictEqual(uncited, named);
  });

  it("drops the catalogue record's source link from rows that cite their own page, and keeps it on rows that cite none", () => {
    const rows = PAGES.flatMap((page) => freeOfferRows(page).map((row) => ({ page, ...row })));
    const doubled = rows.filter((row) => row.citations.length > 0 && row.recordSources > 0).map((row) => `${row.page}: ${row.name}`);
    assert.deepStrictEqual(doubled, []);
    const keptOnUncited = rows.filter((row) => row.citations.length === 0 && row.recordSources > 0).map((row) => `${row.page}: ${row.name}`);
    assert.ok(keptOnUncited.includes(`${AZURE}: Azure Blob Storage`), keptOnUncited.join("; "));
    assert.ok(keptOnUncited.includes(`${GCP}: Firebase Auth`), keptOnUncited.join("; "));
  });
});
