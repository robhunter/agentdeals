import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STATED: Record<string, string[]> = {
  "/ai-ml-alternatives": [
    "Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
    "Mistral AI — Free plan includes monthly API usage whose amount the pricing page has not stated since 2026-10-07. API keys need no credit card.",
    "Kaggle — a weekly quota of 30 GPU hours (one P100 or two T4s) and up to 20 TPU hours, at no charge.",
    "Qdrant — a free single-node cluster (0.5 vCPU, 1 GB RAM, 4 GB disk) for testing, suspended after a week unused.",
  ],
  "/free-llm-apis": [
    "Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount. OpenRouter aggregates",
    "Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount. OpenRouter gives one API key",
    "Mistral AI — Free plan includes monthly API usage whose amount the pricing page has not stated since 2026-10-07. API keys need no credit card.",
    "Cloudflare Workers AI — 10,000 Neurons a day at no charge on every account; on the Workers Free plan, requests beyond that fail until the daily reset at 00:00 UTC. Some models, including Kimi K2.6 and GLM-5.3, need the Workers Paid plan or prepaid AI Gateway credits.",
    "Ollama — open source (MIT) and free to run on your own machine; its cloud models are paid with usage credits, and the Free plan includes starter credits.",
  ],
  "/free-ai-stack": [
    "Qdrant Cloud's free cluster (1 GB RAM, 4 GB disk) is an alternative; Qdrant suspends it after a week without use.",
    "A weekly quota of 30 GPU hours (one P100 or two T4s) and up to 20 TPU hours, at no charge.",
    "When you need longer sessions (Kaggle caps them at 12 hours on CPU or GPU and 9 on TPU),",
    "When you need more than the 10 monthly credits. Labelbox offers 500 LBUs/month.",
  ],
  "/llm-api-pricing": [
    "For open models, SiliconFlow's international site lists gpt-oss-120b at $0.05/$0.45 and DeepSeek-V4.1-Flash at $0.15/$0.60 (per 1M tokens).",
  ],
  "/openai-assistants-alternatives": [
    "carry no per-token price in our index, so what you pay above the free tier is on the vendor's own page.",
  ],
};

const DESCRIBED: Record<string, string[]> = {
  "/cursor-alternatives": ["Compare AI coding alternatives and their free tiers: GitHub Copilot,", "beside paid Claude Code."],
};

const WITHDRAWN = [
  "including Large and Codestral",
  "broadest model access",
  "Best free access to frontier-class models",
  "hrs/week GPU (Tesla T4)",
  "free forever cluster",
  "10,000 neurons/day free",
  "runs at the edge with no cold starts",
  "1 concurrent model free",
  "entirely free. No credit card needed.",
  "Kaggle limits to 9 hrs",
  "1,000 annotation units free",
  "SiliconFlow serves Llama",
  "Compare free AI coding alternatives",
  "carry no paid rate in our index",
  "rate-limited free access only",
  "includes $10 a month in API credits",
  "$10 a month in API credits on the Free plan",
];

const PAGES = [...new Set([...Object.keys(STATED), ...Object.keys(DESCRIBED)])];

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·", "&rarr;": "→",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function readable(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function stackCategory(html: string, id: string): string {
  const start = html.indexOf(`<div class="stack-category" id="${id}">`);
  assert.ok(start >= 0, `${id} renders`);
  const next = html.indexOf('<div class="stack-category"', start + 1);
  return readable(html.slice(start, next > start ? next : undefined));
}

function descriptions(html: string): string[] {
  return [...html.matchAll(/<meta (?:name|property)="(?:description|og:description|twitter:description)" content="([^"]*)"/g)].map((m) => decode(m[1]));
}

let proc: ChildProcess | null = null;
const served = new Map<string, string>();

before(async () => {
  const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  proc = child;
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
    });
  });
  for (const page of PAGES) {
    const response = await fetch(`http://localhost:${port}${page}`);
    assert.strictEqual(response.status, 200, page);
    served.set(page, await response.text());
  }
});

after(() => { proc?.kill(); });

describe("the AI guides state Mistral, Qdrant, Kaggle, Workers AI, Ollama, SiliconFlow and Scale AI as the vendors list them", () => {
  it("renders each replacement line on its page", () => {
    const missing = Object.entries(STATED).flatMap(([page, lines]) =>
      lines.filter((line) => !readable(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(missing, []);
  });

  it("describes /cursor-alternatives without offering Claude Code as a free alternative", () => {
    for (const [page, parts] of Object.entries(DESCRIBED)) {
      const found = descriptions(served.get(page)!);
      assert.strictEqual(found.length, 2, `${page} carries a description and an og:description`);
      for (const description of found) {
        for (const part of parts) assert.ok(description.includes(part), `${page}: ${description}`);
      }
    }
  });

  it("prints none of the withdrawn claims in the body, the descriptions or the structured data", () => {
    const left = PAGES.flatMap((page) => {
      const html = served.get(page)!;
      const surfaces = [readable(html), decode(html)];
      return WITHDRAWN.filter((claim) => surfaces.some((text) => text.includes(claim))).map((claim) => `${page}: ${claim}`);
    });
    assert.deepStrictEqual(left, []);
  });

  it("no longer offers Scale AI beside the data labeling pick on /free-ai-stack", () => {
    const section = stackCategory(served.get("/free-ai-stack")!, "data-labeling-annotation");
    assert.ok(section.includes("Data Labeling & Annotation"), section.slice(0, 200));
    assert.ok(!section.includes("Scale AI"), section);
  });
});
