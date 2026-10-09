import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const decode = (s: string) =>
  s.replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

interface Page {
  text: string;
  meta: string;
  chooseVercel: string;
  tables: { head: string[]; rows: string[][] }[];
  scaleIntro: string;
  scaleBottomLine: string;
  netlifyProStat: string;
  overTheLimitsCard: string;
}

function readPage(html: string): Page {
  const body = html.replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  const tables = [...body.matchAll(/<table class="pricing-table">([\s\S]*?)<\/table>/g)].map(t => ({
    head: [...(t[1].match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(c => plain(c[1])),
    rows: [...(t[1].match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => plain(c[1]))),
  }));
  const scale = body.slice(body.indexOf('<h2 id="scale">'), body.indexOf('<h2 id="when">'));
  return {
    text: plain(body.replace(/<div class="more-guides"[\s\S]*$/, " ")),
    meta: plain(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ""),
    chooseVercel: plain(body.match(/<strong>Choose Vercel if:<\/strong>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? ""),
    tables,
    scaleIntro: plain(scale.match(/<p class="section-intro">([\s\S]*?)<\/p>/)?.[1] ?? ""),
    scaleBottomLine: plain(scale.match(/<div class="context-box">([\s\S]*?)<\/div>/)?.[1] ?? ""),
    netlifyProStat: plain(body.match(/<div class="stat-number green">([^<]*)<\/div><div class="stat-label">Netlify Pro<\/div>/)?.[1] ?? ""),
    overTheLimitsCard: body.match(/<div class="diff-card"[^>]*>\s*<h3>Credit Exhaustion vs\. Hard Limits<\/h3>\s*<p class="diff-desc">([\s\S]*?)<\/p>/)?.[1] ?? "",
  };
}

let proc: ChildProcess | null = null;
let page: Page;

function startServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", e => { clearTimeout(timeout); reject(e); });
  });
}

const rowNamed = (rows: string[][], name: string) => rows.find(r => r[0] === name);

describe("/vercel-vs-netlify prices each vendor's plans as the vendor does", () => {
  before(async () => {
    const started = await startServer();
    proc = started.child;
    const res = await fetch(`http://localhost:${started.port}/vercel-vs-netlify`);
    assert.strictEqual(res.status, 200);
    page = readPage(await res.text());
  });

  after(() => proc?.kill());

  it("lists Netlify's Personal and Pro plans, and SAML SSO at what each vendor charges, in the Cost at Scale table", () => {
    const scale = page.tables.find(t => t.head.join("|") === "Metric|Vercel|Netlify|Notes");
    assert.ok(scale, JSON.stringify(page.tables.map(t => t.head)));
    assert.deepStrictEqual(scale.rows.map(r => r[0]), ["First paid plan", "Team plan", "Bandwidth at 1 TB", "Builds", "Serverless compute", "SAML SSO", "Spending protection"]);
    assert.deepStrictEqual(rowNamed(scale.rows, "First paid plan"), [
      "First paid plan", "$20/mo per developer seat (Pro)", "$9/mo, 1 member (Personal)",
      "Netlify Personal includes 1,000 credits a month. Vercel has no plan between Hobby and Pro",
    ]);
    assert.deepStrictEqual(rowNamed(scale.rows, "Team plan"), [
      "Team plan", "$20/mo per developer seat (Pro)", "$20/mo, unlimited members (Pro)",
      "Vercel bills each developer seat; viewer seats are free. Netlify Pro charges for no seat",
    ]);
    assert.deepStrictEqual(rowNamed(scale.rows, "Bandwidth at 1 TB"), [
      "Bandwidth at 1 TB", "$20/mo (1 TB included in Pro)", "$126/mo (20,000-credit Pro tier)",
      "Vercel Pro includes 1 TB. Netlify charges 20 credits per GB, so 1 TB takes its largest Pro tier before any deploy or compute",
    ]);
    assert.deepStrictEqual(rowNamed(scale.rows, "Builds"), [
      "Builds", "Included in Pro", "15 credits per production deploy",
      "Netlify has no build-minute allowance on current plans. Each production deploy draws on the plan's monthly credits",
    ]);
    assert.deepStrictEqual(rowNamed(scale.rows, "SAML SSO"), [
      "SAML SSO", "$300/mo add-on to Pro; included in Enterprise", "Enterprise only (price not published)",
      "Neither $20 plan includes SAML SSO",
    ]);
  });

  it("introduces the section with each vendor's next plans and closes it on what they cost", () => {
    assert.strictEqual(
      page.scaleIntro,
      "What happens when you outgrow the free tier? Vercel's next plan is Pro at $20 a month per developer seat. Netlify's are Personal at $9 a month for one member, then Pro at $20 a month for unlimited members.",
    );
    assert.strictEqual(
      page.scaleBottomLine,
      "Bottom line on scaling: For one developer, Netlify's first paid plan costs less: Personal is $9 a month for 1,000 credits, against $20 for Vercel Pro. For a team, Vercel Pro costs $20 a month per developer seat, while Netlify Pro is $20 a month for unlimited members with 3,000 credits, and larger credit tiers cost up to $126 a month. Neither includes SAML SSO on its $20 plan: Vercel sells it as a $300-a-month add-on to Pro, and Netlify offers it only on Enterprise, at a price it doesn't publish. Vercel Pro includes 1 TB of bandwidth; Netlify charges 20 credits per GB. For solo developers, the commercial-use restriction on Vercel's free tier matters more than the price gap.",
    );
  });

  it("calls Netlify's free plan Free and counts its builds in credits", () => {
    const free = page.tables.find(t => t.head[0] === "Feature");
    assert.ok(free, JSON.stringify(page.tables.map(t => t.head)));
    assert.deepStrictEqual(free.head, ["Feature", "Vercel Hobby", "Netlify Free", "Notes"]);
    assert.deepStrictEqual(rowNamed(free.rows, "Builds"), [
      "Builds", "Included (no separate limit)", "15 credits per production deploy",
      "Vercel includes builds. Netlify's 300 credits cover about 20 production deploys if spent on nothing else",
    ]);
    assert.strictEqual(rowNamed(free.rows, "Team Members")?.[2], "1 (Free plan)");
    assert.strictEqual(rowNamed(free.rows, "Commercial Use")?.[3], "Critical difference: Vercel Hobby prohibits commercial use. Netlify Free allows it");
    assert.strictEqual(page.netlifyProStat, "$20/mo");
  });

  it("recommends Vercel for SAML SSO only as the add-on it sells", () => {
    assert.strictEqual(
      page.chooseVercel,
      "You're building with Next.js (deepest integration, fastest builds, latest features first), your free tier project is non-commercial (personal blog, portfolio, learning project), or your team needs SAML single sign-on without an Enterprise plan (Vercel sells it as a $300-a-month add-on to Pro; Netlify offers it only on Enterprise). Best for: Next.js apps, personal projects, teams requiring enterprise SSO.",
    );
  });

  it("prices Vercel Pro per developer seat and describes the comparison as one of builds", () => {
    assert.ok(page.text.includes("you need Pro at $20 a month per developer seat. Netlify's Free plan allows commercial use."), "the big-difference paragraph");
    assert.ok(page.text.includes("Vercel requires upgrading to Pro ($20 a month per developer seat)."), "the commercial-use card");
    assert.match(page.meta, /^Compare Vercel and Netlify free tiers side-by-side\. Bandwidth, serverless functions, builds, storage, commercial use — /);
  });

  it("gives Vercel's own rule for a Hobby project over a usage limit, with the Hobby doc and the day it was read", () => {
    assert.strictEqual(
      decode(page.overTheLimitsCard.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      "When Netlify credits run out, sites pause (no overage charges). When a Vercel Hobby project exceeds a usage limit, Vercel says that in most cases you have to wait until 30 days have passed before you can use that feature again. Neither charges overages on free plans. (From vercel.com/docs/plans/hobby, read 2026-10-07.)",
    );
    assert.match(page.overTheLimitsCard, /<a href="https:\/\/vercel\.com\/docs\/plans\/hobby" rel="nofollow noopener">/);
    assert.doesNotMatch(page.text, /throttl|degrades/i);
  });

  it("names no Netlify plan, price or unit that Netlify's pricing page does not list", () => {
    for (const gone of [/Netlify Starter/, /Starter plan/, /Starter =/, /Business/, /\$99/, /\$19/, /5×/, /per-seat/, /\/member/]) {
      assert.doesNotMatch(page.text, gone);
    }
    for (const table of page.tables.filter(t => t.head[2]?.startsWith("Netlify"))) {
      for (const row of table.rows) assert.doesNotMatch(row[2], /\bmin\b|minutes?\b|\/member/, row.join(" | "));
    }
  });
});
