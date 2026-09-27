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

const STATED: Record<string, string[]> = {
  "/google-developer-program-2026": [
    "30 RPM; 1K requests and 200K tokens/day per model",
    "gpt-oss-120b, gpt-oss-20b, Qwen3.8 27B",
  ],
  "/gemini-api-pricing-2026": [
    "30 RPM; 1K requests and 200K tokens/day per model",
    "gpt-oss-120b, gpt-oss-20b, Qwen3.8 27B, Whisper",
    "$10/month in API credits",
    "includes $10 a month in free API credits",
  ],
  "/gemini-api-pricing-changes": [
    "30 RPM, 1K RPD",
    "200K/day per model",
    "30 RPM free with gpt-oss-120b and Qwen3.8 27B",
    "Mistral AI ($10 a month in free API credits)",
    "$10 a month in free API credits.",
  ],
  "/free-ai-stack": [
    "Ultra-fast inference on LPU hardware — 30 RPM, 1,000 requests and 200K tokens a day per model, free. Serves gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B. Best balance of speed, limits, and model quality for prototyping.",
  ],
  "/ai-ml-alternatives": [
    "offers blazing-fast gpt-oss-120b inference at 30 RPM free",
    "with gpt-oss-120b, 30 RPM free",
    "with $10 a month in free API credits",
    "$10 a month in free API credits across its models, including Large and Codestral.",
  ],
  "/free-llm-apis": [
    "delivers gpt-oss-120b at 30 RPM",
    "30 RPM free with gpt-oss-120b",
    "with $10 a month in free API credits",
    "(all models, with $10 a month in API credits)",
    "$10 a month in free API credits across all models, including Large and Codestral",
  ],
  "/llm-api-pricing": [
    "Groq's free plan allows 30 RPM, 1,000 requests and 200K tokens a day per model",
    "Groq gpt-oss-20b ($0.075/M input)",
    "Free plan: $10 a month in API credits.",
    "Mistral's Free plan includes $10 a month in API credits",
  ],
  "/groq-vs-hugging-face": [
    "Groq's free plan allows 30 RPM, 1,000 requests and 200K tokens a day per model.",
    "Groq serves a short list of open-weight models on its hardware; the free plan covers gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B.",
  ],
  "/groq-vs-mistral-ai": [
    "and its Free plan includes $10 a month in API credits",
    "Groq serves open-weight models (gpt-oss, Qwen) on its hardware.",
    "Mistral's Free plan includes $10 a month in API credits.",
    "Groq allows 200K tokens a day per model (about 6M a month) at 30 RPM",
    "want to use open-weight models such as gpt-oss",
  ],
  "/ai-free-tiers": [
    "Mistral includes $10 a month in API credits, and Google Antigravity has a free individual plan with weekly limits.",
    "Mistral's Free plan includes $10 a month in API credits.",
  ],
};

const PAGES = Object.keys(STATED);

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

  it("still states Groq's 30 RPM beside Groq, and Mistral's $10 credit beside Mistral", () => {
    for (const page of ["/free-llm-apis", "/gemini-api-pricing-2026"]) {
      assert.ok(unitsOf(served.get(page)!).some((unit) => /Groq/.test(unit) && /30 RPM/.test(unit)), page);
    }
    assert.ok(textOf(served.get("/llm-api-pricing")!).includes("gpt-oss-120b"));
    for (const page of ["/llm-api-pricing", "/free-llm-apis"]) {
      assert.ok(unitsOf(served.get(page)!).some((unit) => /Mistral/.test(unit) && /\$10/.test(unit)), page);
    }
  });
});
