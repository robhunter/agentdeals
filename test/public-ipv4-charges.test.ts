import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AWS_GUIDE = "/aws-free-tier-2026";
const CLOUD_COMPARISON = "/cloud-free-tier-comparison-2026";

interface Card {
  title: string;
  cost: string;
  desc: string;
}

const PUBLIC_IPV4_CARD: Card = {
  title: "Public IPv4 addresses",
  cost: "$3.60/mo each",
  desc: "Every public IPv4 address is charged $0.005/hr, whether attached to a running instance or idle. AWS: “Effective February 1, 2024 there will be a charge of $0.005 per IP per hour for all public IPv4 addresses, whether attached to a service or not.”",
};

const MULTI_AZ_CARD: Card = {
  title: "Multi-AZ deployments",
  cost: "2× RDS cost",
  desc: "RDS Multi-AZ doubles your cost: a Multi-AZ instance is billed at twice the Single-AZ rate (db.t4g.micro PostgreSQL in US East: $0.032 an hour against $0.016), and new accounts pay for both from their credits. Some tutorials default to Multi-AZ.",
};

const HIDDEN_COSTS: Record<string, string> = {
  AWS: "Public IPv4: $0.005/hr ($3.60/mo) whether in use or idle.",
  DigitalOcean: "Reserved IPs: Free when assigned. Unassigned IPv4 costs $5/month.",
};

const WITHDRAWN: Record<string, RegExp> = {
  "an Elastic IP as free while attached to a running instance": /Free when attached to a running instance/i,
  "a public IPv4 address charged only while idle": /\$3\.60\/mo idle|Idle Elastic IPs/i,
  "DigitalOcean's reserved IPs as Floating IPs": /Floating IPs/i,
  "an RDS free tier that covers single-AZ only": /only covers single-AZ/i,
};

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function textOf(markup: string): string {
  return decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

function sectionFrom(html: string, heading: string, page: string): string {
  const at = html.indexOf(heading);
  assert.ok(at !== -1, `no ${heading} on ${page}`);
  const next = html.indexOf("<h2", at + heading.length);
  return html.slice(at, next === -1 ? undefined : next);
}

function gotchaCards(html: string): Card[] {
  const cards = sectionFrom(html, '<h2 id="gotchas">', AWS_GUIDE);
  return [...cards.matchAll(/<h3>([^<]*) <span[^>]*>([^<]*)<\/span><\/h3>\s*<p class="diff-desc">([\s\S]*?)<\/p>/g)]
    .map(([, title, cost, desc]) => ({ title: decode(title), cost: decode(cost), desc: textOf(desc) }));
}

function hiddenCostsByProvider(html: string): Map<string, string> {
  const section = sectionFrom(html, '<h2 id="hidden-costs">', CLOUD_COMPARISON);
  return new Map([...section.matchAll(/<h3>([^<]*)[\s\S]*?<\/h3>\s*<p class="diff-desc">([\s\S]*?)<\/p>/g)]
    .map(([, provider, desc]) => [decode(provider).trim(), textOf(desc)]));
}

let server: ChildProcess;
const pages = new Map<string, string>();

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
  for (const page of [AWS_GUIDE, CLOUD_COMPARISON]) {
    const response = await fetch(`${base}${page}`);
    assert.strictEqual(response.status, 200, page);
    pages.set(page, await response.text());
  }
});

after(() => {
  server?.kill();
});

describe("the AWS guide charges every public IPv4 address, attached or idle, as AWS has since 2024-02-01", () => {
  it("gives the public IPv4 card AWS's hourly rate for every address, with AWS's announcement quoted", () => {
    const card = gotchaCards(pages.get(AWS_GUIDE)!).find(({ title }) => title === PUBLIC_IPV4_CARD.title);
    assert.deepStrictEqual(card, PUBLIC_IPV4_CARD);
  });

  it("gives the Multi-AZ card RDS's Single-AZ and Multi-AZ rates, both paid from a new account's credits", () => {
    const card = gotchaCards(pages.get(AWS_GUIDE)!).find(({ title }) => title === MULTI_AZ_CARD.title);
    assert.deepStrictEqual(card, MULTI_AZ_CARD);
  });
});

describe("the cloud comparison's hidden costs give the IPv4 prices AWS and DigitalOcean state", () => {
  for (const [provider, sentence] of Object.entries(HIDDEN_COSTS)) {
    it(`states ${provider}'s IPv4 charge in its hidden costs card`, () => {
      const card = hiddenCostsByProvider(pages.get(CLOUD_COMPARISON)!).get(provider);
      assert.ok(card !== undefined, `no ${provider} card in the hidden costs`);
      assert.ok(card.includes(sentence), `${provider}: ${card}`);
    });
  }
});

describe("the AWS guide and the cloud comparison serve none of the withdrawn IP-address and Multi-AZ claims", () => {
  for (const page of [AWS_GUIDE, CLOUD_COMPARISON]) {
    it(`serves none of them on ${page}`, () => {
      const html = pages.get(page)!;
      const found = Object.entries(WITHDRAWN)
        .filter(([, pattern]) => pattern.test(html))
        .map(([claim, pattern]) => `${claim} ("${html.match(pattern)![0]}")`);
      assert.deepStrictEqual(found, []);
    });
  }
});
