import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { readModelRates } = await import("../dist/model-rates.js");
const { lastReadDate } = await import("../dist/read-date.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGE = "/llm-api-pricing";
const LISTING = "Anthropic API";
const CLAUDE_PRICE = "How much does Claude cost per token?";
const PROVIDER_CHOICE = "Should I use a frontier lab API or an inference provider?";
const LAUNCHED = "Claude Zorblax 9";
const LAUNCHED_RATE = "$7/$31";
const UNPRICED_TERMS = "Claude API billed per million input and output tokens, by model. New users receive a small amount of free credits to test the API.";

type Offer = { vendor: string; description: string; url: string; verifiedDate?: string };
type Catalogue = { offers: Offer[] };
type Rate = { model: string | null; input: string; output: string | null };
type PricedRate = { model: string; input: string; output: string };

const shipped: Catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const shippedListing = shipped.offers.find((o) => o.vendor === LISTING)!;

function pricedRates(description: string): PricedRate[] {
  return (readModelRates(description) as Rate[]).filter((r): r is PricedRate => r.model !== null && r.output !== null);
}

const shippedRates = pricedRates(shippedListing.description);
const keptRates = shippedRates.slice(0, -1);
const droppedRate = shippedRates[shippedRates.length - 1];
const launchedTerms = "Claude API with usage-based pricing per million tokens (input/output). "
  + [`${LAUNCHED} ${LAUNCHED_RATE}`, ...keptRates.map((r) => `${r.model} ${r.input}/${r.output}`)].join(". ")
  + ". The Batch API gives a 50% discount on input and output tokens.";

function withListingTerms(description: string): Catalogue {
  return { ...shipped, offers: shipped.offers.map((o) => (o.vendor === LISTING ? { ...o, description } : o)) };
}

type ChangeLog = { changes: Array<Record<string, unknown>> };

const shippedChanges: ChangeLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));

const changesSupersedingTheListing: ChangeLog = {
  ...shippedChanges,
  changes: [
    ...shippedChanges.changes,
    {
      vendor: LISTING,
      change_type: "pricing_restructured",
      date: "2026-10-05",
      date_source: "discovered",
      summary: `Anthropic replaced its Claude lineup with ${LAUNCHED} at ${LAUNCHED_RATE} per million input/output tokens.`,
      previous_state: shippedListing.description,
      current_state: `Claude API with usage-based pricing per million tokens (input/output). ${LAUNCHED} ${LAUNCHED_RATE}.`,
      impact: "medium",
      source_url: shippedListing.url,
      category: "AI / ML",
      alternatives: [],
      recorded_date: "2026-10-05",
    },
  ],
};

type VerificationState = { records: Array<Record<string, unknown>> };

const EARLIER_VERIFIED = "2026-01-01";
const LATER_READ = "2026-01-02";

const listingVerifiedEarlier: Catalogue = {
  ...shipped,
  offers: shipped.offers.map((o) => (o.vendor === LISTING ? { ...o, verifiedDate: EARLIER_VERIFIED } : o)),
};

const shippedVerification: VerificationState = JSON.parse(readFileSync(path.join(REPO, "data", "verification_state.json"), "utf8"));

const verificationReadingTheListingLater: VerificationState = {
  ...shippedVerification,
  records: [
    ...shippedVerification.records.filter((r) => r.vendor !== LISTING),
    {
      vendor: LISTING,
      url: shippedListing.url,
      last_attempt_at: LATER_READ,
      last_outcome: null,
      consecutive_failures: 0,
      last_success: null,
      last_read_at: LATER_READ,
      quarantined_since: null,
    },
  ],
};

async function servePage(catalogue: Catalogue | null, changes: ChangeLog | null = null, verification: VerificationState | null = null): Promise<string> {
  const dir = catalogue || changes || verification ? mkdtempSync(path.join(tmpdir(), "llm-lineup-")) : null;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" };
  if (dir && catalogue) {
    const indexPath = path.join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify(catalogue));
    env.AGENTDEALS_INDEX_PATH = indexPath;
  }
  if (dir && changes) {
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify(changes));
    env.AGENTDEALS_CHANGES_PATH = changesPath;
  }
  if (dir && verification) {
    const verificationPath = path.join(dir, "verification_state.json");
    writeFileSync(verificationPath, JSON.stringify(verification));
    env.AGENTDEALS_VERIFICATION_STATE_PATH = verificationPath;
  }
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], { stdio: ["pipe", "pipe", "pipe"], env });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    return await (await fetch(`${base}${PAGE}`)).text();
  } finally {
    proc.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·",
};

function readable(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
}

function pageAnswer(html: string, question: string): string {
  for (const m of html.matchAll(/<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)) {
    if (readable(m[1]) === question) return readable(m[2]);
  }
  assert.fail(`${PAGE} prints no answer to "${question}"`);
}

function structuredAnswer(html: string, question: string): string {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const block = JSON.parse(m[1]);
    if (block["@type"] !== "FAQPage") continue;
    const entry = block.mainEntity.find((e: { name: string }) => e.name === question);
    if (entry) return entry.acceptedAnswer.text;
  }
  assert.fail(`${PAGE}'s structured FAQ does not answer "${question}"`);
}

function bothAnswers(html: string, question: string): Array<[string, string]> {
  return [["page", pageAnswer(html, question)], ["structured data", structuredAnswer(html, question)]];
}

function modelPattern(model: string): string {
  return model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![.\\d])";
}

function statedRate(answer: string, model: string): string | null {
  const amount = String.raw`(\$\d{1,3}(?:,\d{3})*(?:\.\d+)?)`;
  const m = new RegExp(`${modelPattern(model)} (?:costs|is) ${amount}(?:/M input and |/)${amount}`).exec(answer);
  return m ? `${m[1]}/${m[2]}` : null;
}

function claudeModelsNamed(answer: string): string[] {
  return [...answer.matchAll(/Claude [A-Z][a-z]+ \d+(?:\.\d+)?/g)].map((m) => m[0]);
}

function useCase(html: string, label: string): string {
  for (const m of html.matchAll(/<div class="verdict-item">\s*<strong>([\s\S]*?)<\/strong>\s*<p>([\s\S]*?)<\/p>/g)) {
    if (readable(m[1]) === label) return readable(m[2]);
  }
  assert.fail(`${PAGE} lists no "${label}" use case`);
}

function useCaseSection(html: string): string {
  const start = html.indexOf('<h2 id="recommendations">');
  const end = html.indexOf('<h2 id="faq">');
  assert.ok(start >= 0 && end > start, `${PAGE} has no use-case section before its FAQ`);
  return html.slice(start, end);
}

function boxContaining(html: string, className: string, text: string): string {
  const boxes = [...html.matchAll(new RegExp(`<div class="${className}">([\\s\\S]*?)</div>`, "g"))].map((m) => readable(m[1]));
  const box = boxes.find((b) => b.includes(text));
  assert.ok(box, `${PAGE} has no ${className} box saying "${text}"`);
  return box;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function rateCellOf(html: string, slug: string): string {
  const table = /<table class="pricing-table" data-figures="index">[\s\S]*?<\/table>/.exec(html);
  assert.ok(table, `${PAGE} has no pricing table`);
  for (const row of table[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells[0]?.includes(`href="/vendor/${slug}"`)) return readable(cells[2] ?? "");
  }
  assert.fail(`${PAGE}'s pricing table has no ${slug} row`);
}

let served = "";
let launched = "";
let unpriced = "";
let superseded = "";
let readLater = "";

before(async () => {
  assert.ok(shippedRates.length >= 2, `the ${LISTING} listing prices ${shippedRates.length} named models`);
  [served, launched, unpriced, superseded, readLater] = await Promise.all([
    servePage(null),
    servePage(withListingTerms(launchedTerms)),
    servePage(withListingTerms(UNPRICED_TERMS)),
    servePage(null, changesSupersedingTheListing),
    servePage(listingVerifiedEarlier, null, verificationReadingTheListingLater),
  ]);
});

describe("#2446 /llm-api-pricing answers what Claude costs from the Anthropic API listing", () => {
  it("names every model the listing prices, at the listing's figures, on the page and in the structured answer", () => {
    for (const [surface, answer] of bothAnswers(served, CLAUDE_PRICE)) {
      assert.deepStrictEqual(claudeModelsNamed(answer), shippedRates.map((r) => r.model), `${surface}: ${answer}`);
      for (const rate of shippedRates) {
        assert.strictEqual(statedRate(answer, rate.model), `${rate.input}/${rate.output}`, `${surface}: ${rate.model} in ${answer}`);
      }
    }
  });

  it("follows a model the listing adds and drops one it removes, with no change to the page", () => {
    for (const [surface, answer] of bothAnswers(launched, CLAUDE_PRICE)) {
      assert.deepStrictEqual(claudeModelsNamed(answer), [LAUNCHED, ...keptRates.map((r) => r.model)], `${surface}: ${answer}`);
      assert.strictEqual(statedRate(answer, LAUNCHED), LAUNCHED_RATE, `${surface}: ${answer}`);
      assert.ok(!new RegExp(modelPattern(droppedRate.model)).test(answer), `${surface} still prices ${droppedRate.model}: ${answer}`);
    }
  });

  it("dates the structured answer by the listing it reads, not by the page's compile date", () => {
    const answer = structuredAnswer(served, CLAUDE_PRICE);
    assert.ok(answer.endsWith(`Figures from our ${LISTING} record, last read ${lastReadDate(shippedListing)}.`), answer);
    assert.ok(!answer.includes("Figures compiled"), answer);
  });

  it("dates the structured answer by the day the listing was last read, not the day it was last verified", () => {
    const answer = structuredAnswer(readLater, CLAUDE_PRICE);
    assert.ok(answer.endsWith(`Figures from our ${LISTING} record, last read ${LATER_READ}.`), answer);
  });

  it("states no rate for Claude, and dates nothing to the listing, when the listing prices no model", () => {
    for (const [surface, answer] of bothAnswers(unpriced, CLAUDE_PRICE)) {
      assert.ok(!/\$\d/.test(answer), `${surface}: ${answer}`);
      assert.ok(!answer.includes("Figures from our"), `${surface}: ${answer}`);
      assert.ok(answer.includes(shippedListing.url), `${surface} does not say where Anthropic's rates are: ${answer}`);
    }
  });

  it("withholds the listing's rates from the answer wherever the pricing table withholds them", () => {
    assert.ok(/\$\d/.test(rateCellOf(served, "anthropic-api")), "the shipped table prints no Anthropic rate to compare against");
    assert.ok(!/\$\d/.test(rateCellOf(superseded, "anthropic-api")), "a change record superseding the listing left its rates in the table");
    for (const [surface, answer] of bothAnswers(superseded, CLAUDE_PRICE)) {
      assert.ok(!/\$\d/.test(answer), `${surface} prices Claude from terms a newer change record replaced: ${answer}`);
      assert.ok(!answer.includes("Figures from our"), `${surface}: ${answer}`);
    }
  });
});

describe("#2446 /llm-api-pricing's use cases, trend and gotchas name current models and prices", () => {
  it("files its use cases under By Use Case, in the heading and the contents, with no label claiming a best", () => {
    assert.strictEqual(readable(/<h2 id="recommendations">([\s\S]*?)<\/h2>/.exec(served)![1]), "By Use Case");
    assert.strictEqual(readable(/<a href="#recommendations">([\s\S]*?)<\/a>/.exec(served)![1]), "By Use Case");
    const labels = [...useCaseSection(served).matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) => readable(m[1]));
    assert.ok(labels.length >= 6, `only ${labels.length} use-case labels found`);
    assert.deepStrictEqual(labels.filter((label) => /^best\b/i.test(label)), []);
    assert.ok(!/best-for-use-case/i.test(readable(served)), "the page still calls the section best-for-use-case");
  });

  it("offers GPT-6 Sol, GPT-6.1 Sol and Claude Sonnet 5.5 for production chat at $2/$10, and Sonnet 5.5 for long context", () => {
    const chat = useCase(served, "Production chat / assistants");
    assert.ok(chat.startsWith("OpenAI GPT-6 Sol or GPT-6.1 Sol ($2/M in, $10/M out)"), chat);
    assert.ok(chat.includes("Claude Sonnet 5.5 ($2/$10/M)"), chat);
    assert.ok(chat.includes("GPT-5.6 Terra costs $2/$12"), chat);
    assert.ok(/Sonnet 5\.5/.test(useCase(served, "Long context (100K+ tokens)")));
  });

  it("states the price trend in figures, and not as a freefall", () => {
    const trend = boxContaining(served, "context-box", "The trend:");
    assert.ok(!/freefall/i.test(trend), trend);
    for (const figure of ["$15/$75", "$5/$25", "$4/$20", "$10/$50"]) assert.ok(trend.includes(figure), `${figure} missing from: ${trend}`);
  });

  it("bills reasoning tokens as output with no multiplier, and dates the o4-mini and o3-mini shutdown", () => {
    const card = boxContaining(served, "hidden-cost-card", "reasoning tokens");
    assert.ok(card.includes("billed as output tokens"), card);
    assert.ok(!/\d\s*x\b|multiplier/i.test(card), card);
    assert.ok(card.includes("o4-mini and o3-mini shut down in the OpenAI API on 2026-10-23"), card);
  });

  it("names Groq's current free models and no 5-10x saving in the provider question", () => {
    for (const [surface, answer] of bothAnswers(served, PROVIDER_CHOICE)) {
      assert.ok(!/\d\s*[-–]\s*\d+\s*x\b/i.test(answer), `${surface}: ${answer}`);
      assert.ok(answer.includes("Groq's free plan offers gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B."), `${surface}: ${answer}`);
      const llama = sentencesOf(answer).filter((s) => s.includes("Llama 3.3 70B"));
      assert.ok(llama.length > 0 && llama.every((s) => /\bleft\b|shut down|dropped/.test(s)), `${surface}: ${answer}`);
    }
  });
});
