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

const GCP_TRIAL_RESTRICTIONS =
  "New accounts only: never a paying user of Google Cloud, Google Maps Platform or Firebase; no GPUs during the trial";
const MORE_THAN_8_VCPU = />\s*8 vCPU/;

function decode(text: string): string {
  return text
    .replace(/&gt;/g, ">")
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

function namedFor(firstCell: string, name: string): boolean {
  return firstCell === name || firstCell.startsWith(`${name} `);
}

function trialCreditsTable(): { headers: string[]; rows: string[][] } {
  const section = html.slice(html.indexOf('<h2 id="trial-credits"'));
  const table = section.slice(0, section.indexOf("</table>"));
  return {
    headers: [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(([, cell]) => textOf(cell)),
    rows: [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell)))
      .filter((cells) => cells.length >= 2),
  };
}

let server: ChildProcess;
let html = "";

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

describe("the cloud comparison says no free trial charges the card when its credit runs out unless the account is upgraded", () => {
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

describe("the cloud comparison's trial table gives GCP the eligibility rule and limits Google's Free Trial page states", () => {
  it("says in GCP's Restrictions cell that only accounts that never paid for Google Cloud, Google Maps Platform or Firebase get the trial, and that it allows no GPUs", () => {
    const { headers, rows } = trialCreditsTable();
    const gcp = rows.find((cells) => namedFor(cells[0], "GCP"));
    assert.ok(gcp, "the trial table has no GCP row");
    assert.strictEqual(gcp[headers.indexOf("Restrictions")], GCP_TRIAL_RESTRICTIONS);
  });

  it("gives the trial no cap of 8 vCPUs, which Google's Free Trial page does not state", () => {
    assert.ok(trialCreditsTable().rows.some((cells) => namedFor(cells[0], "GCP")), "the trial table has no GCP row");
    assert.strictEqual(textOf(html).match(MORE_THAN_8_VCPU)?.[0], undefined);
  });
});
