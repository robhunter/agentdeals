import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const GROQ_RETIRED = /Llama 3\.3|Llama 3\.1|Llama 4|Llama, Mixtral|Mixtral|Gemma|Qwen3(?![.\d])|100K-500K|14\.4K RPD|3-15M/;
const MISTRAL_RETIRED = /1B tokens|1B tok|1 billion tokens|2 RPM|2\.8K RPD|Experiment tier/;

const TOKEN_VOLUME_QUESTION = "Need maximum free token volume?";
const TOKEN_VOLUME_ANSWER =
  "Groq — 200,000 tokens a day on each of its three free chat models, the largest renewing quota stated on this page. Cerebras's trial allows 1M tokens a day but only for 30 days and $5 of credits. Mistral and Gemini state no amount.";
const LISTED_FIGURES_QUOTED: Record<string, string[]> = {
  Groq: ["Free plan: gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B, each at", "200,000 tokens a day"],
  Cerebras: ["$5 in free credits", "expiring 30 days after they are granted", "1M tokens/day"],
};

const STATED: Record<string, string[]> = {
  "/google-developer-program-2026": [
    "30 RPM; 1K requests and 200K tokens/day per model",
    "gpt-oss-120b, gpt-oss-20b, Qwen3.8 27B",
    "Mistral Large 3, Medium 3.5, Small 4",
    "Mistral AI Free plan includes monthly API usage whose amount the pricing page has not stated since 2026-10-07 Mistral Large 3, Medium 3.5, Small 4",
  ],
  "/gemini-api-pricing-2026": [
    "Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
  ],
  "/free-ai-stack": [
    "Ultra-fast inference on LPU hardware — 30 RPM, 1,000 requests and 200K tokens a day per model, free. Serves gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B. Best balance of speed, limits, and model quality for prototyping.",
    "When you exceed 30 RPM or 200K tokens a day on a model. At that point, OpenRouter (25+ free models) extends the free runway.",
  ],
  "/ai-ml-alternatives": [
    "offers blazing-fast gpt-oss-120b inference at 30 RPM free",
    "with gpt-oss-120b, 30 RPM free",
    "Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
    "Mistral AI — Free plan includes monthly API usage whose amount the pricing page has not stated since 2026-10-07. API keys need no credit card.",
    "Mistral AI LLM API Free plan includes monthly API usage whose amount the pricing page has not stated since 2026-10-07 No",
  ],
  "/free-llm-apis": [
    "delivers gpt-oss-120b at 30 RPM",
    "30 RPM free with gpt-oss-120b",
    "Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
    "Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
  ],
  "/llm-api-pricing": [
    "Groq's free plan allows 30 RPM, 1,000 requests and 200K tokens a day per model",
    "Groq gpt-oss-20b ($0.075/M input)",
    "For frontier models specifically, Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
    "Mistral AI — Free plan includes monthly API usage whose amount the pricing page has not stated since 2026-10-07",
    "For open models, SiliconFlow's international site lists gpt-oss-120b at $0.05/$0.45 and DeepSeek-V4.1-Flash at $0.15/$0.60 (per 1M tokens).",
    "Open-weight inference is cheap: Groq's free plan allows 200K tokens a day on each of its free chat models.",
    "Opus-class prices fell from $15/$75 per M tokens (Opus 4.1) to $5/$25 in November 2025 and $4/$20 with Opus 5.5",
    "Groq's free plan offers gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B.",
  ],
  "/groq-vs-hugging-face": [
    "Groq's free plan allows 30 RPM, 1,000 requests and 200K tokens a day per model.",
    "Groq serves a short list of open-weight models on its hardware; the free plan covers gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B.",
  ],
  "/groq-vs-mistral-ai": [
    "Mistral AI offers its own proprietary models (Mistral Large, Codestral, Pixtral) and its Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
    "Groq serves open-weight models (gpt-oss, Qwen) on its hardware.",
    "Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
    "Groq allows 200K tokens a day per model (about 6M a month) at 30 RPM.",
    "want to use open-weight models such as gpt-oss",
    "Groq wins on speed; Mistral wins on model variety.",
    "(especially Codestral for code), or prefer European-based AI providers.",
  ],
  "/ai-free-tiers": [
    "Groq serves fast inference on a free plan, and Google Antigravity has a free individual plan with weekly limits.",
    "Mistral's Free plan includes monthly API usage; its pricing page listed $10 a month until 2026-10-07, then stopped stating the amount.",
  ],
};

const MISTRAL_CREDIT_AS_CURRENT = [
  "includes $10 a month in API credits",
  "$10 a month in API credits on the Free plan",
  "$10/month in API credits",
  "$10/mo in API credits",
  "$10/mo API credits",
];

const WITHDRAWN: Record<string, string[]> = {
  "/llm-api-pricing": [
    "Groq and SiliconFlow serve",
    "Groq and Cerebras give away",
    "Opus pricing 67% in 2026",
    "Frontier model pricing is in freefall",
    "5-10x cheaper",
    "Many apps work well with Llama 3.3 70B",
    ...MISTRAL_CREDIT_AS_CURRENT,
  ],
  "/free-ai-stack": ["Cerebras (1M tokens/day) or OpenRouter", "500K tokens/day"],
  "/openai-assistants-migration-2026": ["Meta Llama (via Groq)", "Via Llama models"],
  "/groq-vs-mistral-ai": ["free token volume", "higher throughput ceiling", "the largest free token allowance", ...MISTRAL_CREDIT_AS_CURRENT],
  "/google-developer-program-2026": ["Mixtral", ...MISTRAL_CREDIT_AS_CURRENT],
  "/gemini-api-pricing-2026": MISTRAL_CREDIT_AS_CURRENT,
  "/ai-ml-alternatives": MISTRAL_CREDIT_AS_CURRENT,
  "/free-llm-apis": MISTRAL_CREDIT_AS_CURRENT,
  "/ai-free-tiers": MISTRAL_CREDIT_AS_CURRENT,
};

const PAGES = Object.keys(STATED);
const SERVED_PAGES = [...new Set([...PAGES, ...Object.keys(WITHDRAWN)])];

interface StoredChange {
  vendor: string;
  summary?: string;
  previous_state?: string;
  current_state?: string;
  resolution?: { detail?: string } | null;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function recordedSentences(vendor: string): string[] {
  const changes: StoredChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
  return changes
    .filter((c) => c.vendor === vendor)
    .flatMap((c) => [c.summary, c.previous_state, c.current_state, c.resolution?.detail])
    .filter((t): t is string => Boolean(t))
    .flatMap(sentencesOf)
    .filter((s) => s.length >= 20);
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ");
}

function unitsOf(html: string): string[] {
  const units: string[] = [];
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const walk = (value: unknown): void => {
      if (typeof value === "string") units.push(...sentencesOf(value));
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    try {
      walk(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  const body = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/g, (_, row: string) =>
      "\n" + [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cell[1].replace(/<[^>]+>/g, " ").trim()).join(" | ") + "\n",
    )
    .replace(/<(?:p|li|dd|dt|h[1-6]|div|br)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, " ");
  for (const line of decode(body).split("\n")) units.push(...sentencesOf(line));
  return units;
}

function textOf(html: string): string {
  return decode(html.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

function entriesFor(html: string, question: string): string[] {
  return [...html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>([\s\S]*?)(?=<dt\b|<\/dl>)/g)]
    .filter(([, term]) => textOf(term).trim() === question)
    .map(([, , answers]) => answers);
}

function listedDescription(vendor: string): string {
  const offers: { vendor: string; description?: string }[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
  return offers.filter((offer) => offer.vendor === vendor).map((offer) => offer.description ?? "").join(" ");
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
  for (const page of SERVED_PAGES) {
    served.set(page, await (await fetch(`http://localhost:${port}${page}`)).text());
  }
});

after(() => { proc?.kill(); });

function claimsStillSold(vendorWord: RegExp, vendor: string, retired: RegExp): string[] {
  const recorded = recordedSentences(vendor);
  assert.ok(recorded.length > 0, `no change record for ${vendor} to set its history apart from its current terms`);
  const quotesARecord = (unit: string) => recorded.some((sentence) => unit.includes(sentence));
  return PAGES.flatMap((page) =>
    unitsOf(served.get(page)!)
      .filter((unit) => vendorWord.test(unit) && retired.test(unit) && !quotesARecord(unit))
      .map((unit) => `${page}: ${unit}`),
  );
}

describe("the AI guides state Groq's and Mistral's free plans as the vendors list them today", () => {
  it("sells none of Groq's retired free models or its old daily token range, outside Groq's own change records", () => {
    assert.deepStrictEqual(claimsStillSold(/Groq/, "Groq", GROQ_RETIRED), []);
  });

  it("sells none of Mistral's old Experiment tier allowance, outside Mistral's own change records", () => {
    assert.deepStrictEqual(claimsStillSold(/Mistral/, "Mistral AI", MISTRAL_RETIRED), []);
  });

  it("renders every replacement where it belongs", () => {
    const missing = PAGES.flatMap((page) =>
      STATED[page].filter((text) => !textOf(served.get(page)!).includes(text)).map((text) => `${page}: ${text}`),
    );
    assert.deepStrictEqual(missing, []);
  });

  it("prints none of the withdrawn lines, in the body or the structured data", () => {
    const left = Object.entries(WITHDRAWN).flatMap(([page, lines]) =>
      lines.filter((line) => textOf(served.get(page)!).includes(line)).map((line) => `${page}: ${line}`),
    );
    assert.deepStrictEqual(left, []);
  });

  it("still states Groq's 30 RPM beside Groq, and Mistral's monthly API usage beside Mistral", () => {
    for (const page of ["/free-llm-apis", "/gemini-api-pricing-2026"]) {
      assert.ok(unitsOf(served.get(page)!).some((unit) => /Groq/.test(unit) && /30 RPM/.test(unit)), page);
    }
    assert.ok(textOf(served.get("/llm-api-pricing")!).includes("gpt-oss-120b"));
    for (const page of ["/llm-api-pricing", "/free-llm-apis"]) {
      assert.ok(unitsOf(served.get(page)!).some((unit) => /Mistral/.test(unit) && /monthly API usage/.test(unit)), page);
    }
  });

  it("answers the free token volume question on /free-llm-apis with Groq's daily quota, and that answer never names Mistral AI", () => {
    const entries = entriesFor(served.get("/free-llm-apis")!, TOKEN_VOLUME_QUESTION);
    assert.strictEqual(entries.length, 1, `/free-llm-apis asks "${TOKEN_VOLUME_QUESTION}" ${entries.length} times`);
    const answers = [...entries[0].matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/g)].map(([, answer]) => answer);
    assert.deepStrictEqual(answers.map((answer) => textOf(answer).trim()), [TOKEN_VOLUME_ANSWER]);
    assert.ok(answers[0].trim().startsWith('<a href="/vendor/groq">Groq</a>'), answers[0]);
    assert.doesNotMatch(entries[0], /Mistral AI|\/vendor\/mistral-ai/);
  });

  it("quotes only figures that Groq's and Cerebras's own listings still state", () => {
    const missing = Object.entries(LISTED_FIGURES_QUOTED).flatMap(([vendor, figures]) =>
      figures.filter((figure) => !listedDescription(vendor).includes(figure)).map((figure) => `${vendor}: ${figure}`),
    );
    assert.deepStrictEqual(missing, [], `the "${TOKEN_VOLUME_QUESTION}" answer on /free-llm-apis quotes figures these listings no longer state`);
  });
});
