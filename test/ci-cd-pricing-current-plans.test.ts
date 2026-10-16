import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as Array<Record<string, any>>;

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&rsquo;": "’",
};

function readableText(html: string): string {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:strong|em|b|i|a|span|code)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

function cicdListing(vendor: string): Record<string, any> {
  const listings = offers.filter((o) => o.vendor === vendor && o.category === "CI/CD");
  assert.strictEqual(listings.length, 1, `expected one CI/CD listing for ${vendor}, found ${listings.length}`);
  return listings[0];
}

function listedFigure(vendor: string, pattern: RegExp, what: string): string {
  const description = String(cicdListing(vendor).description);
  const match = description.match(pattern);
  assert.ok(match, `the ${vendor} listing no longer states ${what}: ${description}`);
  return match![1];
}

function buddyFreePlan(): { gbMinutes: string; cache: string } {
  return {
    gbMinutes: listedFigure("Buddy", /\b(\d[\d,]*) pipeline GB-minutes\/month\b/, "its pipeline GB-minutes a month"),
    cache: listedFigure("Buddy", /\b(\d+ [GM]B) pipeline cache\b/, "its pipeline cache"),
  };
}

function appcircleStarterPlan(): { builds: string; maxMinutes: string } {
  return {
    builds: listedFigure("Appcircle", /\b(\d[\d,]*) builds\/month\b/, "its builds a month"),
    maxMinutes: listedFigure("Appcircle", /\b(\d+)-minute max build time\b/, "its maximum build time"),
  };
}

function codemagicFreePlanSentence(): string {
  return listedFigure("Codemagic", /— (Single-user plan [^.]*?teams get none\.)/, "its single-user plan in one sentence ending with teams getting none");
}

function tableRows(html: string, headers: string[]): Map<string, string[]> {
  const tables: Map<string, string[]>[] = [];
  for (const [, table] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const heads = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => readableText(m[1]));
    if (heads.join(" | ") !== headers.join(" | ")) continue;
    const rows = new Map<string, string[]>();
    for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => readableText(m[1]));
      if (cells.length === headers.length) rows.set(cells[0], cells.slice(1));
    }
    tables.push(rows);
  }
  assert.strictEqual(tables.length, 1, `expected one table headed ${headers.join(" | ")}, found ${tables.length}`);
  return tables[0];
}

function rowOf(rows: Map<string, string[]>, vendor: string): string[] {
  const row = rows.get(vendor);
  assert.ok(row, `no row for ${vendor}`);
  return row!;
}

function cardText(html: string, slug: string): string {
  const cards = [...html.matchAll(/<div class="diff-card"[^>]*><h3><a href="\/vendor\/([^"]+)"[^>]*>[\s\S]*?<\/h3><p class="diff-desc">([\s\S]*?)<\/p>/g)]
    .filter(([, cardSlug]) => cardSlug === slug);
  assert.strictEqual(cards.length, 1, `expected one category card for /vendor/${slug}, found ${cards.length}`);
  return readableText(cards[0][2]);
}

function faqAnswers(html: string, question: string): string[] {
  const visible = [...html.matchAll(/<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)]
    .filter(([, q]) => readableText(q) === question)
    .map(([, , a]) => readableText(a));
  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, json]) => JSON.parse(json))
    .filter((data) => data["@type"] === "FAQPage")
    .flatMap((data) => data.mainEntity)
    .filter((entry: any) => entry.name === question)
    .map((entry: any) => String(entry.acceptedAnswer.text));
  return [...visible, ...structured];
}

let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { base = `http://localhost:${match[1]}`; clearTimeout(timeout); resolve(proc); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const CI_CD_PRICING = "/ci-cd-pricing";
const SITEMAPS_OF_HAND_WRITTEN_PAGES = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];
const AGENT_TEXT_ROUTES = ["/llms.txt", "/llms-full.txt"];

const PRICING_TABLE = ["Tool", "Free Minutes/mo", "Concurrency", "Self-Hosted", "Paid From", "Model"];
const FREE_TIER_TABLE = ["Tool", "Free Tier Type", "Free Minutes", "When You Hit the Wall"];
const COST_TABLE = ["Tool", "Solo / Small /mo", "Team /mo", "Key Cost Factor"];

const PRICING_MODELS_QUESTION = "How do CI/CD pricing models differ?";
const PRICING_MODELS_ANSWER = "There are three main models: per-seat (GitLab, Buildkite), per-minute/credit (CircleCI, AWS CodeBuild, Google Cloud Build), and per-parallel-job (Azure DevOps). Per-seat is predictable but penalizes large teams. Per-minute rewards fast builds but can spike. Per-parallel-job charges for concurrency.";

const WITHDRAWN: Record<string, RegExp> = {
  "Bitbucket Pipelines' Standard plan priced at $15 a user": /\$15\/user\/mo \(Standard\)/,
  "Codemagic priced per seat at $49": /\$49\/seat/,
  "Buddy's free plan given as 120 build minutes and 5 projects": /120 build minutes\/month, 5 projects/,
  "Appcircle's free plan given as 300 build minutes and 2 build profiles": /300 build minutes\/month, 1 concurrent build, 2 build profiles/,
  "Appcircle's Professional plan at $49 a month": /Professional at \$49\/mo/,
  "Buddy priced per pipeline": /per-pipeline \(Buddy\)/i,
  "Bitbucket Pipelines' self-hosted runners as paid only": /Paid only \(runners\)/,
  "Bitbucket Pipelines' self-hosted runners as needing Standard or higher": /require Standard plan or higher/,
};

describe("/ci-cd-pricing states the current plans of Bitbucket Pipelines, Codemagic, Buddy, Appcircle and CircleCI", () => {
  let proc: ChildProcess | undefined;
  let html = "";

  before(async () => {
    proc = await startServer();
    html = await (await fetch(`${base}${CI_CD_PRICING}`)).text();
  });

  after(() => { proc?.kill(); });

  it("prices Bitbucket Pipelines' Standard plan at $3.65 a user in the pricing and cost tables, and gives its free plan self-hosted runners that use no build minutes", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Bitbucket Pipelines"), ["50 min/mo", "1 concurrent", "Yes (no build minutes used)", "$3.65/user/mo (Standard)", "Per-user + minutes"]);
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Bitbucket Pipelines").slice(0, 2), ["$3.65/user", "$3.65/user + overages"]);
  });

  it("prices Codemagic by the minute, with $49 buying an extra concurrent build rather than a seat", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Codemagic"), ["500 min/mo", "1 concurrent", "N/A (managed)", "Per minute (Pay-as-you-go); $49/mo per extra concurrent build", "Per-minute"]);
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Codemagic"), ["$0–49", "Per minute + $49/concurrency", "500 minutes is reasonable for mobile. Pay-as-you-go charges per minute. macOS M2..."]);
  });

  it("opens the Codemagic card with the single-user plan its listing states, which teams do not get", () => {
    assert.ok(cardText(html, "codemagic").startsWith(`${codemagicFreePlanSentence()} 1 concurrent build. Optimized for Flutter`), cardText(html, "codemagic"));
  });

  it("gives Buddy's free plan in the pipeline GB-minutes and cache its listing states, and Pro at $29 for 2 seats", () => {
    const { gbMinutes, cache } = buddyFreePlan();
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Buddy"), [`${gbMinutes} pipeline GB-min/mo`, "1 concurrent", "Paid only", "$29/mo (Pro, 2 seats)", "Per-seat + concurrency"]);
    assert.deepStrictEqual(rowOf(tableRows(html, FREE_TIER_TABLE), "Buddy"), ["Limited free tier", `${gbMinutes} pipeline GB-min/mo`, "1–4 weeks for active team"]);
    assert.ok(cardText(html, "buddy").startsWith(`Free plan: 1 seat, 1 concurrent run, ${gbMinutes} pipeline GB-minutes a month, ${cache} cache, 300 sandbox CPU-minutes. Visual pipeline builder`), cardText(html, "buddy"));
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Buddy"), ["$29", "$29+ (Pro)", "Buddy's Pro plan: $29 a month, includes 2 seats; each additional seat $9 a month..."]);
  });

  it("gives Appcircle's free Starter plan in the builds and build time its listing states, with Corporate as the only other plan", () => {
    const { builds, maxMinutes } = appcircleStarterPlan();
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "Appcircle"), [`${builds} builds/mo, ${maxMinutes} min/build`, "1 concurrent", "Corporate only", "Custom (Corporate)", "Per-plan"]);
    assert.deepStrictEqual(rowOf(tableRows(html, FREE_TIER_TABLE), "Appcircle"), ["Limited free tier", `${builds} builds/mo, ${maxMinutes} min/build`, "1–4 weeks for active team"]);
    assert.ok(cardText(html, "appcircle").startsWith(`Starter plan: 1 concurrent build, ${maxMinutes} minutes maximum per build, ${builds} builds a month. Mobile CI/CD`), cardText(html, "appcircle"));
    assert.deepStrictEqual(rowOf(tableRows(html, COST_TABLE), "Appcircle"), ["$0", "Custom (Corporate)", "20 builds a month is tight for iOS. Above Starter, the only plan is Corporate, t..."]);
  });

  it("says CircleCI's free plan includes self-hosted runner time, 5 tasks at once", () => {
    assert.deepStrictEqual(rowOf(tableRows(html, PRICING_TABLE), "CircleCI"), ["6,000 min/mo", "30 concurrent jobs", "Free runner time; 5 concurrent self-hosted tasks", "$15/seat (Performance)", "Credit-based"]);
  });

  it("names three pricing models in the FAQ, on the page and in its structured data, with no per-pipeline model for Buddy", () => {
    assert.deepStrictEqual(faqAnswers(html, PRICING_MODELS_QUESTION).map((answer) => answer.startsWith(PRICING_MODELS_ANSWER)), [true, true]);
  });

  it("leaves no guide, report, other hand-written page or llms text making any of the withdrawn CI/CD plan claims", async () => {
    const routes = new Set<string>(AGENT_TEXT_ROUTES);
    for (const sitemap of SITEMAPS_OF_HAND_WRITTEN_PAGES) {
      const xml = await (await fetch(`${base}${sitemap}`)).text();
      for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(loc).pathname);
    }
    assert.ok(routes.has(CI_CD_PRICING), "the sitemaps no longer list the page this sweep is for");
    const found: string[] = [];
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      assert.strictEqual(response.status, 200, `${route} answers ${response.status}`);
      const text = readableText(await response.text());
      for (const [what, pattern] of Object.entries(WITHDRAWN)) {
        if (pattern.test(text)) found.push(`${route}: ${what}`);
      }
    }
    assert.deepStrictEqual(found, []);
  });
});
