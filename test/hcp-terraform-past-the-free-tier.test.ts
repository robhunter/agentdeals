import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HCP_TERRAFORM_ESSENTIALS_PRICE, dollarsAsWritten, hcpTerraformPastTheFreeTierHtml } from "../dist/hcp-terraform-pricing.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FREE_TIER_CAP = "Organizations were transitioned to an enhanced free tier that caps managed resources at 500.";

let server: ChildProcess | null = null;
let page = "";

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const readable = (html: string) =>
  html.replace(/<\/?(?:a|strong)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const paragraphStatingTheCap = () =>
  [...page.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(([, inner]) => inner).find((inner) => inner.includes(FREE_TIER_CAP));

before(async () => {
  let base = "";
  ({ proc: server, base } = await startServer());
  page = await (await fetch(`${base}/terraform-alternatives`)).text();
});

after(() => {
  if (server) server.kill();
  server = null;
});

describe("what /terraform-alternatives says HCP Terraform costs past its free 500 managed resources", () => {
  it("follows the free tier's 500-resource cap in the same paragraph, linking Essentials to HashiCorp's HCP Terraform overview", () => {
    const paragraph = paragraphStatingTheCap();
    assert.ok(paragraph, "/terraform-alternatives no longer states the free tier's 500-resource cap");
    assert.ok(paragraph.trimEnd().endsWith(`${FREE_TIER_CAP} ${hcpTerraformPastTheFreeTierHtml()}`), paragraph);
    const links = [...paragraph.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(([, href, words]) => [href, words]);
    assert.deepStrictEqual(links, [[HCP_TERRAFORM_ESSENTIALS_PRICE.billingDocs, "Essentials"]]);
  });

  it("gives the monthly and hourly rates and the example's monthly cost from the price constant", () => {
    const { dollarsPerResourceMonth, dollarsPerResourceHour, exampleResources } = HCP_TERRAFORM_ESSENTIALS_PRICE;
    const exampleMonth = Math.round(exampleResources * dollarsPerResourceMonth);
    assert.ok(
      readable(paragraphStatingTheCap() ?? "").endsWith(
        `${FREE_TIER_CAP} To manage more than 500 resources, an organization needs a paid plan, such as Essentials, which bills every resource at $${dollarsPerResourceMonth.toFixed(2)} a month or $${dollarsPerResourceHour} an hour, based on the peak count in each hour, so ${exampleResources} resources cost about $${exampleMonth} a month.`,
      ),
      readable(paragraphStatingTheCap() ?? ""),
    );
  });

  it("follows whatever rates and example the constant holds, so a price change is one edit, and rounds the example's cost to the dollar", () => {
    const changed = { ...HCP_TERRAFORM_ESSENTIALS_PRICE, dollarsPerResourceMonth: 0.11, dollarsPerResourceHour: 0.00015, exampleResources: 850 };
    const sentence = hcpTerraformPastTheFreeTierHtml(changed).replace(/<[^>]+>/g, "");
    assert.ok(sentence.endsWith("which bills every resource at $0.11 a month or $0.00015 an hour, based on the peak count in each hour, so 850 resources cost about $94 a month."), sentence);
  });

  it("writes a rate with every decimal it has, and never fewer than two", () => {
    assert.deepStrictEqual([0.1, 0.00013, 5, 0.0143].map(dollarsAsWritten), ["$0.10", "$0.00013", "$5.00", "$0.0143"]);
  });

  it("keeps the day the rates were read and both HashiCorp pages beside the rates", () => {
    const { readOn, pricingPage, billingDocs } = HCP_TERRAFORM_ESSENTIALS_PRICE;
    assert.match(readOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(new Date(`${readOn}T00:00:00Z`).toISOString().slice(0, 10), readOn);
    assert.ok(pricingPage.startsWith("https://www.hashicorp.com/"), pricingPage);
    assert.ok(billingDocs.startsWith("https://developer.hashicorp.com/terraform/"), billingDocs);
  });

  it("is printed from the price constant, not typed into the guide", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    assert.ok(source.includes("caps managed resources at 500. ${hcpTerraformPastTheFreeTierHtml()}</p>"), "the guide does not take the sentence from the price constant");
    assert.ok(!source.includes("bills every resource"), "the guide types the sentence instead of printing it from the price constant");
  });
});
