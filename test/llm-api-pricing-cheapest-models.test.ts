import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { readModelRates } = await import("../dist/model-rates.js");
const { lastReadDate } = await import("../dist/read-date.js");
const { toSlug } = await import("../dist/slug.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGE = "/llm-api-pricing";
const QUESTION = "What is the cheapest LLM API for production use?";
const LEAD = /^The cheapest models? on this page (?:are|is) /;
const DEEPSEEK = "DeepSeek API";
const FREE_TIER_SENTENCES = ["Groq offers free tiers", "Gemini Flash models are free"];

type Offer = { vendor: string; description: string; url: string; verifiedDate: string };
type Catalogue = { offers: Offer[] };
type Rate = { model: string | null; input: string; output: string | null };
type PageModel = { label: string; input: number; output: number };
type PricedModel = PageModel & { vendorSlug: string };

const shipped: Catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));

function withDescription(vendor: string, rewrite: (description: string) => string): Catalogue {
  assert.ok(shipped.offers.some((o) => o.vendor === vendor), `the catalogue has no ${vendor} listing`);
  return { ...shipped, offers: shipped.offers.map((o) => (o.vendor === vendor ? { ...o, description: rewrite(o.description) } : o)) };
}

function replacing(from: string, to: string): (description: string) => string {
  return (description) => {
    assert.ok(description.includes(from), `the listing no longer says "${from}"`);
    return description.replace(from, to);
  };
}

async function servePage(catalogue: Catalogue | null): Promise<string> {
  const dir = catalogue ? mkdtempSync(path.join(tmpdir(), "llm-cheapest-")) : null;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" };
  if (dir && catalogue) {
    const indexPath = path.join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify(catalogue));
    env.AGENTDEALS_INDEX_PATH = indexPath;
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

function pageAnswer(html: string): string {
  for (const m of html.matchAll(/<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)) {
    if (readable(m[1]) === QUESTION) return readable(m[2]);
  }
  assert.fail(`${PAGE} prints no answer to "${QUESTION}"`);
}

function structuredAnswer(html: string): string {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const block = JSON.parse(m[1]);
    if (block["@type"] !== "FAQPage") continue;
    const entry = block.mainEntity.find((e: { name: string }) => e.name === QUESTION);
    if (entry) return entry.acceptedAnswer.text;
  }
  assert.fail(`${PAGE}'s structured FAQ does not answer "${QUESTION}"`);
}

function dollars(amount: string): number {
  return Number(amount.replace(/[$,]/g, ""));
}

function modelsOnThePage(html: string): PricedModel[] {
  const models: PricedModel[] = [];
  for (const card of html.matchAll(/<div class="diff-card"[^>]*>\s*<h3>(<a [^>]*href="\/vendor\/([^"]+)"[^>]*>[\s\S]*?<\/a>)[\s\S]*?<\/h3>\s*<p class="diff-desc">([\s\S]*?)<\/p>/g)) {
    const provider = readable(card[1]);
    for (const rate of readModelRates(readable(card[3])) as Rate[]) {
      if (rate.model === null || rate.output === null) continue;
      models.push({ label: `${provider} ${rate.model}`, input: dollars(rate.input), output: dollars(rate.output), vendorSlug: card[2] });
    }
  }
  return models;
}

function recordsClauseFor(page: string, catalogue: Catalogue): string {
  const onThePage = modelsOnThePage(page);
  const named = namedAsCheapest(pageAnswer(page)).map((m) => onThePage.find((p) => p.label === m.label)!.vendorSlug);
  const deepseekSentence = /at peak hours; half that off-peak\./.test(pageAnswer(page)) ? [toSlug(DEEPSEEK)] : [];
  const offers = [...new Set([...named, ...deepseekSentence])].map((slug) => {
    const offer = catalogue.offers.find((o) => toSlug(o.vendor) === slug);
    assert.ok(offer, `no catalogue listing answers to /vendor/${slug}`);
    return offer;
  });
  const names = offers.map((o) => o.vendor);
  const read = offers.map((o) => lastReadDate(o)).filter((d: string) => d !== "").sort();
  const span = read.length === 0 ? "" : read[0] === read[read.length - 1] ? `, last read ${read[0]}` : `, last read ${read[0]} to ${read[read.length - 1]}`;
  return `Figures from our ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} records${span}.`;
}

function namedAsCheapest(answer: string): PageModel[] {
  const first = answer.split(/(?<=\.)\s+(?=[A-Z])/)[0];
  assert.match(first, LEAD, `the answer does not open by naming the cheapest models: ${answer}`);
  const list = first.replace(LEAD, "").replace(/\.$/, "");
  return [...list.matchAll(/(?:^|, and |, | and )(.+?) \((\$[\d.,]+) input, (\$[\d.,]+) output\)/g)]
    .map((m) => ({ label: m[1], input: dollars(m[2]), output: dollars(m[3]) }));
}

function cheaperOnBoth(a: PageModel, b: PageModel): boolean {
  return a.input < b.input && a.output < b.output;
}

function sortsBefore(a: PageModel, b: PageModel): boolean {
  return a.input < b.input || (a.input === b.input && a.output < b.output);
}

function deepseekCheapest(catalogue: Catalogue): Rate {
  const deepseek = catalogue.offers.find((o) => o.vendor === DEEPSEEK);
  assert.ok(deepseek, `the catalogue has no ${DEEPSEEK} listing`);
  const rates = (readModelRates(deepseek.description) as Rate[]).filter((r) => r.model !== null && r.output !== null);
  assert.ok(rates.length > 0, `the ${DEEPSEEK} listing prices no model`);
  return rates.sort((a, b) => dollars(a.input) - dollars(b.input))[0];
}

function labels(models: PageModel[]): string[] {
  return models.map((m) => m.label);
}

let shippedPage = "";
let cheaperModelPage = "";
let tiedPage = "";
let deepseekAmongThemPage = "";
let deepseekRepricedPage = "";
let deepseekRenamedPage = "";
let deepseekUnpricedPage = "";

const cheaperModelCatalogue = withDescription("Groq", replacing("gpt-oss-20b $0.075/$0.30.", "gpt-oss-20b $0.075/$0.30; gpt-oss-1b $0.01/$0.02."));
const deepseekAmongThemCatalogue = withDescription(DEEPSEEK, replacing("$0.30/M input, $1.20/M output at peak", "$0.01/M input, $0.02/M output at peak"));

before(async () => {
  [shippedPage, cheaperModelPage, tiedPage, deepseekAmongThemPage, deepseekRepricedPage, deepseekRenamedPage, deepseekUnpricedPage] = await Promise.all([
    servePage(null),
    servePage(cheaperModelCatalogue),
    servePage(withDescription("OpenAI", (description) => {
      const luna = (readModelRates(description) as Rate[]).find((r) => r.model === "gpt-6-luna");
      assert.ok(luna && luna.output, "the OpenAI listing no longer prices gpt-6-luna");
      return replacing(`${luna.input}/${luna.output}`, "$0.0375/$0.15")(description);
    })),
    servePage(deepseekAmongThemCatalogue),
    servePage(withDescription(DEEPSEEK, replacing("$0.30/M input, $1.20/M output at peak", "$0.28/M input, $1.12/M output at peak"))),
    servePage(withDescription(DEEPSEEK, (description) => replacing(`${deepseekCheapest(shipped).model} (`, "DeepSeek-V9-Flash (")(description))),
    servePage(withDescription(DEEPSEEK, (description) => description.replace(/\/M (input|output)/g, " per million $1 tokens"))),
  ]);
});

describe("/llm-api-pricing's answer to which LLM API is cheapest for production", () => {
  it("names the four models the page prices lowest, by input price and then output price, each at its listed prices", () => {
    const onThePage = modelsOnThePage(shippedPage);
    const named = namedAsCheapest(pageAnswer(shippedPage));
    assert.strictEqual(named.length, 4, `the answer names ${named.length} models`);
    for (const model of named) {
      const listed = onThePage.find((m) => m.label === model.label);
      assert.ok(listed, `${model.label} is not a model the page prices`);
      assert.deepStrictEqual(model, { label: listed.label, input: listed.input, output: listed.output });
    }
    for (let i = 1; i < named.length; i++) {
      assert.ok(!sortsBefore(named[i], named[i - 1]), `${named[i].label} is named after ${named[i - 1].label} but costs less`);
    }
    const left = onThePage.filter((m) => !labels(named).includes(m.label));
    for (const model of named) {
      const before = left.find((m) => sortsBefore(m, model));
      assert.strictEqual(before, undefined, `${before?.label} costs less than ${model.label}, which the answer names instead`);
    }
  });

  it("names no model while one it leaves out costs less for both input and output", () => {
    const onThePage = modelsOnThePage(shippedPage);
    const named = namedAsCheapest(pageAnswer(shippedPage));
    const left = onThePage.filter((m) => !labels(named).includes(m.label));
    for (const model of named) {
      const cheaper = left.find((m) => cheaperOnBoth(m, model));
      assert.strictEqual(cheaper, undefined, `${cheaper?.label} costs less than ${model.label} for both input and output`);
    }
  });

  it("leads with a model once its listing prices it below every other", () => {
    const named = namedAsCheapest(pageAnswer(cheaperModelPage));
    assert.deepStrictEqual(named[0], { label: "Groq gpt-oss-1b", input: 0.01, output: 0.02 });
    assert.strictEqual(named.length, 4);
    assert.deepStrictEqual(labels(named).slice(1), labels(namedAsCheapest(pageAnswer(shippedPage))).slice(0, 3));
  });

  it("orders two models priced alike as the page orders their providers", () => {
    const named = labels(namedAsCheapest(pageAnswer(tiedPage)));
    assert.deepStrictEqual(named.slice(0, 2), ["OpenAI gpt-6-luna", "Cohere Command R7B"]);
  });

  it("gives the peak prices of DeepSeek's cheapest model from DeepSeek's listing, under the listing's name for it, and says off-peak is half", () => {
    const deepseek = shipped.offers.find((o) => o.vendor === DEEPSEEK)!;
    const flash = deepseekCheapest(shipped);
    assert.ok(deepseek.description.includes(`${flash.model} (deepseek-flash)`), `the ${DEEPSEEK} listing no longer names ${flash.model} deepseek-flash`);
    assert.ok(deepseek.description.includes("Off-peak rates are half"), `the ${DEEPSEEK} listing no longer says off-peak rates are half`);
    const stated = /DeepSeek (\S+) costs (\$[\d.,]+) input, (\$[\d.,]+) output at peak hours; half that off-peak\./.exec(pageAnswer(shippedPage));
    assert.ok(stated, pageAnswer(shippedPage));
    assert.deepStrictEqual([stated[1], dollars(stated[2]), dollars(stated[3])], [flash.model, dollars(flash.input), dollars(flash.output)]);
  });

  it("follows DeepSeek's listing when its cheapest model's peak prices change", () => {
    const answer = pageAnswer(deepseekRepricedPage);
    assert.ok(answer.includes(`DeepSeek ${deepseekCheapest(shipped).model} costs $0.28 input, $1.12 output at peak hours; half that off-peak.`), answer);
  });

  it("names the model DeepSeek's listing prices, so a renamed model is named as the listing names it", () => {
    const answer = pageAnswer(deepseekRenamedPage);
    assert.ok(answer.includes("DeepSeek DeepSeek-V9-Flash costs $0.30 input, $1.20 output at peak hours; half that off-peak."), answer);
    assert.ok(!answer.includes(`${deepseekCheapest(shipped).model} costs`), answer);
  });

  it("names DeepSeek's cheapest model once when it is among the cheapest", () => {
    const answer = pageAnswer(deepseekAmongThemPage);
    assert.ok(labels(namedAsCheapest(answer)).includes(`DeepSeek ${deepseekCheapest(shipped).model}`), answer);
    assert.ok(!/at peak hours; half that off-peak/.test(answer), answer);
  });

  it("ends its structured answer with the records of the models it names, in the order it names them, DeepSeek's last when its sentence prints", () => {
    const cases: Array<[string, Catalogue]> = [[shippedPage, shipped], [cheaperModelPage, cheaperModelCatalogue], [deepseekAmongThemPage, deepseekAmongThemCatalogue]];
    for (const [page, catalogue] of cases) {
      const expected = recordsClauseFor(page, catalogue);
      assert.ok(structuredAnswer(page).endsWith(` ${expected}`), `${structuredAnswer(page)}\nexpected it to end: ${expected}`);
    }
    assert.match(recordsClauseFor(shippedPage, shipped), /^Figures from our .+ and DeepSeek API records/);
    assert.match(recordsClauseFor(deepseekAmongThemPage, deepseekAmongThemCatalogue), /^Figures from our DeepSeek API, /);
    assert.match(recordsClauseFor(cheaperModelPage, cheaperModelCatalogue), /^Figures from our Groq, (?!.*Groq)/);
  });

  it("names neither DeepSeek's model nor its record when DeepSeek's listing prices no model", () => {
    const answer = structuredAnswer(deepseekUnpricedPage);
    assert.ok(!/DeepSeek/.test(answer), answer);
    assert.match(answer, /Figures from our .+ records, last read /);
  });

  it("ends by saying the prices are list prices per million tokens, with no claim about free tiers", () => {
    const answer = pageAnswer(shippedPage);
    assert.ok(answer.endsWith("These are list prices per million tokens."), answer);
    for (const sentence of FREE_TIER_SENTENCES) assert.ok(!answer.includes(sentence), answer);
  });

  it("prints every price in dollars and cents and puts a comma before the last model's and", () => {
    const answer = pageAnswer(shippedPage);
    assert.doesNotMatch(answer, /\$\d[\d,]*(?:\.\d)?(?![\d.])/);
    assert.match(answer.split(/(?<=\.)\s+(?=[A-Z])/)[0], /\), and [^,()]+ \(\$[\d.,]+ input, \$[\d.,]+ output\)\.$/);
  });

  it("answers the same in the page and in its structured data", () => {
    for (const page of [shippedPage, cheaperModelPage, tiedPage]) {
      assert.ok(structuredAnswer(page).startsWith(pageAnswer(page)), structuredAnswer(page));
    }
  });
});
