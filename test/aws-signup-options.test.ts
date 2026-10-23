import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEW_SIGNUP = "https://docs.aws.amazon.com/accounts/latest/reference/sign-in-new.html";
const OPTIONS = "https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html";
const CREATE_ACCOUNT = "https://aws.amazon.com/resources/create-account/";
const ANNOUNCEMENT = "https://aws.amazon.com/blogs/aws/aws-reimagines-the-getting-started-experience/";
const FAQ = "https://aws.amazon.com/free/free-tier-faqs/";
const CARD_CELL = "No for most new customers on the new sign-up, which AWS is still rolling out; a card is required on the advanced sign-up";

function textOf(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:a|b|span|strong)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

function hasLink(html: string, url: string): void {
  assert.ok(html.includes(`href="${url}"`), `Missing source ${url}`);
}

let server: ChildProcess;
let paragraphs: string[];
let comparison: string;
let rows: string[][];
let headers: string[];
let awsCard: string;

before(async () => {
  server = spawn(process.execPath, [path.join(REPO, "dist/serve.js")], {
    cwd: REPO,
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
    server.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const get = async (route: string) => {
    const response = await fetch(`http://localhost:${port}${route}`);
    assert.equal(response.status, 200, route);
    return response.text();
  };
  const guide = await get("/aws-free-tier-2026");
  const summary = guide.match(/<div class="executive-summary">([\s\S]*?)<\/div>/);
  assert.ok(summary);
  paragraphs = [...summary[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1]);
  comparison = await get("/cloud-free-tier-comparison-2026");
  const section = comparison.slice(comparison.indexOf('<h2 id="trial-credits"'));
  const table = section.slice(0, section.indexOf("</table>"));
  headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1]));
  rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]))
    .filter((cells) => cells.length > 0);
  const aws = rows.find((cells) => textOf(cells[0]).startsWith("AWS"));
  assert.ok(aws);
  assert.ok(headers.includes("Credit Card Required"));
  awsCard = aws[headers.indexOf("Credit Card Required")];
});

after(() => { server?.kill(); });

describe("AWS's guides distinguish its new and advanced sign-up options", () => {
  function paragraphStarting(start: string): string {
    const paragraph = paragraphs.find((html) => textOf(html).startsWith(start));
    assert.ok(paragraph, `Missing paragraph: ${start}`);
    return paragraph;
  }

  it("sources the new sign-up, existing logins and qualified no-card offer in the guide summary", () => {
    const paragraph = paragraphStarting("Since September 16, 2026");
    const text = textOf(paragraph);
    for (const line of ["Sign up for AWS (new), using Google, GitHub, Apple, or Amazon credentials.", "most new customers need no credit card", "AWS may ask for payment information to verify an account", "up to $200 in Free Tier credits"]) assert.ok(text.includes(line), line);
    hasLink(paragraph, NEW_SIGNUP);
  });

  it("keeps the limited rollout and returning-customer payment requirements beside the no-card offer", () => {
    const paragraph = paragraphStarting("Since September 16, 2026");
    const text = textOf(paragraph);
    for (const line of ["still reaching a limited number of customers", "it may not be available to you yet", "Anyone who has or has had an AWS account must give payment information and is placed on the Paid plan"]) assert.ok(text.includes(line), line);
    hasLink(paragraph, OPTIONS);
    hasLink(paragraph, CREATE_ACCOUNT);
  });

  it("sources a paid-plan spend limit per project and explains pausing and the advanced-sign-up exclusion", () => {
    const paragraph = paragraphStarting("On the paid plan of the new sign-up");
    const text = textOf(paragraph);
    for (const line of ["each project can have a monthly spend limit starting at $20", "AWS pauses the project instead of charging more, until the limit is raised", "Accounts made with the advanced sign-up cannot set spend limits"]) assert.ok(text.includes(line), line);
    hasLink(paragraph, ANNOUNCEMENT);
    hasLink(paragraph, OPTIONS);
  });

  it("sources the service, Region, Marketplace, Activate and regulated-workload limitations", () => {
    const paragraph = paragraphStarting("The new sign-up does not give every AWS service");
    const text = textOf(paragraph);
    for (const line of ["does not let you choose the Region", "cannot use AWS Marketplace or earn extra AWS Activate credits", "use the advanced sign-up for those and for regulated workloads such as HIPAA"]) assert.ok(text.includes(line), line);
    hasLink(paragraph, OPTIONS);
  });

  it("qualifies AWS's no-card table cell with rollout and advanced-sign-up requirements and their sources", () => {
    assert.equal(textOf(awsCard), CARD_CELL);
    hasLink(awsCard, FAQ);
    hasLink(awsCard, OPTIONS);
  });

  it("preserves the card requirement for GCP, Azure and DigitalOcean in their own table cells", () => {
    for (const name of ["GCP", "Azure", "DigitalOcean"]) {
      const row = rows.find((cells) => textOf(cells[0]).startsWith(name));
      assert.ok(row, name);
      assert.equal(textOf(row[headers.indexOf("Credit Card Required")]), "Yes", name);
    }
  });

  it("no longer extends the other providers' card requirement to AWS", () => {
    const text = textOf(comparison);
    assert.ok(text.includes("GCP, Azure and DigitalOcean require a credit card."));
    assert.ok(!text.includes("All require a credit card."));
    assert.ok(text.includes("Google closes the Free Trial billing account, AWS closes the Free plan account, and Azure disables the subscription."));
  });
});
