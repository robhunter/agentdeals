import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/cloud-free-tier-comparison-2026";

const STATED = [
  "All require a credit card. None of the AWS, GCP or Azure trials charges that card when its credit runs out unless you upgrade: Google closes the Free Trial billing account, AWS closes the Free plan account, and Azure disables the subscription.",
  "Spending limit: the free account's spending limit is on by default, so your card is not charged; at 30 days or when the $200 credit runs out, services are disabled unless you upgrade. Upgrading to pay-as-you-go removes the limit, and from then on there is no automatic stop.",
];

const WITHDRAWN: Record<string, RegExp> = {
  "Azure's free account running up pay-as-you-go charges once its trial expires": /charges accumulate|Once your \$200 trial expires/,
  "Azure's free account with no spending cap": /No spending cap/,
  "the Azure card labelled as one major trap": /One major trap/,
};

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
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

let server: ChildProcess;
let html = "";

describe("the cloud comparison says no free trial charges the card when its credit runs out unless the account is upgraded", () => {
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
    const response = await fetch(`${base}${PAGE}`);
    assert.strictEqual(response.status, 200, PAGE);
    html = await response.text();
  });
  after(() => {
    server?.kill();
  });

  it("states that the AWS, GCP and Azure trials leave the card uncharged unless the account is upgraded", () => {
    const text = textOf(html);
    assert.deepStrictEqual(STATED.filter((line) => !text.includes(line)), []);
  });

  it("serves none of the withdrawn Azure claims", () => {
    const found = Object.entries(WITHDRAWN)
      .filter(([, pattern]) => pattern.test(html))
      .map(([claim, pattern]) => `${claim} ("${html.match(pattern)![0]}")`);
    assert.deepStrictEqual(found, []);
  });
});
