import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/analytics-free-tier-comparison-2026";

const STALE_AMPLITUDE_TERMS = /\bMTUs?\b|Monthly Tracked Users?|\b1K\b|unlimited (data )?retention/i;

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;|&#39;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&rarr;/g, "→").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&#10003;/g, "✓").replace(/&#9679;/g, "●")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();
}

const PLUS_PLAN_SIZING = "Plus plan is sized in MTUs or events";

function withoutPricingChangeHistory(page: string): string {
  return page.replace(/<h2[^>]*>Pricing Change History<\/h2>[\s\S]*?(?=<h2)/, " ");
}

function jsonLdStrings(html: string): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const [, block] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) walk(JSON.parse(block!));
  return strings;
}

function startServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", err => { clearTimeout(timeout); reject(err); });
  });
}

function withoutHeadScriptsAndStyles(page: string): string {
  return page.replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
}

describe(`${PAGE} states Amplitude's Free plan and GA4's sampling quota as the vendors do`, () => {
  let child: ChildProcess | undefined;
  let base = "";
  let html = "";
  let body = "";

  before(async () => {
    const started = await startServer();
    child = started.child;
    base = `http://localhost:${started.port}`;
    html = await (await fetch(`${base}${PAGE}`)).text();
    body = withoutHeadScriptsAndStyles(html);
  });

  after(() => child?.kill());

  it("says on both Amplitude comparison pages that its Free plan counts events, naming MTUs only for the paid Plus plan", async () => {
    for (const route of ["/amplitude-vs-posthog", "/amplitude-vs-mixpanel"]) {
      const page = await (await fetch(`${base}${route}`)).text();
      assert.match(page, /<h2[^>]*>Pricing Change History<\/h2>/, `${route} lost the history section this check sets aside`);
      const served = [plain(withoutPricingChangeHistory(withoutHeadScriptsAndStyles(page))), ...jsonLdStrings(page)].join(" ");
      assert.ok(served.includes("Amplitude's Free plan counts events (2M a month); its paid Plus plan is sized in MTUs or events."), `${route} lost the pricing-model sentence`);
      const mtuSentences = served.split(/(?<=[.!?])\s+/).filter(sentence => /\bMTUs?\b|Monthly Tracked User/.test(sentence));
      assert.deepStrictEqual(mtuSentences.filter(sentence => !sentence.includes(PLUS_PLAN_SIZING)), [], route);
      assert.doesNotMatch(served, /\b1K\b|10M events|the most events/, route);
    }
  });

  it("gives Amplitude 2M events in /analytics-alternatives' introduction, table and answer", async () => {
    const page = withoutHeadScriptsAndStyles(await (await fetch(`${base}/analytics-alternatives`)).text());
    assert.ok(page.includes("<strong>Amplitude</strong> gives <strong>2M events a month</strong>."), "the introduction");
    const row = page.match(/<tr>\s*<td[^>]*><a href="\/vendor\/amplitude"[\s\S]*?<\/tr>/)?.[0] ?? "";
    assert.ok(row.includes("<td>2M events/mo</td>"), `the table row: ${plain(row)}`);
    assert.ok(plain(page).includes("Amplitude — 2M events a month on the Free plan, with unlimited feature flags and 1 year of data access."), "the self-serve answer");
    assert.doesNotMatch(plain(page), /10M events(,| with| and) 10K MTU/);
  });

  it("prices Amplitude's free plan at 2M events in the cost model behind /estimate and /budget-builder", async () => {
    for (const route of ["/estimate", "/budget-builder"]) {
      const page = await (await fetch(`${base}${route}`)).text();
      assert.match(page, /\{"slug":"amplitude","name":"Amplitude","free":"2M events\/mo"/, route);
      assert.doesNotMatch(page, /"free":"10K MTU"/, route);
    }
  });

  it("never describes Amplitude's free plan in MTUs, with 1K replays or with unlimited retention", () => {
    const prose = [plain(body.replace(/<table[\s\S]*?<\/table>/g, " ")), ...jsonLdStrings(html)].join(" ");
    const sentences = prose.split(/(?<=[.!?])\s+/).filter(sentence => sentence.includes("Amplitude"));
    assert.ok(sentences.length >= 5, `the page names Amplitude in ${sentences.length} sentences, so the rule checks little`);
    assert.deepStrictEqual(sentences.filter(sentence => STALE_AMPLITUDE_TERMS.test(sentence.replace(PLUS_PLAN_SIZING, ""))), []);
  });

  it("prices Amplitude at $0 in the cost table wherever its Free plan's 2M events cover the scenario", () => {
    const table = body.match(/<table[^>]*>(?:(?!<\/table>)[\s\S])*?<th>Usage Scenario<\/th>[\s\S]*?<\/table>/)?.[0] ?? "";
    const head = [...(table.match(/<tr>([\s\S]*?)<\/tr>/)?.[1] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(cell => plain(cell[1]!));
    const amplitude = head.indexOf("Amplitude");
    assert.ok(amplitude > 0, `no Amplitude column: ${head}`);
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map(row => [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => plain(cell[1]!)));
    const byScenario = Object.fromEntries(rows.map(cells => [cells[0], cells[amplitude]]));
    assert.strictEqual(byScenario["500K events/mo"], "$0 (free)");
    assert.strictEqual(byScenario["2M events/mo"], "$0 (free)");
    assert.deepStrictEqual(rows.map(cells => cells[amplitude]).filter(cell => /MTU/.test(cell ?? "")), []);
  });

  it("gives Amplitude's table row 2M events, 10K replays, unlimited flags and 1 year of data", () => {
    const row = body.match(/<tr>\s*<td class="provider-col">Amplitude\b[\s\S]*?<\/tr>/)?.[0] ?? "";
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => plain(cell[1]!));
    assert.ok(cells[0]?.startsWith("Amplitude"), `no Amplitude row: ${cells[0]}`);
    const card = body.match(/<h3>Amplitude\b(?:(?!<\/h3>)[\s\S])*<\/h3>/)?.[0] ?? "";
    assert.ok(card, "no Amplitude card");
    assert.deepStrictEqual([row, card].filter(html => html.includes("caution-badge")), [], "Amplitude still carries a caution badge");
    const cardText = body.match(/<h3>Amplitude\b(?:(?!<\/h3>)[\s\S])*<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.strictEqual(plain(cardText), "Free tier: 2M events a month, 10K session replays a month, 1 year of data access and 10 saved charts, no credit card (amplitude.com/pricing, read 2026-10-07).");
    assert.match(cardText, /<a href="https:\/\/amplitude\.com\/pricing" rel="nofollow noopener">/);
    assert.deepStrictEqual(cells.slice(1, 5), ["2M events/mo", "✓ 10K/mo", "✓ Unlimited", "1 year"]);
  });

  it("puts 2M events a month on Amplitude's stat card", () => {
    assert.match(body, /<div class="stat-number green">2M<\/div><div class="stat-label">Amplitude Free Events\/mo<\/div>/);
  });

  it("states GA4's sampling quota with Google's page and the day it was read", () => {
    const trap = plain(body.match(/<strong>The Google Analytics "free" trap:<\/strong>([\s\S]*?)<\/div>/)?.[1] ?? "");
    assert.ok(trap.includes("In GA4, explorations and other event-level queries are sampled above 10 million events per query on standard properties (support.google.com/analytics/answer/13331292, read 2026-10-07)."), trap);
    assert.match(body, /<a href="https:\/\/support\.google\.com\/analytics\/answer\/13331292" rel="nofollow noopener">/);
    assert.doesNotMatch(plain(body), /500K sessions/);
  });

  it("gives Amplitude 1 year of data access in the retention card and leaves unlimited retention to Mixpanel", () => {
    const card = plain(body.match(/<h3>Data retention limits on free plans<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1] ?? "");
    assert.ok(card.includes("Amplitude's Free plan gives 1 year of data access."), card);
    assert.ok(card.includes("Mixpanel offers unlimited retention on its free plan"), card);
  });

  it("counts Amplitude's free session replays at 10K a month", () => {
    const trap = plain(body.match(/<strong>The session replay add-on trap:<\/strong>([\s\S]*?)<\/div>/)?.[1] ?? "");
    assert.ok(trap.includes("Amplitude's Free plan includes 10K a month."), trap);
  });
});
