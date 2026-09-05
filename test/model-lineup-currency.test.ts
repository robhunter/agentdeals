import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
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
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'",
  "&rsquo;": "'", "&lsquo;": "'", "&nbsp;": " ", "&middot;": "·",
  "&lt;": "<", "&gt;": ">",
};

function decode(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
}

function everySurface(html: string): string {
  const parts: string[] = [];
  parts.push(html.replace(/<head[\s\S]*?<\/head>/gi, " ").replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "));
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) parts.push(m[1]);
  return decode(parts.join(" "));
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => decode(c[1].replace(/<[^>]+>/g, " ")));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const SUPERSEDED_BY = new Map([
  ["Opus 4.6", "Opus 5"],
  ["Sonnet 4.6", "Sonnet 5"],
]);

const DATE_STATED = /\d{4}-\d{2}-\d{2}|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/;

const DATE_LOOKBACK = 320;

export function undatedMentions(text: string, name: string): string[] {
  const found: string[] = [];
  for (const hit of text.matchAll(new RegExp(name.replace(/\./g, "\\."), "g"))) {
    const around = text.slice(Math.max(0, hit.index! - DATE_LOOKBACK), hit.index! + name.length);
    if (DATE_STATED.test(around)) continue;
    found.push(text.slice(Math.max(0, hit.index! - 70), hit.index! + 80).trim());
  }
  return found;
}

let routes: string[] = [];
const bodies = new Map<string, string>();

async function body(route: string): Promise<string> {
  const held = bodies.get(route);
  if (held !== undefined) return held;
  const res = await fetch(`${base}${route}`, { redirect: "follow" });
  const html = await res.text();
  bodies.set(route, html);
  return html;
}

before(async () => {
  server = await startServer();
  const sitemap = await (await fetch(`${base}/sitemap-pages.xml`)).text();
  routes = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1].replace(/^https?:\/\/[^/]+/, ""))
    .filter(r => r.length > 0);
  assert.ok(routes.length > 400, `only enumerated ${routes.length} routes from the sitemap`);
});

after(() => { if (server) server.kill(); });

describe("#1362 a superseded Claude version is not published as the current one", () => {
  it("reads a claim that reaches a reader only through metadata or structured data", () => {
    const html = '<html><head><meta name="description" content="Opus 4.6 is the flagship">'
      + '<script type="application/ld+json">{"@type":"FAQPage","text":"Sonnet 4.6 costs $3/$15"}</script></head>'
      + "<body><p>Nothing about Claude here.</p></body></html>";
    const surfaces = everySurface(html);
    assert.ok(surfaces.includes("Opus 4.6"), "a claim made only in a meta description is not being read");
    assert.ok(surfaces.includes("Sonnet 4.6"), "a claim made only in JSON-LD is not being read");
  });

  it("flags a superseded version stated as current and passes one stated with its date", () => {
    const asCurrent = "Anthropic Claude API — Opus 4.6 at $5/$25 MTok. Best for complex agent workflows.";
    const asHistory = "Anthropic 2026-02-05 Limits Increased — Claude Opus 4.6 API pricing at $5/$25 per MTok, 67% below previous Opus pricing.";
    const filler = " Cerebras and Together both host open-weight models on a free tier with no credit card.".repeat(6);
    const farFromADate = "Groq raised its free rate limit on 2026-01-14." + filler + " " + asCurrent;
    assert.equal(undatedMentions(asCurrent, "Opus 4.6").length, 1, "a present-tense claim about a superseded version must be flagged");
    assert.deepEqual(undatedMentions(asHistory, "Opus 4.6"), [], "a change record carrying its own date must not be flagged");
    assert.equal(undatedMentions(farFromADate, "Opus 4.6").length, 1, "a date far up the page must not excuse a present-tense claim");
  });

  it("names a superseded Claude version only where a date is stated beside it, in text, metadata or JSON-LD", async () => {
    const undated: string[] = [];
    let inADatedContext = 0;
    for (const route of routes) {
      const surfaces = everySurface(await body(route));
      for (const old of SUPERSEDED_BY.keys()) {
        const mentions = [...surfaces.matchAll(new RegExp(old.replace(/\./g, "\\."), "g"))].length;
        const loose = undatedMentions(surfaces, old);
        inADatedContext += mentions - loose.length;
        for (const quote of loose) undated.push(`${route}: ${quote}`);
      }
    }
    assert.deepEqual(undated, [], undated.join(" | "));
    assert.ok(inADatedContext > 0, "no page names a superseded version at all, so this test asserts nothing");
  });

  it("publishes the current lineup at least as widely as the generation it replaced", async () => {
    const carrying = (name: string) => routes.filter(r => everySurface(bodies.get(r) ?? "").includes(name)).length;
    for (const [old, current] of SUPERSEDED_BY) {
      const behind = carrying(old);
      const ahead = carrying(current);
      assert.ok(ahead > 0, `${current} renders on no route at all`);
      assert.ok(ahead >= behind, `${current} renders on ${ahead} routes and ${old} on ${behind}`);
    }
  });

  it("publishes Anthropic's own price for Haiku 4.5 and never Haiku 3.5's", async () => {
    const wrong: string[] = [];
    for (const route of routes) {
      const surfaces = everySurface(await body(route));
      if (!surfaces.includes("Haiku")) continue;
      if (/\$0\.80\s*\/\s*\$4\b/.test(surfaces)) wrong.push(route);
    }
    assert.deepEqual(wrong, [], `Haiku 3.5's retired price is published beside a Haiku 4.5 claim on ${wrong.join(", ")}`);
  });

  it("names four Claude models on /llm-api-pricing at the prices Anthropic lists", async () => {
    const surfaces = everySurface(await body("/llm-api-pricing"));
    for (const [model, price] of [
      ["Fable 5.1", "$10/$50"],
      ["Opus 5", "$5/$25"],
      ["Sonnet 5", "$2/$10"],
      ["Haiku 4.5", "$1/$5"],
    ]) {
      assert.ok(surfaces.includes(`${model}: ${price} per MTok`), `no "${model}: ${price} per MTok" on /llm-api-pricing`);
    }
  });

  it("answers the Claude price question with the current lineup in the JSON-LD an assistant reads", async () => {
    const html = await body("/llm-api-pricing");
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)].map(m => JSON.parse(m[1]));
    const faq = blocks.find(b => b["@type"] === "FAQPage");
    assert.ok(faq, "/llm-api-pricing publishes no FAQPage structured data");
    const asked = faq.mainEntity.find((q: { name: string }) => /How much does Claude cost/i.test(q.name));
    assert.ok(asked, "the FAQ structured data does not answer what Claude costs");
    const answer = decode(asked.acceptedAnswer.text);
    for (const model of ["Fable 5.1", "Opus 5", "Sonnet 5", "Haiku 4.5"]) {
      assert.ok(answer.includes(model), `the structured answer never names ${model}`);
    }
    for (const old of SUPERSEDED_BY.keys()) {
      assert.ok(!answer.includes(old), `the structured answer still prices ${old} as what Claude costs`);
    }
  });

  it("does not restate a change record's prices under the wrong model names", async () => {
    const carriers: string[] = [];
    for (const route of routes) {
      if (/Opus is now \$10\/\$50/.test(everySurface(await body(route)))) carriers.push(route);
    }
    assert.deepEqual(carriers, [], `Anthropic prices Fable 5.1 at $10/$50, not Opus; carried on ${carriers.join(", ")}`);
  });
});

describe("#1362 the /llm-api-pricing frontier rows say when they were read", () => {
  const FRONTIER = new Map([
    ["OpenAI", "GPT-6 Astra"],
    ["Anthropic", "Claude Fable 5.1"],
    ["Google Gemini", "Gemini 3.8 Flash"],
    ["Mistral AI", "Mistral Medium 3.5"],
  ]);

  it("names each frontier provider's current flagship in the comparison table", async () => {
    const rows = tableRows(await body("/llm-api-pricing"));
    for (const [provider, flagship] of FRONTIER) {
      const row = rows.find(cells => cells[0] === provider);
      assert.ok(row, `no ${provider} row in the comparison table`);
      assert.equal(row![2], flagship, `${provider}'s flagship cell reads "${row![2]}"`);
    }
  });

  it("carries the read date and the page each frontier price was read from", async () => {
    const surfaces = everySurface(await body("/llm-api-pricing"));
    const dated = surfaces.match(/Frontier prices read from each vendor's own pricing page on (\d{4}-\d{2}-\d{2}): (.*?)\. The other/);
    assert.ok(dated, "the pricing table states no date on which its frontier prices were read");
    for (const host of [
      "developers.openai.com/api/docs/pricing",
      "platform.claude.com/docs/en/about-claude/pricing",
      "ai.google.dev/gemini-api/docs/pricing",
      "docs.mistral.ai/inference/pricing",
    ]) {
      assert.ok(dated![2].includes(host), `the read line does not name ${host}`);
    }
  });

  it("cannot claim a read date from before the page existed", async () => {
    const surfaces = everySurface(await body("/llm-api-pricing"));
    const readOn = surfaces.match(/own pricing page on (\d{4}-\d{2}-\d{2})/);
    const published = surfaces.match(/Published (\d{4}-\d{2}-\d{2})/);
    assert.ok(readOn, "the pricing table states no read date");
    assert.ok(published, "the page states no publication date");
    assert.ok(
      readOn![1] >= published![1],
      `the table says its prices were read on ${readOn![1]}, before the page was published on ${published![1]}`
    );
  });

  it("counts the rows it did not read, so adding one without a read date fails", async () => {
    const html = await body("/llm-api-pricing");
    const surfaces = everySurface(html);
    const stated = surfaces.match(/The other (\d+) rows carry no read date\./);
    assert.ok(stated, "the pricing table does not say how many of its rows carry no read date");
    const rows = tableRows(html);
    const header = rows.find(cells => cells[0] === "Provider");
    assert.ok(header, "no header row in the comparison table");
    const priced = rows.filter(cells => cells.length === header!.length && cells[0] !== "Provider");
    assert.equal(
      Number(stated![1]),
      priced.length - FRONTIER.size,
      `the table holds ${priced.length} rows and ${FRONTIER.size} were read, so ${priced.length - FRONTIER.size} carry no read date`
    );
  });

  it("no longer dates the whole table to a month that has passed", async () => {
    const surfaces = everySurface(await body("/llm-api-pricing"));
    assert.ok(!surfaces.includes("All prices verified as of April 2026"), "the table still claims every price was verified in April 2026");
    assert.ok(!surfaces.includes("LLM API pricing in April 2026"), "the summary still dates itself to April 2026");
  });
});
