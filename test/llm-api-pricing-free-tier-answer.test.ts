import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUESTION = "Which LLM API has the best free tier in 2026?";
type Offer = { vendor: string; tier: string; description: string };
type Catalogue = { offers: Offer[] };
const shipped: Catalogue = JSON.parse(readFileSync(path.join(ROOT, "data/index.json"), "utf8"));
const { classifyTier } = await import("../dist/ranking.js");
const { toSlug } = await import("../dist/slug.js");

function fixture(tiers: Record<string, string>, descriptions: Record<string, string> = {}): Catalogue {
  for (const vendor of Object.keys(tiers)) assert.equal(shipped.offers.filter(o => o.vendor === vendor).length, 1, vendor);
  return { ...shipped, offers: shipped.offers.map(o => ({
    ...o,
    tier: tiers[o.vendor] ?? "Paid",
    description: descriptions[o.vendor] ?? o.description,
  })) };
}

async function serve(catalogue: Catalogue): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-free-answer-"));
  const indexPath = path.join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify(catalogue));
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      child.stderr.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    });
    const response = await fetch(base + "/llm-api-pricing", { redirect: "error" });
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function readable(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function answers(html: string): { visible: string; structured: string } {
  const visible = [...html.matchAll(/<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)]
    .filter(m => readable(m[1]) === QUESTION).map(m => readable(m[2]));
  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => JSON.parse(m[1])).filter(block => block["@type"] === "FAQPage")
    .flatMap(block => block.mainEntity).filter(entry => entry.name === QUESTION).map(entry => entry.acceptedAnswer.text);
  assert.equal(visible.length, 1);
  assert.equal(structured.length, 1);
  return { visible: visible[0], structured: structured[0] };
}

function namesIn(html: string): string[] {
  const { visible } = answers(html);
  const list = visible.match(/(?:Other providers|Providers) on this page with an ongoing free tier: (.*)\.$/);
  return [...(visible.startsWith("Groq's free plan") ? ["Groq"] : []), ...(list ? list[1].split(", ") : [])];
}

describe("the LLM API free-tier answer follows its provider listings", () => {
  let current: string;
  let changed: string;
  let restored: string;
  let empty: string;
  let groqOnly: string;
  let missing: string;

  before(async () => {
    current = await serve(shipped);
    changed = await serve(fixture({
      OpenAI: "Free", "Anthropic API": "Community", "DeepSeek API": "Free", Baseten: "Free",
      Groq: "Retired", "Google Gemini API": "Paid", Cohere: "Trial", OpenRouter: "Free Trial",
      "Cloudflare Workers AI": "Retired Free", "Mistral AI": "Pay-as-you-go", "NVIDIA NIM": "Paid",
      SiliconFlow: "Free Credits", "LLM7.io": "Paid", "Ollama Cloud": "Paid",
      "Hugging Face": "Free",
    }));
    restored = await serve(fixture({ "Hugging Face": "Free", OpenRouter: "Free", Cohere: "Free" }, {
      "Hugging Face": "Free accounts get monthly Inference Providers API usage.",
      OpenRouter: "Free accounts get no included inference credits. Storage is free.",
    }));
    empty = await serve(fixture({}));
    groqOnly = await serve(fixture({ Groq: "Free" }));
    missing = await serve({ ...shipped, offers: shipped.offers.filter(o => !["Google Gemini API", "Groq"].includes(o.vendor)) });
  });

  it("names all current ongoing API tiers and excludes credits, trials and paid inference", () => {
    const table = current.match(/<table\b[^>]*data-figures="index"[^>]*>[\s\S]*?<\/table>/i)?.[0];
    assert.ok(table);
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(row => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1]))
      .filter(cells => cells.length > 0);
    assert.ok(rows.length > 0);
    const expected = rows.flatMap(cells => {
      const slug = cells[0].match(/href="\/vendor\/([^"#]+)"/)?.[1];
      assert.ok(slug);
      const records = shipped.offers.filter(o => toSlug(o.vendor) === slug);
      assert.equal(records.length, 1, slug);
      const record = records[0];
      return classifyTier(record.tier).class === "free" && !/retired|deprecated|discontinued|sunset|withdrawn/i.test(record.tier)
        && !record.description.toLowerCase().includes("no included inference providers credits")
        ? [readable(cells[0])] : [];
    });
    assert.deepEqual(new Set(namesIn(current)), new Set(expected));
  });

  it("adds newly free providers and drops retired, paid, trial and credit-only listings", () => {
    assert.deepEqual(namesIn(changed), ["OpenAI", "Anthropic", "Baseten", "DeepSeek"]);
    assert.ok(!answers(changed).visible.includes("Groq"));
  });

  it("follows inference-credit terms without a vendor exclusion", () => {
    assert.deepEqual(namesIn(restored), ["Cohere", "Hugging Face"]);
  });

  it("does not keep a provider whose listing is missing", () => {
    assert.ok(!namesIn(missing).includes("Google Gemini"));
    assert.ok(!namesIn(missing).includes("Groq"));
    assert.ok(namesIn(missing).includes("Mistral AI"));
  });

  it("keeps Groq's separate lead when it is the only ongoing free tier", () => {
    assert.deepEqual(namesIn(groqOnly), ["Groq"]);
    assert.ok(!answers(groqOnly).visible.includes("Other providers"));
  });

  it("states that none remain when every listing is paid", () => {
    assert.equal(answers(empty).visible, "No provider on this page currently lists an ongoing free API tier.");
  });

  it("removes the compile date when the numeric lead leaves the answer", () => {
    for (const html of [changed, restored, empty, missing]) assert.ok(!answers(html).structured.includes("Figures compiled"));
    assert.ok(answers(groqOnly).structured.includes("Figures compiled"));
  });

  it("carries the same answer in HTML and structured data, with only the existing figure provenance suffix", () => {
    for (const html of [current, changed, restored, empty, groqOnly, missing]) {
      const { visible, structured } = answers(html);
      assert.equal(structured.replace(/ Figures compiled \d{4}-\d{2}-\d{2}[^.]*\.$/, ""), visible);
    }
  });

  it("does not single out Mistral as the frontier free option", () => {
    for (const html of [current, changed, restored, empty, groqOnly, missing]) {
      for (const answer of Object.values(answers(html))) assert.ok(!answer.includes("For frontier models specifically"));
    }
  });
});
