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

  it("gives no reason to choose Mixpanel that both free plans share, such as seats or per-event pricing", async () => {
    const page = await (await fetch(`${base}/amplitude-vs-mixpanel`)).text();
    const served = [plain(withoutPricingChangeHistory(withoutHeadScriptsAndStyles(page))), ...jsonLdStrings(page)].join(" ");
    assert.ok(served.includes("Choose Mixpanel if you prefer its reports; on the free plans, Amplitude includes more events (2M a month against Mixpanel's 1M)."), "the Mixpanel recommendation");
    const reasons = served.match(/Choose Mixpanel if[^.]*\./g) ?? [];
    assert.deepStrictEqual(reasons.filter(reason => /seats|per-event|pricing clarity/i.test(reason)), []);
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

  it("gives Amplitude 1 year of data access and Mixpanel 2 years by default in the retention card", () => {
    const card = plain(body.match(/<h3>Data retention limits on free plans<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1] ?? "");
    assert.ok(card.includes("Amplitude's Free plan gives 1 year of data access."), card);
    assert.ok(card.includes("Mixpanel keeps data for 2 years by default on its free plan."), card);
  });

  it("states replay, flag, retention and permanent free terms in the named provider's columns", () => {
    const table = body.match(/<table class="comp-table">([\s\S]*?)<\/table>/)?.[1];
    assert.ok(table);
    assert.deepStrictEqual([...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(c => plain(c[1])), [
      "Service", "Free Tier Limit", "Session Replay", "Feature Flags", "Data Retention", "Self-Hosted", "Privacy / GDPR", "Permanent Free", "API Access",
    ]);
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(c => ({ text: plain(c[2]), attributes: c[1] })));
    const row = (vendor: string) => {
      const matches = rows.filter(r => r[0]?.text === vendor || r[0]?.text.startsWith(vendor + " "));
      assert.strictEqual(matches.length, 1, vendor);
      assert.strictEqual(matches[0].length, 9, vendor);
      return matches[0];
    };
    assert.deepStrictEqual(rows.filter(r => r[0]?.text.includes("June.so")), []);
    assert.deepStrictEqual(rows.filter(r => r.length === 9).map(r => ["PostHog", "Mixpanel", "Amplitude", "Google Analytics", "Heap (Contentsquare)", "Plausible", "Umami", "Fathom", "Simple Analytics", "Matomo", "Countly", "Pirsch"].find(vendor => r[0].text === vendor || r[0].text.startsWith(vendor + " "))), [
      "PostHog", "Mixpanel", "Amplitude", "Google Analytics", "Heap (Contentsquare)", "Plausible", "Umami", "Fathom", "Simple Analytics", "Matomo", "Countly", "Pirsch",
    ]);
    assert.deepStrictEqual(row("Mixpanel").slice(2, 5).map(c => c.text), ["✓ 10K/mo", "✓ Up to 10 active", "2 years (default)"]);
    assert.strictEqual(row("Heap (Contentsquare)")[2].text, "&#10007; Paid add-on (Pro, Premier)");
    assert.match(row("Heap (Contentsquare)")[2].attributes, /class="cross"/);
    assert.strictEqual(row("Umami")[4].text, "Cloud free: 6 months; self-hosted: unlimited");
    assert.strictEqual(row("Umami")[8].text, "✓ Self-hosted; Cloud Pro and up");
    assert.strictEqual(row("Simple Analytics")[1].text, "Free for hobby sites: 5 websites, badge required");
    assert.strictEqual(row("Simple Analytics")[4].text, "Free plan: 1 month");
    assert.strictEqual(row("Simple Analytics")[7].text, "✓");
    assert.match(row("Simple Analytics")[7].attributes, /class="check"/);
    assert.strictEqual(row("Pirsch")[1].text, "No free plan (30-day trial, then from $6/mo for 10K pageviews)");
    assert.strictEqual(row("Pirsch")[7].text, "&#10007;");
    assert.match(row("Pirsch")[7].attributes, /class="cross"/);
  });

  it("keeps June's shutdown in its card and withdraws its startup recommendation", () => {
    const card = body.match(/<h3>June\.so<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(card);
    assert.strictEqual(plain(card), "June shut down its product after joining Amplitude in August 2025.");
    assert.doesNotMatch(html, /Startup-friendly auto-reports|No session replay \(they partner with other tools\)|unlimited retention on its free plan/);
    for (const sentence of [
      "Free plan: 10K session replays a month, up to 10 active feature flags, data kept 2 years by default.",
      "Session replay is a paid add-on on Pro and Premier.",
      "Pricing: No free plan; a 30-day trial, then from $6/month for 10K pageviews.",
      "From $20/month (100K pageviews). A free plan for hobby sites: 5 websites, the latest month of data, badge required.",
      "1M events free, with data kept 2 years by default.",
      "Lightweight script (2.5KB).",
      "experiments billed with feature flags, and 1,500 survey responses a month.",
    ]) assert.ok(plain(body).includes(sentence), sentence);
  });

  it("counts Amplitude's free session replays at 10K a month", () => {
    const trap = plain(body.match(/<strong>The session replay add-on trap:<\/strong>([\s\S]*?)<\/div>/)?.[1] ?? "");
    assert.ok(trap.includes("Amplitude's Free plan includes 10K a month."), trap);
  });
});
