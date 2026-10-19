import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer, DealChange } from "../src/types.ts";
import { alternativeAllowanceOpening } from "../dist/alternative-allowance.js";
import { toSlug } from "../dist/vendor-slug.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "alternative-allowances-"));
const children: ChildProcess[] = [];
const pages = new Map<string, string>();
const SHORT = 'Free plan gives 42 searches per month. No card required! A third sentence is omitted.';
const ESCAPED = 'Free plan gives <50 searches & "unlimited" projects. No card required.';
const LONG = `Free plan gives ${"search requests ".repeat(23)}each month. Another sentence.`;
const WORD_CUT = `Free plan gives ${"search requests ".repeat(17)}search…`;
const WITHHELD = "Free plan: 900 searches per month. Stored obsolete allowance.";
const CONDITION = { text: "Personal use only.", quote: "Personal use only.", url: "https://allowance.example/terms", read_on: "2026-08-01" };

function listing(vendor: string, description: string, category = "AI / ML"): Offer {
  return {
    vendor, description, category, tier: "Free", url: `https://${toSlug(vendor)}.example/pricing`,
    verifiedDate: "2026-08-01", tags: [], conditions: [CONDITION],
    product_subtypes: {
      taxonomy: category,
      labels: [{ subtype: category === "AI / ML" ? "web_search_api" : "relational", source_url: "https://allowance.example", source_quote: "Search API" }],
      reviewed: "2026-08-01",
    },
  };
}

const fixtures = [
  listing("Allowance Subject", "Subject's free plan."),
  listing("Short Allowance", SHORT),
  listing("Long Allowance", LONG),
  listing("Escaped Allowance", ESCAPED),
  listing("Whole Allowance", "Free plan gives 42 searches per month. No card required."),
  listing("Withheld Allowance", WITHHELD),
  listing("Unread Allowance", WITHHELD),
  listing("Corrected Allowance", WITHHELD),
  listing("Duplicate Allowance", SHORT),
  { ...listing("Duplicate Allowance", "Different second offer that its primary details do not print."), tier: "Free Credits", url: "https://duplicate-allowance.example/credits" },
  listing("Database Subject", "Subject's database plan.", "Databases"),
  listing("Database Allowance", SHORT, "Databases"),
];
const changes: DealChange[] = ["Withheld Allowance", "Unread Allowance", "Corrected Allowance"].map(vendor => ({
  vendor, category: "AI / ML", change_type: vendor === "Corrected Allowance" ? "record_corrected" : "limits_reduced", date: "2026-08-28", date_source: "vendor_page",
  summary: "Free plan now allows 30 searches per month.", previous_state: WITHHELD,
  current_state: vendor === "Withheld Allowance" ? "Free plan: 30 searches per month. No card required." : "The previous terms no longer apply.",
  source_url: `https://${toSlug(vendor)}.example/pricing`, impact: "high", alternatives: [],
}));

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&darr;/g, "↓").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

async function start(indexPath?: string, changesPath?: string): Promise<string> {
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off",
      ...(indexPath ? { AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_CHANGES_PATH: changesPath! } : {}) },
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server startup timeout: ${log}`)); }, 30_000);
    child.stderr!.on("data", chunk => {
      log = (log + chunk).slice(-3000);
      const match = log.match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${log}`)); });
  });
}

async function read(base: string, route: string): Promise<string> {
  const response = await fetch(base + route, { redirect: "error" });
  assert.equal(response.status, 200, route);
  return response.text();
}

function allowances(html: string, route: string, vendor: string): string[] {
  const blocks = route.startsWith("/vendor/")
    ? [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => m[1])
    : [...html.matchAll(/<div class="alt-row(?: curated)?">([\s\S]*?)(?=<div class="alt-row|<\/div>\s*<\/div>\s*<\/div>\s*<div class="section|$)/g)].map(m => m[1]);
  const found = blocks.filter(block => block.includes(`href="/vendor/${toSlug(vendor)}"`));
  assert.ok(found.length > 0, `${route}: ${vendor} row missing`);
  return found.map(block => {
    const match = block.match(/<span class="alternative-allowance-text">([\s\S]*?)<\/span>/);
    assert.ok(match, `${route}: ${vendor} allowance missing`);
    return text(match[1]);
  });
}

before(async () => {
  const live = await start();
  for (const route of ["/vendor/brave-search-api", "/alternative-to/brave-search-api"]) pages.set(route, await read(live, route));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: fixtures }));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes }));
  const fixture = await start(path.join(scratch, "index.json"), path.join(scratch, "changes.json"));
  for (const route of ["/vendor/allowance-subject", "/alternative-to/allowance-subject", "/vendor/database-subject", "/alternative-to/database-subject",
    "/vendor/withheld-allowance", "/vendor/unread-allowance", "/vendor/corrected-allowance"]) pages.set(route, await read(fixture, route));
});

after(() => {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

describe("alternative allowances use the opening of their vendor details", () => {
  for (const [details, expected] of [
    [SHORT, "Free plan gives 42 searches per month. No card required!"],
    ["Free plan? Yes! A third sentence.", "Free plan? Yes!"],
    ["Search API. 2,500 free requests each month. Paid follows.", "Search API. 2,500 free requests each month."],
    ['The plan is "free." No card required. Paid follows.', 'The plan is "free." No card required.'],
    ["Credits cost $0.008 each at api.example.com. Free: 1,000 per month. Paid follows.", "Credits cost $0.008 each at api.example.com. Free: 1,000 per month."],
    ["A single sentence without punctuation", "A single sentence without punctuation"],
    [LONG, WORD_CUT],
    ["x".repeat(301), "…"],
    ["x".repeat(300), "x".repeat(300)],
  ]) it(`bounds a ${details.length}-character description`, () => {
    assert.equal(alternativeAllowanceOpening(details), expected);
    assert.ok(alternativeAllowanceOpening(details).length <= 300);
  });

  for (const route of ["/vendor/brave-search-api", "/alternative-to/brave-search-api"]) it(`${route} names Tavily's monthly allowance`, () => {
    const terms = allowances(pages.get(route)!, route, "Tavily AI");
    assert.equal(terms.length, 1);
    assert.match(terms[0], /1,000 API credits per month/);
    const catalogue: Offer[] = JSON.parse(readFileSync(path.join(ROOT, "data/index.json"), "utf8")).offers;
    const tavily = catalogue.find(o => o.vendor === "Tavily AI")!;
    assert.ok(tavily.description.startsWith(terms[0]));
    assert.doesNotMatch(terms[0], /A basic search/);
  });

  for (const route of ["/vendor/allowance-subject", "/alternative-to/allowance-subject"]) {
    for (const [vendor, expected] of [["Short Allowance", "Free plan gives 42 searches per month. No card required!"], ["Escaped Allowance", ESCAPED], ["Long Allowance", WORD_CUT]]) {
      it(`${route} prints ${vendor}'s bounded, escaped details`, () => {
        assert.deepEqual(allowances(pages.get(route)!, route, vendor), [expected]);
        if (vendor === "Escaped Allowance") assert.ok(pages.get(route)!.includes('Free plan gives &lt;50 searches &amp; &quot;unlimited&quot; projects. No card required.'));
      });
    }
    for (const vendor of ["Withheld Allowance", "Unread Allowance", "Corrected Allowance"]) it(`${route} repeats ${vendor}'s published notice without its stored terms`, () => {
      const ownPage = pages.get(`/vendor/${toSlug(vendor)}`)!;
      const match = ownPage.match(/<h2>Free Tier Details<\/h2>\s*<p class="terms-superseded-text"[^>]*>([\s\S]*?)<\/p>/);
      assert.ok(match, `${vendor}: details were not withheld`);
      const details = text(match[1]);
      const terms = allowances(pages.get(route)!, route, vendor);
      assert.equal(terms.length, 1);
      assert.ok(details.startsWith(terms[0].replace(/…$/, "")), `${route}: differs from its own details`);
      assert.ok(terms[0].startsWith(vendor === "Corrected Allowance" ? "Withheld:" : "Superseded:"));
      assert.doesNotMatch(terms[0], /900 searches|Stored obsolete allowance/);
      assert.ok(terms[0].length <= 300);
    });
    it(`${route} uses a vendor's primary details for its secondary listing too`, () => {
      const terms = allowances(pages.get(route)!, route, "Duplicate Allowance");
      assert.equal(terms.length, route.startsWith("/vendor/") ? 2 : 1);
      for (const term of terms) assert.equal(term, "Free plan gives 42 searches per month. No card required!");
    });
    it(`${route} follows a complete description with its conditions`, () => {
      const html = pages.get(route)!;
      const at = html.indexOf('<span class="alternative-allowance-text">Free plan gives 42 searches per month. No card required.</span>');
      assert.ok(at >= 0);
      const block = html.slice(at, html.indexOf('</div>', at));
      assert.match(block, /<ul class="listing-conditions"/);
      assert.match(block, /Personal use only\./);
      assert.match(block, /href="https:\/\/allowance.example\/terms"/);
      assert.match(block, /read 2026-08-01/);
    });
    it(`${route} adds no conditions to a clipped description or a withholding notice`, () => {
      const blocks = [...pages.get(route)!.matchAll(/<div class="alternative-allowance"[^>]*>([\s\S]*?)<\/div>/g)].map(m => m[1]);
      const clipped = blocks.filter(block => /search…|Superseded:|Withheld:/.test(block));
      assert.ok(clipped.length >= 4);
      for (const block of clipped) assert.doesNotMatch(block, /listing-conditions|Personal use only/);
    });
  }

  for (const route of ["/vendor/database-subject", "/alternative-to/database-subject"]) it(`${route} includes allowances outside AI / ML`, () => {
    assert.deepEqual(allowances(pages.get(route)!, route, "Database Allowance"), ["Free plan gives 42 searches per month. No card required!"]);
  });
});
