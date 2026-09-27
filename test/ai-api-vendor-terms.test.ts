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
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
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
  "&rsquo;": "’", "&lsquo;": "‘", "&nbsp;": " ", "&darr;": "↓", "&rsaquo;": ">",
  "&lt;": "<", "&gt;": ">", "&middot;": "·", "&rarr;": "→", "&nearr;": "↗", "&hellip;": "…",
};

const INLINE_TAG = /<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi;

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function readableText(html: string): string {
  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(INLINE_TAG, "")
    .replace(/<[^>]+>/g, " ");
  return decode(body).replace(/\s+/g, " ").trim();
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

type Rule = { vendor: string; names: RegExp | null; within: number; notAfter?: RegExp; retired: RegExp[] };

const literally = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const RULES: Rule[] = [
  {
    vendor: "xAI", names: /xAI|Grok/g, within: 200,
    retired: [/\$25 (?:in )?(?:free|signup)/, /\$25 free/, /\$150\/month/, /\$175\/month/, /data sharing program/, /(?<!retired )Grok 4\.1(?! Fast was retired)/, /cheapest frontier/],
  },
  {
    vendor: "Anthropic API", names: /Anthropic|Claude(?! Code)/g, notAfter: /Claude Code|Copilot|Cursor|Windsurf/g, within: 200,
    retired: [/Limited access via console/, /Console access/, /Rate-limited \(free\)/, /Opus 5(?![.\d])/, /Claude 4 Opus/, /\$7\.3B/, /current lineup decides/],
  },
  {
    vendor: "Anthropic API", names: /Anthropic|Claude(?! Code)/g, notAfter: /Claude Code|Gemini/g, within: 60,
    retired: [/No free tier/, /free tier with rate limits/, /Free tier available/, /Free API tier/],
  },
  {
    vendor: "OpenAI", names: /OpenAI(?! Codex)|DALL-E|dall-e|gpt-image|Realtime API/g, within: 200,
    retired: [/GPT-3\.5.{0,30}?(?:only|free|3 RPM)/, /\b3 RPM\b/, /free trial credits/, /trial credits/, /GPT-4 free access/, /no GPT-4/, /limits cut Jun 2025/, /use dall-e-3/, /dall-e-3 or gpt-image-1/],
  },
  { vendor: "OpenAI", names: /Realtime API Beta/g, within: 60, retired: [/May 7, 2026/, /2026-05-07/] },
  {
    vendor: "OpenRouter", names: /OpenRouter/g, within: 200,
    retired: [/~30 free models/, /30\+ models through one API/, /~20 RPM/, /20 RPM per model/, /DeepSeek R1, Llama 3\.3/, /100\+ models (?:aggregated|from multiple)/, /across 100\+ models/, /One API key for 200\+/, /Routes to cheapest/, /Universal gateway to 200/],
  },
  { vendor: "Together AI", names: /Together(?: AI|\.ai)/g, notAfter: /Fireworks|SiliconFlow/g, within: 200, retired: [/\$1 (?:free )?credits?/] },
  {
    vendor: "Hugging Face", names: /Hugging Face/g, within: 200,
    retired: [/unlimited (?:model )?hosting/, /800K\+/, /200\+ (?:inference )?providers/, /AWS, GCP/, /Inference Pro(?!viders)/, /\$0\.06\/hr/, /free inference API access/, /Free \(inference API\)/, /models locally with their inference API/],
  },
  {
    vendor: "NVIDIA NIM", names: /NVIDIA NIM|\bNIM\b|build\.nvidia\.com/g, within: 200,
    retired: [/1,000 free (?:API )?credits/, /1K credits/, /Credit-based/, /Llama 3\.1, Mistral/, /[Ee]nterprise-grade/, /~40 RPM/, /No credit card required for development/],
  },
  { vendor: "NVIDIA NIM", names: /NVIDIA NIM/g, within: 40, retired: [/Llama 3\.1 70B/] },
  { vendor: "LLM7.io", names: /LLM7/g, within: 200, retired: [/UK-based/, /donor/, /No published (?:rate )?limits/, /30\+ models/, /DeepSeek R1, Qwen2\.5/] },
  { vendor: "Zhipu AI", names: /Zhipu|GLM-4/g, within: 200, retired: [/no rate limits/, /20 million tokens/, /GLM-4\.5-Flash/, /welcome package/] },
  { vendor: "Baseten", names: /Baseten/g, within: 200, retired: [/\$30 (?:in |free )/] },
  {
    vendor: "any vendor", names: null, within: 0,
    retired: [
      "most providers are pay-as-you-go with signup credits", "Inference Endpoints ($0.06/hr+)", "still starts at Tier 1 limits",
      "Routes to cheapest provider", "Optimized with TensorRT-LLM", "Supported by donors", "Universal gateway to 200",
      "Largest model hub (800K", "(200K) for highest quality", "Free option: Free tier with rate limits",
      "$25.00 for the preview tool on non-reasoning models, and retrieved content",
    ].map(literally),
  },
];

function everyString(file: string): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8")));
  return strings;
}

const LISTING_TIERS: string[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers.map((o: { tier: string }) => o.tier);
const STORED_TEXT = [
  ...new Set([...everyString("deal_changes.json"), ...everyString("index.json")].flatMap(sentencesOf).filter((s) => s.length >= 20)),
  ...new Set(LISTING_TIERS),
];
const RETIRED = RULES.flatMap((rule) => rule.retired);
const STORED_WITH_A_RETIRED_TERM = STORED_TEXT.filter((text) => RETIRED.some((term) => term.test(text)));
const QUOTE_REACHES_BACK_AT_LEAST = 20;

function quotesStoredText(text: string, at: number, matched: string): boolean {
  return STORED_WITH_A_RETIRED_TERM.some((stored) => {
    for (let within = stored.indexOf(matched); within >= 0; within = stored.indexOf(matched, within + 1)) {
      const start = at - within;
      if (start < 0) continue;
      if (text.startsWith(stored, start) || text.startsWith(stored.replace(/[.!?]$/, ""), start)) return true;
      if (within >= QUOTE_REACHES_BACK_AT_LEAST && text.startsWith(stored.slice(0, within + matched.length), start)) return true;
    }
    return false;
  });
}

function namesTheVendorNear(text: string, at: number, end: number, rule: Rule): boolean {
  if (!rule.names) return true;
  const from = Math.max(0, at - rule.within);
  const around = text.slice(from, Math.min(text.length, end + rule.within));
  const mentions: { at: number; end: number; vendor: boolean }[] = [];
  for (const m of around.matchAll(rule.names)) mentions.push({ at: from + m.index!, end: from + m.index! + m[0].length, vendor: true });
  for (const m of rule.notAfter ? around.matchAll(rule.notAfter) : []) mentions.push({ at: from + m.index!, end: from + m.index! + m[0].length, vendor: false });
  const before = mentions.filter((m) => m.end <= at).sort((a, b) => b.end - a.end);
  if (before.length > 0) return before[0].vendor;
  return mentions.some((m) => m.vendor && m.at >= end);
}

function retiredTermsIn(route: string, surface: string, text: string): string[] {
  const found: string[] = [];
  for (const rule of RULES) {
    for (const term of rule.retired) {
      for (const m of text.matchAll(new RegExp(term.source, `${term.flags}g`))) {
        const at = m.index!;
        const end = at + m[0].length;
        if (!namesTheVendorNear(text, at, end, rule) || quotesStoredText(text, at, m[0])) continue;
        found.push(`${route} (${surface}) ${rule.vendor} "${m[0]}": ${text.slice(Math.max(0, at - 70), end + 40)}`);
      }
    }
  }
  return found;
}

const RETIRED_PAGES = ["/dall-e-shutdown", "/openai-realtime-migration"];

const STATED: Record<string, string[]> = {
  "/google-developer-program-2026": [
    "500+ models aggregated",
  ],
  "/shutdowns": [
    "dall-e-2 and dall-e-3 removed from the API — OpenAI lists gpt-image-2, gpt-image-1 or gpt-image-1-mini as substitutes, and gpt-image-1 itself shuts down on 2026-10-23 (gpt-image-1-mini on 2026-12-01)",
    "Image generation apps calling dall-e-2 or dall-e-3",
    "Developers using the dall-e-2 or dall-e-3 model IDs in API calls",
    "Update the model parameter to gpt-image-2 — test output quality differences",
  ],
  "/llm-api-pricing": [
    "Moderation model only",
    "250 RPM, 5,000 RPD (moderation, Free tier)",
    "GPT-5.6 Sol at $4/$20 (a promotional price, available at least through November 21, 2026),",
    "Small free credits (new users)",
    "Set by usage tier",
    "New users receive a small amount of free credits to test the API. Fable 5.1: $10/$50 per MTok (input/output). Opus 5.5: $4/$20 per MTok. Sonnet 5: $2/$10 per MTok. Haiku 4.5: $1/$5 per MTok. Batch API at 50% discount. Adaptive thinking on Fable 5.1, Opus 5.5 and Sonnet 5; extended thinking on Haiku 4.5.",
    "1M-token context on Fable 5.1, Opus 5.5 and Sonnet 5; adaptive thinking; Opus 5.5, Anthropic's suggested starting model, at $4/$20",
    "None (billed per token)",
    "Set by spend tier",
    "Grok API, pay as you go: sign up at console.x.ai, then load it with credits. grok-4.7 $2.00/$6.00 (per 1M tokens, under 200k prompt tokens). grok-4.3 $1.25/$2.50 (under 200k prompt tokens). grok-build-0.1 $1.00/$2.00 (under 200k prompt tokens). Grok 4.1 Fast was retired on 2026-05-15; its model names now route to grok-4.3 at grok-4.3 rates. The Console Playground is free for testing models before adding billing.",
    "Free Console Playground for testing before adding billing; 1M-token context on grok-4.3",
    "25+ free models",
    "20 RPM, 50 req/day (free models)",
    "Free plan: 25+ free models, 4 free providers, 50 requests a day, no BYOK. Free models are capped at 20 requests a minute; accounts that have bought at least $10 of credits get 1,000 free-model requests a day. OpenAI-compatible API. By default, requests are load balanced across providers, prioritizing price. Paid plans reach 500+ models.",
    "500+ models from 80+ providers through one API; falls back to other providers when one goes down; OpenAI-compatible API",
    "Free endpoints (testing only)",
    "Up to 40 RPM",
    "Free inference endpoints on build.nvidia.com: models marked Free Endpoint, including Kimi K3, DeepSeek V4.1 Flash and NVIDIA Nemotron, can be called at no cost. Up to 40 requests per minute; limits may vary by model, and traffic from other users may cause throttling. NVIDIA's API Trial Terms allow free use for testing and evaluation only, not production.",
    "Free endpoints for prototyping; Kimi K3 and NVIDIA Nemotron can also be downloaded for self-hosted deployment",
    "Free users get $0.10 a month of Inference Providers credits (subject to change); Inference Providers serves 200+ models, and extra usage requires a credits purchase. Free accounts get 100GB of private storage and best-effort public storage. By default, requests go to the fastest available partner provider, such as Cerebras, Groq, Together or Replicate.",
    "3M+ models on the Hub; Inference Providers picks the fastest available provider by default; community ecosystem",
    "Credits for new workspaces",
    "New workspaces receive credits for testing and deployment; Baseten does not state the amount. Basic plan: $0 per month, pay as you go. Dedicated deployments bill per minute. Model APIs bill per 1M tokens: GLM-5.3 $1.40/$4.40. GLM-5.3-Flash $0.15/$0.50.",
    "Deploy custom, fine-tuned, and open-source models; Truss, Baseten's open-source standard for packaging and serving models",
    "1M tokens/24h with a free token",
    "GLM-5.3-Flash (turbo)",
    "40 RPM, 100/hour (free token)",
    "LLM inference gateway. Without a key: 10 requests a minute, 60 an hour, 500,000 tokens per 24 hours. With a free token from dash.llm7.io: 40 a minute, 100 an hour, 1,000,000 tokens per 24 hours. Free access covers turbo-tier models not marked usage-only, such as GLM-5.3-Flash and codestral-latest. Other models, including all image and speech-to-text models, need Pro ($12/mo) or a paid balance.",
    "One endpoint for 64 models; turbo-tier models such as GLM-5.3-Flash are free without a key",
    "Opus 5.5 is $4/$20 per M tokens, Sonnet 5 is $2/$10",
    "xAI retired Grok 4.1 Fast on 2026-05-15; requests to its model names now go to grok-4.3 at $1.25/M input and $2.50/M output (under 200k prompt tokens).",
    "The price floor: For open-source,",
    "($20/M on Opus 5.5, $50/M on Fable 5.1)",
    "Fable 5.1, Opus 5.5 and Sonnet 5 decide their own thinking budget (adaptive thinking) rather than taking one from the request",
    "OpenAI and Anthropic set rate limits by usage tier. OpenAI moves an organization up a tier as its paid spend grows ($5 paid for Tier 1, $50 for Tier 2, $100 for Tier 3). Anthropic places organizations on a tier based on usage history and account standing, and new organizations may start in an Evaluation tier with lower limits.",
    "(25+ free models, try different providers)",
    "Claude Opus 5.5 ($4/$20/M), or",
    "Claude Fable 5.1, Opus 5.5 or Sonnet 5 (1M context each).",
    "Anthropic Thinking: Output Tokens Add Up",
    "Rate Limits Follow Usage Tiers",
    "One model is priced Free: the moderation model omni-moderation-latest. No GPT model is priced free: GPT-6 Astra",
  ],
  "/free-llm-apis": [
    "OpenRouter aggregates 25+ free models through one OpenAI-compatible API.",
    "20 RPM (free models)",
    "25+ free models; 50 req/day, 1,000 after buying $10 of credits",
    "Qwen3.8 27B, Gemma 4 31B, Nemotron 3 Ultra",
    "Up to 40 RPM",
    "Models marked Free Endpoint",
    "Kimi K3, DeepSeek V4.1 Flash, Nemotron",
    "Testing and evaluation only, not production",
    "250 RPM (moderation, Free tier)",
    "Moderation model only; no GPT model priced free",
    "omni-moderation-latest (free); GPT-6 Astra (paid)",
    "Content moderation (free model)",
    "Small free credits for new users",
    "Claude Fable 5.1, Opus 5.5, Sonnet 5",
    "Demanding reasoning, long-horizon agentic work (Fable 5.1)",
    "None; billed per token",
    "grok-4.7, grok-4.3, grok-build-0.1",
    "Testing models in the free Console Playground",
    "OpenRouter gives one API key for 25+ free models.",
    "Of the proprietary frontier APIs, xAI and Anthropic are pay-as-you-go (Anthropic gives new users a small amount of free credits to test the API), and OpenAI prices no GPT model free.",
    "OpenRouter — 25+ free models through one OpenAI-compatible API; free models are capped at 20 requests a minute and 50 a day, or 1,000 a day once you have bought at least $10 of credits.",
    "Want to test hosted models before paying?",
    "NVIDIA NIM — free endpoints on build.nvidia.com for models marked Free Endpoint, such as Kimi K3, DeepSeek V4.1 Flash and NVIDIA Nemotron, at up to 40 requests per minute; NVIDIA's API Trial Terms allow testing and evaluation only, not production. Baseten — new workspaces receive credits for testing and deployment; Baseten does not state the amount.",
    "Or download Hugging Face models and run them locally; Hugging Face's hosted Inference Providers API serves 200+ models, with $0.10 a month of credits for free users (subject to change).",
  ],
  "/gemini-api-pricing-2026": [
    "OpenRouter (25+ free models).",
    "OpenRouter — 25+ free models through one OpenAI-compatible API.",
    "20 RPM, 50 req/day, 25+ free models",
    "Qwen3.8 27B, Gemma 4 31B, Nemotron 3 Ultra",
  ],
  "/ai-free-tiers": [
    "OpenAI removed the Assistants API on 2026-08-26.",
    "Top free LLM inference APIs compared. Rate limits as of March 2026; the OpenAI and OpenRouter rows were read on 2026-09-27.",
    "25+ free models, 20 RPM, 50 req/day",
    "Qwen3.8 27B, Gemma 4 31B, Nemotron 3 Ultra",
    "Moderation model only (250 RPM); no GPT model priced free",
    "omni-moderation-latest",
    "200+ via Inference Providers",
    "OpenAI prices one model Free, the moderation model omni-moderation-latest; no GPT model is priced free.",
  ],
  "/ai-ml-alternatives": [
    "25+ free models, 20 RPM, 50 req/day",
    "$0.10/month inference credits, 100GB private storage",
    "Model hub; 200+ models via Inference Providers",
    "OpenRouter for access to 25+ free models through one API.",
    "Hugging Face — free accounts get 100GB of private storage and best-effort public storage; Inference Providers serves 200+ models, with $0.10 a month of credits for free users. Replicate for free runs on curated models. Baseten — new workspaces receive credits for testing and deployment; Baseten does not state the amount.",
  ],
  "/free-ai-stack": [
    "OpenRouter (25+ free models) extends the free runway.",
    "Free users get $0.10 a month of Inference Providers credits — production apps can use Inference Endpoints (dedicated, from $0.033/hour).",
  ],
  "/openai-assistants-migration-2026": [
    "Web search is $10.00 per 1,000 calls, with retrieved content billed as input tokens at the model’s own rate, or $25.00 per 1,000 calls for the preview tool on non-reasoning models, whose search content tokens are free.",
    "read on 2026-09-27",
  ],
  "/free-tier-risk": [
    "New API users receive a small amount of free credits to test the API.",
    "Its API prices one model free (omni-moderation-latest); no GPT model is priced free.",
  ],
  "/openai-assistants-alternatives": [
    "OpenRouter — unified API across 500+ models from 80+ providers.",
  ],
  "/openai-assistants-migration": [
    "No GPT model is priced free",
    "Small free credits for new users",
    "Current models: Claude Fable 5.1, Opus 5.5, Sonnet 5 and Haiku 4.5.",
    "Anthropic gives new users a small amount of free credits to test the API.",
    "No GPT model priced free",
    "omni-moderation-latest is the only Free model",
    "Amount not stated",
    "Anthropic Claude — Claude Fable 5.1 for demanding reasoning and long-horizon agentic work.",
  ],
};

async function locs(sitemap: string): Promise<string[]> {
  const body = await (await fetch(`${base}${sitemap}`)).text();
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, "") || "/");
}

async function everyPublishedRoute(): Promise<string[]> {
  const routes = new Set<string>(["/"]);
  for (const child of await locs("/sitemap.xml")) {
    for (const p of await locs(child)) routes.add(p);
  }
  return [...routes].filter((p) => !p.endsWith(".xml"));
}

type Crawl = { read: number; retired: string[]; linksToRetiredPages: string[]; vendorsNamed: Set<string> };

async function crawl(routes: string[]): Promise<Crawl> {
  const result: Crawl = { read: 0, retired: [], linksToRetiredPages: [], vendorsNamed: new Set() };
  const queue = [...routes];
  const worker = async () => {
    for (let route = queue.pop(); route !== undefined; route = queue.pop()) {
      const response = await fetch(`${base}${route}`);
      if (!response.ok) continue;
      const html = await response.text();
      result.read++;
      const text = readableText(html);
      for (const rule of RULES) if (rule.names && new RegExp(rule.names.source).test(text)) result.vendorsNamed.add(rule.vendor);
      result.retired.push(
        ...retiredTermsIn(route, "page", text),
        ...retiredTermsIn(route, "metadata", structuredStrings(html).join(" ")),
      );
      for (const page of RETIRED_PAGES) if (html.includes(`href="${page}"`)) result.linksToRetiredPages.push(`${route} -> ${page}`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return result;
}

function shutdownCards(html: string): string[] {
  return html.split('<div class="shutdown-card"').slice(1).map((card) => readableText(`<div${card}`));
}

describe("AI API vendors' free terms on the guides", () => {
  let routes: string[] = [];
  let found: Crawl = { read: 0, retired: [], linksToRetiredPages: [], vendorsNamed: new Set() };
  const served = new Map<string, string>();

  before(async () => {
    server = await startServer();
    routes = await everyPublishedRoute();
    found = await crawl(routes);
    for (const page of Object.keys(STATED)) served.set(page, await (await fetch(`${base}${page}`)).text());
  });
  after(() => {
    server?.kill();
  });

  it("reads every published page, and finds each vendor the check names on at least one", () => {
    assertPopulationFloor(found.read, 1000, "published pages read");
    const named = RULES.filter((rule) => rule.names).map((rule) => rule.vendor);
    assert.deepStrictEqual([...new Set(named)].filter((vendor) => !found.vendorsNamed.has(vendor)), []);
  });

  it("states none of the vendors' retired terms near the vendor's name, outside text quoting a stored record or listing", () => {
    assertPopulationFloor(STORED_WITH_A_RETIRED_TERM.length, 1, "stored texts that carry a retired term");
    assert.deepStrictEqual([...new Set(found.retired)].sort(), []);
  });

  it("renders each vendor's current terms on the page that states them", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) => {
      const html = served.get(page)!;
      const text = `${readableText(html)} ${structuredStrings(html).join(" ")}`;
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: ${line}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("lists OpenAI's model shutdowns of October 23, 2026 on /shutdowns", () => {
    const card = shutdownCards(served.get("/shutdowns")!).find((text) => text.startsWith("OpenAI legacy model snapshots "));
    assert.ok(card, "/shutdowns has no card for OpenAI's legacy model snapshots");
    for (const expected of ["October 23, 2026", "gpt-3.5-turbo", "gpt-image-1", "gpt-5.6-terra for gpt-3.5-turbo and o4-mini", "gpt-image-2 for gpt-image-1"]) {
      assert.ok(card.includes(expected), `the card does not say "${expected}": ${card}`);
    }
  });

  it("dates the Realtime API beta's removal May 12, 2026, and links it to no retired guide", () => {
    const html = served.get("/shutdowns")!;
    const card = shutdownCards(html).find((text) => text.startsWith("OpenAI Realtime API Beta "));
    assert.ok(card?.includes("May 12, 2026"), `the Realtime API Beta card is not dated May 12, 2026: ${card}`);
    for (const page of RETIRED_PAGES) assert.ok(!html.includes(`href="${page}"`), `/shutdowns links ${page}`);
  });

  it("redirects the two expired OpenAI guides to /shutdowns, lists neither in a sitemap, and no page links them", async () => {
    for (const page of RETIRED_PAGES) {
      assert.ok(!routes.includes(page), `${page} is in a sitemap`);
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${base}${page}`, { method, redirect: "manual" });
        assert.strictEqual(response.status, 301, `${method} ${page}`);
        assert.strictEqual(response.headers.get("location"), "/shutdowns", `${method} ${page}`);
      }
    }
    assert.deepStrictEqual(found.linksToRetiredPages, []);
  });
});
