import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readModelRates, cheapestRate, vendorRates } from "../dist/model-rates.js";
import { offerRetired } from "../dist/retirement.js";
import { toSlug } from "../dist/slug.js";
import { classifyTier } from "../dist/ranking.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const PAGES = ["/openai-assistants-alternatives", "/openai-assistants-migration-2026"];

const COMPARED_SLUGS = [
  "openai", "anthropic-api", "google-gemini-api", "github-models", "openrouter",
  "cohere", "groq", "fireworks-ai", "together-ai", "mistral-ai", "deepseek-api", "cerebras",
];

interface IndexedOffer {
  vendor: string;
  tier: string;
  description: string;
  url: string;
}

const offers: IndexedOffer[] = JSON.parse(
  readFileSync(path.join(root, "data", "index.json"), "utf8"),
).offers;

function recordFor(slug: string): IndexedOffer {
  const matches = offers.filter(o => toSlug(o.vendor) === slug);
  assert.equal(matches.length, 1, `${slug} resolves to exactly one record`);
  return matches[0];
}

let server: ChildProcess;
let base = "";
const html = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(root, "dist", "serve.js")], {
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
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&rarr;": "→", "&times;": "×",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, e => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
}

function readableText(source: string): string {
  return decode(source.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "));
}

function indexBackedTables(page: string): string[] {
  return [...(html.get(page) ?? "").matchAll(/<table\b[^>]*data-figures="index"[^>]*>[\s\S]*?<\/table>/gi)].map(m => m[0]);
}

function rowFor(page: string, vendorName: string): string {
  const rows = [...(html.get(page) ?? "").matchAll(/<tr>[\s\S]*?<\/tr>/gi)].map(m => m[0]);
  const match = rows.find(r => readableText(r).includes(vendorName));
  assert.ok(match, `${page} has a table row for ${vendorName}`);
  return match!;
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `src/serve.ts declares ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} has a body`);
  return source.slice(start, end);
}

function ratePairsIn(text: string): string[] {
  return [...text.matchAll(/\$\d[\d.,]*\s*\/\s*\$\d[\d.,]*/g)].map(m => m[0].replace(/\s+/g, ""));
}

function indexedRatePairs(): Set<string> {
  const pairs = new Set<string>();
  for (const offer of offers) {
    for (const rate of readModelRates(offer.description)) {
      if (rate.output !== null) pairs.add(`${rate.input}/${rate.output}`);
    }
  }
  return pairs;
}

describe("AI provider tables on the Assistants API pages", () => {
  before(async () => {
    server = await startServer();
    for (const page of PAGES) {
      const res = await fetch(`${base}${page}`);
      assert.equal(res.status, 200, `${page} responds 200`);
      html.set(page, await res.text());
    }
  });

  after(() => {
    server?.kill();
  });

  it("states each provider's free tier as the index records it", () => {
    for (const page of PAGES) {
      for (const slug of COMPARED_SLUGS) {
        const record = recordFor(slug);
        const row = [...(html.get(page) ?? "").matchAll(/<tr>[\s\S]*?<\/tr>/gi)]
          .map(m => m[0])
          .find(r => r.includes(`/vendor/${slug}"`));
        if (!row) continue;
        assert.ok(
          readableText(row).includes(record.tier),
          `${page} row for ${record.vendor} states the recorded tier "${record.tier}"`,
        );
      }
    }
  });

  it("does not offer a retired tier as available, or rate it stable", () => {
    const retiredSlugs = COMPARED_SLUGS.filter(slug => offerRetired(recordFor(slug)));
    assert.ok(retiredSlugs.length > 0, "at least one compared provider is recorded as retired");
    for (const page of PAGES) {
      for (const slug of retiredSlugs) {
        const record = recordFor(slug);
        const pageHtml = html.get(page) ?? "";
        if (!pageHtml.includes(`/vendor/${slug}"`)) continue;
        const row = rowFor(page, record.vendor);
        const rowText = readableText(row);
        assert.ok(rowText.includes(record.tier), `${page} row for ${record.vendor} states "${record.tier}"`);
        assert.ok(!/\bstable\b/i.test(rowText), `${page} row for ${record.vendor} carries no stability rating`);
        assert.ok(
          !/\bfree\b/i.test(rowText),
          `${page} row for ${record.vendor} does not call the ended offer free`,
        );
      }
    }
  });

  it("prices every index-backed table cell at a rate a record carries", () => {
    const known = indexedRatePairs();
    assert.ok(known.size > 0, "the index carries at least one model rate");
    let checked = 0;
    for (const page of PAGES) {
      const tables = indexBackedTables(page);
      assert.ok(tables.length > 0, `${page} marks its index-backed tables`);
      for (const table of tables) {
        for (const pair of ratePairsIn(readableText(table))) {
          checked++;
          assert.ok(known.has(pair), `${page} prices a row at ${pair}, which no record carries`);
        }
      }
    }
    assert.ok(checked > 0, "at least one rate pair is rendered from the index");
  });

  it("keeps token rates out of the page source", () => {
    const source = readFileSync(path.join(root, "src", "serve.ts"), "utf8");
    for (const builder of ["buildOpenaiAssistantsAlternativesPage", "buildOpenaiAssistantsMigration2026Page"]) {
      const pairs = ratePairsIn(functionBody(source, builder));
      assert.deepEqual(pairs, [], `${builder} states no token rate of its own`);
    }
  });

  it("counts a provider among the free tiers only while the record still offers one", () => {
    const startable = COMPARED_SLUGS.filter(slug => {
      const tierClass = classifyTier(recordFor(slug).tier).class;
      return tierClass === "free" || tierClass === "time_limited";
    });
    assert.ok(startable.length < COMPARED_SLUGS.length, "not every compared provider offers a free or trial tier");
    const page = html.get("/openai-assistants-alternatives") ?? "";
    const counted = page.match(/<div class="stat-number green">(\d+)<\/div>/);
    assert.ok(counted, "the page publishes a count of free or trial tiers");
    assert.equal(Number(counted![1]), startable.length);
  });

  it("names the model the record names when it quotes that model's rate", () => {
    const cheapest = cheapestRate(vendorRates("deepseek-api"));
    assert.ok(cheapest?.model, "the DeepSeek record names a model with a rate");
    for (const page of PAGES) {
      const text = readableText(html.get(page) ?? "");
      assert.ok(
        text.includes(cheapest!.model!),
        `${page} names ${cheapest!.model} where it quotes that provider's rate`,
      );
    }
  });
});
