import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPopulationFloor } from "./population-floor.ts";
import {
  HUNDRED_GB_SCENARIO,
  ONE_TO_ONE_SCENARIO,
  STORAGE_SCALE_WORKLOADS,
  billableEgressGb,
  billableEgressGbAfterMonthlyGrant,
  egressBillAfterMonthlyGrant,
  formatMonthlyStorageCost,
  monthlyEgressGrantGb,
  monthlyEgressGrantSentence,
  monthlyStorageCost,
  monthlyStorageCostAfterMonthlyEgressGrant,
  rateCardFor,
  scaleCostFor,
} from "../dist/storage-cost-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const S3 = rateCardFor("AWS S3");
const GRANT_GB = monthlyEgressGrantGb("AWS S3");

const NAMES_AWS = /\bAWS\b|\bS3\b|Amazon S3/;
const EGRESS = /egress|bandwidth|data transfer|transfer out|data out|outbound data/i;
const EXPIRY = /12[- ]months?\b|12[- ]mo\b|first year|expires?\b|expired\b|introductory|fixed term/i;
const NO_ACCOUNT_AGE_CONDITION = /account of any age|whatever its age|no expiry|does not expire|never expires|no account-age/i;

const GRANT_NEAR_EGRESS = new RegExp(
  `${GRANT_GB}\\s?GB[\\s\\S]{0,120}(?:${EGRESS.source})|(?:${EGRESS.source})[\\s\\S]{0,120}${GRANT_GB}\\s?GB`,
  "i",
);

const GRANT_CALLED_FREE = new RegExp(`free[^.]{0,60}${GRANT_GB}\\s?GB|${GRANT_GB}\\s?GB[^.]{0,60}free`, "i");

function publishesTheGrant(block: string): boolean {
  return NAMES_AWS.test(block) && EGRESS.test(block) && GRANT_CALLED_FREE.test(block);
}

const BLOCK_END = /<\/(?:td|th|p|li|dd|dt|h[1-6]|div|figcaption|caption|option|summary|blockquote)>/g;
const BLOCK_MARK = "␞";

function readable(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<datalist[\s\S]*?<\/datalist>/g, " ")
    .replace(/<select[\s\S]*?<\/select>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ");
}

function flatten(chunk: string): string {
  return chunk
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "’")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function blocksOf(html: string): string[] {
  return readable(html).replace(BLOCK_END, BLOCK_MARK).split(BLOCK_MARK).map(flatten).filter(Boolean);
}

type EgressCell = { header: string; provider: string; cell: string };

function egressCellsNamingAws(html: string): EgressCell[] {
  const found: EgressCell[] = [];
  for (const table of readable(html).matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const headers = [...table[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(header => flatten(header[1]));
    const egressColumns = headers.map((header, at) => (EGRESS.test(header) ? at : -1)).filter(at => at >= 0);
    if (egressColumns.length === 0) continue;
    for (const row of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => flatten(cell[1]));
      if (cells.length !== headers.length) continue;
      if (!NAMES_AWS.test(cells[0]!)) continue;
      for (const column of egressColumns) found.push({ header: headers[column]!, provider: cells[0]!, cell: cells[column]! });
    }
  }
  return found;
}

function markupEmbeddedInAFeed(body: string): string {
  return body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function timeLimitsTheGrant(block: string): boolean {
  if (!NAMES_AWS.test(block)) return false;
  if (!GRANT_NEAR_EGRESS.test(block)) return false;
  if (!EXPIRY.test(block)) return false;
  return !NO_ACCOUNT_AGE_CONDITION.test(block);
}

function startServer(inventoryOut: string): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1", AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 180000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, base: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("AWS's monthly internet egress allowance is published as the standing grant it is", () => {
  let proc: ChildProcess;
  let served: string[] = [];
  const blocks = new Map<string, string[]>();
  const markup = new Map<string, string>();
  const refused: string[] = [];

  before(async () => {
    const inventoryOut = path.join(mkdtempSync(path.join(tmpdir(), "aws-egress-")), "inventory.json");
    const server = await startServer(inventoryOut);
    proc = server.proc;
    served = JSON.parse(readFileSync(inventoryOut, "utf-8"));
    for (const pagePath of served) {
      const response = await fetch(server.base + pagePath, { redirect: "manual" });
      if (response.status !== 200) {
        refused.push(`${pagePath} answered ${response.status}`);
        continue;
      }
      const body = await response.text();
      const servedAsHtml = (response.headers.get("content-type") ?? "").includes("text/html");
      const html = servedAsHtml ? body : markupEmbeddedInAFeed(body);
      markup.set(pagePath, html);
      blocks.set(pagePath, blocksOf(html));
    }
  });

  after(() => {
    proc?.kill();
  });

  it("read every page the server declares", () => {
    assert.deepStrictEqual(refused, []);
    assertPopulationFloor(blocks.size, 1800, "pages read for an AWS egress claim");
  });

  it("flags a block that hangs an expiry on the allowance, and clears one that does not", () => {
    assert.ok(
      timeLimitsTheGrant(`AWS S3 free egress: ${GRANT_GB} GB/mo (12 mo)`),
      "the guard misses a cell that time-limits the allowance",
    );
    assert.ok(
      timeLimitsTheGrant(`Why not AWS S3: the free tier expires after 12 months, then egress costs $0.09/GB. At ${GRANT_GB} GB egress/month that is $9/month just for bandwidth.`),
      "the guard misses prose that time-limits the allowance",
    );
    assert.ok(
      !timeLimitsTheGrant(`S3 storage is free for 12 months. ${monthlyEgressGrantSentence(S3)}.`),
      "the guard flags prose that separates the expiring storage grant from the standing egress one",
    );
    assert.ok(
      !timeLimitsTheGrant("The AWS Free Tier credits expire 12 months after account creation."),
      "the guard flags a claim about credits that says nothing about egress",
    );
    assert.ok(
      publishesTheGrant(`${monthlyEgressGrantSentence(S3)}.`),
      "the sentence the pages publish does not read as a statement of the grant",
    );
    assert.ok(
      !publishesTheGrant(`Comparison of storage free tiers — S3 egress tax breakdown, zero-egress providers, and scaling costs at ${GRANT_GB}GB/1TB/10TB/100TB`),
      "a scale label reads as a statement of the grant",
    );
  });

  it("states no expiry on the allowance anywhere it is published", () => {
    const offenders: string[] = [];
    for (const [pagePath, pageBlocks] of blocks) {
      for (const block of pageBlocks) {
        if (timeLimitsTheGrant(block)) offenders.push(`${pagePath}: ${block.slice(0, 240)}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("says on every page that publishes the allowance that it holds on an account of any age", () => {
    const publishing: string[] = [];
    for (const [pagePath, pageBlocks] of blocks) {
      if (!pageBlocks.some(publishesTheGrant)) continue;
      publishing.push(pagePath);
      assert.ok(
        pageBlocks.some(block => NAMES_AWS.test(block) && NO_ACCOUNT_AGE_CONDITION.test(block)),
        `${pagePath} publishes the ${GRANT_GB} GB allowance and never says it survives the first year`,
      );
    }
    for (const named of ["/storage-comparison-2026", "/hosting-alternatives", "/free-saas-stack", "/free-nextjs-stack", "/free-django-stack", "/free-fastapi-stack", "/free-go-stack", "/serverless-free-tier-comparison-2026"]) {
      assert.ok(publishing.includes(named), `${named} no longer publishes the allowance at all`);
    }
  });

  it("hangs no expiry on an AWS row in any egress column, in a table or out of one", () => {
    const control = egressCellsNamingAws(
      `<table><thead><tr><th>Service</th><th>Free Egress</th></tr></thead><tbody><tr><td>AWS S3</td><td>${GRANT_GB} GB/mo (12 mo)</td></tr></tbody></table>`,
    );
    assert.strictEqual(control.length, 1, "the table reader does not find an AWS row under an egress header");
    assert.ok(EXPIRY.test(control[0]!.cell), "the table reader does not read the qualifier in the cell");

    const offenders: string[] = [];
    const read: string[] = [];
    for (const [pagePath, html] of markup) {
      for (const { header, provider, cell } of egressCellsNamingAws(html)) {
        read.push(`${pagePath} ${header}`);
        if (EXPIRY.test(cell) && !NO_ACCOUNT_AGE_CONDITION.test(cell)) offenders.push(`${pagePath} ${provider} ${header}: ${cell}`);
      }
    }
    assert.ok(read.length > 0, "no page states an AWS egress allowance in a table at all");
    assert.deepStrictEqual(offenders, []);
  });

  it("prices no AWS bandwidth bill at the allowance and bills every byte past it", () => {
    assert.strictEqual(billableEgressGbAfterMonthlyGrant(S3, HUNDRED_GB_SCENARIO), 0);
    assert.strictEqual(egressBillAfterMonthlyGrant(S3, HUNDRED_GB_SCENARIO), 0);
    const oneGbOver = { storageGb: HUNDRED_GB_SCENARIO.storageGb, egressGb: GRANT_GB + 1 };
    assert.strictEqual(billableEgressGbAfterMonthlyGrant(S3, oneGbOver), 1);
    assert.strictEqual(egressBillAfterMonthlyGrant(S3, oneGbOver), S3.egressPerGb);
    assert.strictEqual(
      formatMonthlyStorageCost(egressBillAfterMonthlyGrant(S3, ONE_TO_ONE_SCENARIO)),
      formatMonthlyStorageCost((ONE_TO_ONE_SCENARIO.egressGb - GRANT_GB) * S3.egressPerGb),
    );
  });

  it("publishes no bandwidth bill on a stack page that the allowance already covers", () => {
    const atTheAllowance = formatMonthlyStorageCost(egressBillAfterMonthlyGrant(S3, HUNDRED_GB_SCENARIO));
    for (const pagePath of ["/free-saas-stack", "/free-nextjs-stack", "/free-django-stack", "/free-fastapi-stack", "/free-go-stack"]) {
      const pageBlocks = blocks.get(pagePath);
      assert.ok(pageBlocks, `${pagePath} was not read`);
      const card = pageBlocks.find(block => block.includes("Why not AWS S3"));
      assert.ok(card, `${pagePath} no longer carries the AWS S3 card`);
      assert.match(card, new RegExp(`${GRANT_GB} GB`), `${pagePath} states no allowance`);
      assert.ok(NO_ACCOUNT_AGE_CONDITION.test(card), `${pagePath} time-limits the allowance in its own card`);
      assert.doesNotMatch(card, /\$9\/month just for bandwidth/, `${pagePath} still bills the allowance`);
      assert.ok(
        !/bandwidth bill|for bandwidth/.test(card) || card.includes(atTheAllowance),
        `${pagePath} names a bandwidth bill at the allowance that is not ${atTheAllowance}`,
      );
    }
  });

  it("quotes the unit rate and never the rate times a hundred", () => {
    const perGb = `$${S3.egressPerGb.toFixed(2)}/GB`;
    const timesAHundred = `$${(S3.egressPerGb * 100).toFixed(0)}/GB`;
    for (const [pagePath, pageBlocks] of blocks) {
      for (const block of pageBlocks) {
        assert.ok(!block.includes(timesAHundred), `${pagePath} prices S3 egress at ${timesAHundred}: ${block.slice(0, 200)}`);
      }
    }
    const saas = blocks.get("/free-saas-stack");
    assert.ok(saas?.some(block => block.includes(perGb)), `/free-saas-stack no longer states ${perGb}`);
  });

  it("leaves the scaling table netting out no fixed monthly grant", () => {
    assert.deepStrictEqual(
      STORAGE_SCALE_WORKLOADS.map((workload: { storageGb: number; egressGb: number }) => scaleCostFor("AWS S3", workload)),
      ["$11.30", "$113", "$1,130", "$11,300"],
    );
    for (const workload of STORAGE_SCALE_WORKLOADS as { storageGb: number; egressGb: number; label: string }[]) {
      assert.strictEqual(
        monthlyStorageCost(S3, workload),
        workload.storageGb * S3.storagePerGbMonth + billableEgressGb(S3, workload) * S3.egressPerGb,
        `${workload.label} had a fixed grant netted out of the table`,
      );
    }
    assert.ok(
      monthlyStorageCost(S3, HUNDRED_GB_SCENARIO) > monthlyStorageCostAfterMonthlyEgressGrant(S3, HUNDRED_GB_SCENARIO),
      "the table rule and the allowance rule have collapsed into one answer",
    );
  });
});
