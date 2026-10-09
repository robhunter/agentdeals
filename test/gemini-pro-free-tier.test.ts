import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(REPO, "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
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
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "'", "&lsquo;": "'", "&nbsp;": " ", "&darr;": "↓", "&rsaquo;": ">",
  "&lt;": "<", "&gt;": ">", "&middot;": "·", "&rarr;": "→", "&nearr;": "↗", "&hellip;": "…",
};

const INLINE_TAG = /<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi;

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function withoutHeadAndScripts(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ");
}

function readableText(html: string): string {
  const withoutMarkup = withoutHeadAndScripts(html).replace(INLINE_TAG, "").replace(/<[^>]+>/g, " ");
  return decode(withoutMarkup).replace(/\s+/g, " ").trim();
}

function structuredStrings(html: string): string[] {
  const strings: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) strings.push(decode(m[1]));
  for (const m of html.matchAll(/<title>([\s\S]*?)<\/title>/gi)) strings.push(decode(m[1]));
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    try {
      walk(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return strings.map((s) => s.replace(/\s+/g, " ").trim());
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

type Surface = "page" | "metadata";

function unitsOf(html: string): { surface: Surface; unit: string }[] {
  const units: { surface: Surface; unit: string }[] = [];
  for (const text of structuredStrings(html)) {
    for (const unit of sentencesOf(text)) units.push({ surface: "metadata", unit });
  }
  const body = withoutHeadAndScripts(html).replace(INLINE_TAG, "").replace(/<[^>]+>/g, "\n");
  for (const line of decode(body).split("\n")) {
    for (const unit of sentencesOf(line)) units.push({ surface: "page", unit });
  }
  return units;
}

function storedSentences(file: string): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8")));
  return [...new Set(strings.flatMap(sentencesOf))].filter((sentence) => sentence.length >= 20);
}

const CHANGE_RECORD_SENTENCES = storedSentences("deal_changes.json");
const LISTING_SENTENCES = storedSentences("index.json");

const RETIRED_FREE_TIER_LINES = [
  "10-15 RPM",
  "10–15 RPM",
  "10 RPM (Flash)",
  "15 RPM (Flash-Lite)",
  "1,500 requests/day",
  "1,500 req/day",
  "1,500 free requests",
  "Gemini 2.5 Pro 25 req/day",
  "full removal September 24, 2026",
  "Migrate to 2.5 models",
  "migrate to 2.5 models",
  "Gemini Code Assist is new in late 2025",
];
const RETIRED_CUT_SIZE = "50-80%";
const CUT_SIZE_READS_AS_GEMINI_WITHIN = 200;
const QUOTE_REACHES_BACK_AT_LEAST = 20;

const STORED_WITH_A_RETIRED_LINE = [...CHANGE_RECORD_SENTENCES, ...LISTING_SENTENCES]
  .filter((sentence) => [...RETIRED_FREE_TIER_LINES, RETIRED_CUT_SIZE].some((needle) => sentence.includes(needle)));

function quotesAStoredSentence(text: string, at: number, needle: string): boolean {
  return STORED_WITH_A_RETIRED_LINE.some((sentence) => {
    for (let within = sentence.indexOf(needle); within >= 0; within = sentence.indexOf(needle, within + 1)) {
      const start = at - within;
      if (start < 0) continue;
      if (text.startsWith(sentence, start)) return true;
      if (within >= QUOTE_REACHES_BACK_AT_LEAST && text.startsWith(sentence.slice(0, within + needle.length), start)) return true;
    }
    return false;
  });
}

function retiredLinesOutsideStoredText(route: string, surface: Surface, text: string): string[] {
  const found: string[] = [];
  const check = (at: number, needle: string) => {
    if (quotesAStoredSentence(text, at, needle)) return;
    found.push(`${route} (${surface}) "${needle}": ${text.slice(Math.max(0, at - 60), at + needle.length + 40)}`);
  };
  for (const needle of RETIRED_FREE_TIER_LINES) {
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) check(at, needle);
  }
  for (let at = text.indexOf(RETIRED_CUT_SIZE); at >= 0; at = text.indexOf(RETIRED_CUT_SIZE, at + 1)) {
    const around = text.slice(Math.max(0, at - CUT_SIZE_READS_AS_GEMINI_WITHIN), at + RETIRED_CUT_SIZE.length + CUT_SIZE_READS_AS_GEMINI_WITHIN);
    if (/Gemini/i.test(around)) check(at, RETIRED_CUT_SIZE);
  }
  return found;
}

const NAMES_2_5_PRO_WITH_THE_FREE_TIER = /free[^.]{0,60}2\.5 Pro|2\.5 Pro[^.]{0,60}free/i;
const DATED = /\b20\d\d-\d\d(?:-\d\d)?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (?:\d{1,2}, )?20\d\d\b/;

function quotesAChangeRecord(unit: string): boolean {
  return CHANGE_RECORD_SENTENCES.some((sentence) => unit.includes(sentence) || sentence.includes(unit.replace(/(?:\.{3}|…)$/, "")));
}

type Sentence = { route: string; surface: Surface; sentence: string };

async function locs(sitemap: string): Promise<string[]> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (m) => m[1].replace(/^https?:\/\/[^/]+/, "") || "/",
  );
}

async function everyPublishedRoute(): Promise<string[]> {
  const routes = new Set<string>(["/"]);
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const child = m[1].replace(/^https?:\/\/[^/]+/, "");
    for (const p of await locs(child)) routes.add(p);
  }
  return [...routes].filter((p) => !p.endsWith(".xml"));
}

type Crawl = { geminiPages: number; retired: string[]; proWithTheFreeTier: Sentence[] };

async function crawl(routes: string[]): Promise<Crawl> {
  const result: Crawl = { geminiPages: 0, retired: [], proWithTheFreeTier: [] };
  const queue = [...routes];
  const worker = async () => {
    for (let route = queue.pop(); route !== undefined; route = queue.pop()) {
      const response = await fetch(`${base}${route}`);
      if (!response.ok) continue;
      const html = await response.text();
      result.retired.push(
        ...retiredLinesOutsideStoredText(route, "page", readableText(html)),
        ...retiredLinesOutsideStoredText(route, "metadata", structuredStrings(html).join(" ")),
      );
      if (!/gemini/i.test(html)) continue;
      result.geminiPages++;
      for (const { surface, unit } of unitsOf(html)) {
        if (NAMES_2_5_PRO_WITH_THE_FREE_TIER.test(unit)) result.proWithTheFreeTier.push({ route, surface, sentence: unit });
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return result;
}

const S1 = "The free tier covers the Gemini 3.x Flash and Flash-Lite models. Google publishes no free-tier limits; AI Studio shows each project's.";
const S2 = "Since 2026-09-18 Google serves the Gemini 2.5 models only to users who used them before. New projects use 3.5 Flash-Lite or 3.8 Flash.";
const S3 = "On 2025-12-06 Google cut 2.5 Flash's free tier from 250 requests a day to about 20, and 2.5 Pro's to none.";

const STATED: Record<string, string[]> = {
  "/gcp-free-tier-2026": [
    "Gemini API free tier (AI Studio) + Cloud Run functions + Cloud Storage.",
    "$300 credit for 90 days. Credit card or other payment method required. Accounts opened after 2026-03-02 cannot spend it on the Gemini API. During the trial you cannot add GPUs to VM instances, use Google Cloud Marketplace, request a quota increase or create Windows Server VMs, and the credit does not pay for partner generative AI models offered as a managed API (model as a service).",
    "Free tier on the Gemini 3.x Flash and Flash-Lite models; limits shown per project in AI Studio",
    "The $300 trial is credit for Google Cloud products over 90 days; accounts opened after 2026-03-02 cannot spend it on the Gemini API. During the trial you cannot add GPUs to VM instances, use Google Cloud Marketplace, request a quota increase or create Windows Server VMs, and the credit does not pay for partner generative AI models offered as a managed API (model as a service).",
    "The Gemini API has its own free tier, with limits shown per project in AI Studio.",
  ],
  "/shutdowns": [
    "Gemini 2.0 Flash and 2.0 Flash-Lite shut down on June 1, 2026. Image generation via 2.0 Flash shut down November 14, 2025.",
    "Calls to the gemini-2.0-flash and gemini-2.0-flash-lite model IDs no longer work.",
    "Google recommends gemini-3.6-flash for 2.0 Flash and gemini-3.1-flash-lite for 2.0 Flash-Lite.",
  ],
  "/llm-api-pricing": [
    "Google's Gemini free tier covers the 3.x Flash and Flash-Lite models; 3.1 Pro Preview is paid-only.",
    "Google's Gemini free tier covers the 3.x Flash and Flash-Lite models. Gemini 3.1 Pro Preview has no free tier.",
  ],
  "/free-llm-apis": ["Google publishes no free-tier limits; AI Studio shows each project's."],
  "/ai-free-tiers": [S3],
  "/state-of-free-tiers": [],
  "/free-tier-risk": [
    "Google cut the free tier on 2025-12-06: 2.5 Flash went from 250 requests a day to about 20, and 2.5 Pro to none. Since 2026-09-18 the 2.5 models are limited to earlier users. The 3.x Flash models are free, with limits Google does not publish.",
  ],
  "/openai-assistants-migration": [
    "Free on Gemini 3.x Flash models",
    "Google Gemini API has a free tier on its 3.x Flash models.",
    "Switching providers can reduce or increase costs, depending on the models you move to.",
  ],
  "/gemini-api-pricing-2026": [
    "Gemini API billing changes in March and April 2026: spend caps by tier ($250 to $100K+ a month, enforced from April 1), prepay for new users and, from a cutover reported as October 12, 2026, for existing Postpay accounts, and Gemini 3.1 Pro Preview paid only. The free tier covers the Gemini 3.x Flash and Flash-Lite models.",
    "Google began enforcing monthly spend caps on the Gemini API on April 1, 2026 (Tier 1: $250, Tier 2: $2,000, Tier 3: $20,000 to $100,000+). When a billing account reaches its cap, requests pause until the next billing month. New users default to Prepay (minimum $5), and existing Postpay accounts must switch to Prepay by the cutover date in their account notice, reported as October 12, 2026. Gemini 3.1 Pro Preview is paid only.",
    "What Changed on April 1",
    "Since April 1, 2026, billing-account spend caps pause API requests when an account reaches its tier's cap.",
    "Prepay by default for new users; Postpay accounts must switch (reported cutover October 12, 2026)",
    "Minimum $5 prepayment",
    "Dated changes to the Gemini API's free tier and billing.",
    "Google added project-level spend caps on March 12, 2026.",
    "Free Tier Cut",
    S3,
    S1,
    S2,
    "Not published. About 5 RPM and 20 RPD on 2.5 Flash, none on 2.5 Pro (2025-12-06)",
    "92% fewer daily requests on 2.5 Flash",
    "If you built on the free tier before December 2025: on 2025-12-06, 2.5 Flash's daily requests fell from 250 to about 20 and 2.5 Pro's to none. Gemini 3.1 Pro Preview has no free tier.",
    "Not published; shown per project in AI Studio",
    "No free Pro model for new projects.",
    "Gemini 3.1 Pro Preview has no free tier. The free tier covers the 3.x Flash and Flash-Lite models, including 3.8 Flash.",
    "3. Move to the 3.x models — Gemini 2.0 Flash shut down on 2026-06-01, and new projects cannot use the 2.5 models. Google points new projects to gemini-3.5-flash-lite or gemini-3.8-flash.",
    "Stay on Gemini Flash. Set budget alerts, and use 3.5 Flash-Lite or 3.8 Flash for new work.",
    "Two additional changes that affect paid and high-usage developers.",
    "Prepaid billing for all paid accounts",
    "New users default to Prepay and buy at least $5 of credits to set up billing.",
    "Google is moving existing paid accounts from Postpay to Prepay for Gemini API usage: switch on the AI Studio Billing page and buy credits before the cutover date in your account notice, reported as October 12, 2026, or the account's paid Gemini API service is interrupted. Only Gemini API usage moves to Prepay; other Google Cloud services on the same billing account stay on Postpay.",
    "Accounts that use only the free tier need take no action. Eligible Google Cloud credits are used only after you have bought Prepay credits, and stop being used when the Prepay balance reaches $0.",
    "The Gemini 3.x Flash and Flash-Lite models are free. Google publishes no free-tier limits; AI Studio shows each project's. For lightweight tasks such as classification, extraction and simple Q&A, 3.5 Flash-Lite or 3.1 Flash-Lite costs nothing.",
    "1. Set project-level spend caps in AI Studio (available since March 12, 2026; Google marks them experimental).",
    "every project on a billing account shares its tier spend cap",
    "Set project-level spend caps in AI Studio (available since March 12, 2026).",
    "Groq's free plan allows 30 requests a minute and 1,000 a day per model. Mistral AI's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount. OpenRouter serves 25+ free models through one API.",
    "How Gemini's free tier compares to alternatives.",
    "Groq and OpenRouter publish their free limits, which Google no longer does: Groq's free plan allows 30 requests a minute and 1,000 a day per model; OpenRouter's free models allow 20 a minute and 50 a day.",
    "This guide covers Gemini API pricing changes through September 2026.",
  ],
};

const WITHDRAWN: Record<string, string[]> = {
  "/gcp-free-tier-2026": ["Vertex AI Gemini (free tier)"],
  "/llm-api-pricing": ["$1.25/M for Gemini Pro"],
  "/openai-assistants-migration": ["30–70% (Gemini's free tier)"],
  "/gemini-api-pricing-2026": [
    "prepay at least $10",
    "Minimum $10 prepayment",
    "about 30 free models",
    "Sorted by free tier generosity",
    "more generous free tiers than Gemini",
    "pricing changes through April 2026",
    "may ask a new user to prepay",
    "may ask new users to prepay",
    "others choose between Prepay and Postpay",
    "Prepay may be required for new users",
    "prepay for some new users",
    "Prepaid billing for new users",
    "affect new and high-usage developers",
    "Mistral AI includes $10 a month in API credits",
  ],
};

describe("Gemini free tier claims", () => {
  let routes: string[] = [];
  let found: Crawl = { geminiPages: 0, retired: [], proWithTheFreeTier: [] };
  const served = new Map<string, string>();

  before(async () => {
    server = await startServer();
    routes = await everyPublishedRoute();
    found = await crawl(routes);
    for (const page of new Set([...Object.keys(STATED), ...Object.keys(WITHDRAWN), "/shutdowns"])) {
      served.set(page, await (await fetch(`${base}${page}`)).text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads every published page that mentions Gemini", () => {
    assertPopulationFloor(routes.length, 1000, "routes in the sitemap");
    assert.ok(found.geminiPages > 20, `expected many pages to mention Gemini, got ${found.geminiPages}`);
  });

  it("states none of the free-tier limits Google stopped offering, outside text quoting a stored record or listing", () => {
    assertPopulationFloor(STORED_WITH_A_RETIRED_LINE.length, 1, "stored sentences that carry a retired limit");
    assert.deepStrictEqual([...new Set(found.retired)].sort(), []);
  });

  it("names Gemini 2.5 Pro with the free tier only in a dated sentence or a change record", () => {
    assertPopulationFloor(found.proWithTheFreeTier.length, 1, "sentences naming Gemini 2.5 Pro with the free tier");
    const undated = found.proWithTheFreeTier
      .filter(({ sentence }) => !DATED.test(sentence) && !quotesAChangeRecord(sentence))
      .map(({ route, surface, sentence }) => `${route} (${surface}): ${sentence}`);
    assert.deepStrictEqual([...new Set(undated)].sort(), []);
  });

  it("publishes /gemini-api-pricing-changes in no sitemap", () => {
    assert.ok(!routes.includes("/gemini-api-pricing-changes"));
  });

  it("lists Gemini 2.0 Flash among the completed shutdowns, dated June 1, 2026", () => {
    const sections = served.get("/shutdowns")!.split(/<h2\b/).slice(1).map((section) => ({
      heading: readableText(`<h2${section.slice(0, section.indexOf("</h2>") + 5)}`),
      cards: section.split('<div class="shutdown-card"').slice(1).map((card) => readableText(`<div${card}`)),
    }));
    const holding = sections.filter(({ cards }) => cards.some((card) => card.startsWith("Gemini 2.0 Flash ")));
    assert.deepStrictEqual(holding.map(({ heading }) => heading.replace(/\s*\(\d+\)$/, "")), ["✅ Recently Completed"]);
    const card = holding[0].cards.find((text) => text.startsWith("Gemini 2.0 Flash "))!;
    assert.ok(card.includes("June 1, 2026"), card);
  });

  it("renders every replacement where it belongs", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const html = served.get(page)!;
      const text = `${readableText(html)} ${structuredStrings(html).join(" ")}`;
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("renders none of the text those replacements withdrew", () => {
    const remaining = Object.entries(WITHDRAWN).flatMap(([page, lines]) => {
      const html = served.get(page)!;
      const text = `${readableText(html)} ${structuredStrings(html).join(" ")}`;
      return lines.filter((line) => text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(remaining, []);
  });

  it("keeps saying Gemini 3.1 Pro is paid-only", () => {
    const text = readableText(served.get("/gemini-api-pricing-2026")!);
    assert.ok(/3\.1 Pro[^.]{0,60}(?:paid|no free)/i.test(text), "/gemini-api-pricing-2026 no longer states that Gemini 3.1 Pro requires payment");
  });
});
