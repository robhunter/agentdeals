import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGE = "/startup-credits";
const CLAUDE = "Claude Startups (Anthropic)";
const OPENAI = "OpenAI for Startups";
const KIRO = "Amazon Kiro (AWS Startups)";

const { guideBlurb } = await import("../dist/guide-blurbs.js");

const PROGRAMME_COUNTS: Record<string, Array<[RegExp, number]>> = {
  [PAGE]: [
    [/<meta name="description" content="Compare (\d+) startup programs: /g, 1],
    [/<meta property="og:description" content="Compare (\d+) startup programs: /g, 1],
    [/"description":"Compare (\d+) startup programs: /g, 1],
    [/<p class="page-claim">Compare (\d+) startup programs: /g, 1],
  ],
  "/state-of-free-tiers": [
    [/<a href="\/startup-credits">startup credits directory<\/a> for (\d+) programs\./g, 1],
    [/<a href="\/startup-credits">Startup Credits Directory<\/a> <span[^>]*>&mdash; (\d+) programs<\/span>/g, 1],
  ],
  "/guides": [[/The definitive startup credits comparison — (\d+) programs across /g, 2]],
  "/localstack-alternatives": [[/The definitive startup credits comparison — (\d+) programs across /g, 1]],
  "/aws-free-tier-2026": [[/The definitive startup credits comparison — (\d+) programs across /g, 1]],
};

type Card = { name: string; label: string; href: string | null; lines: Map<string, string> };

const EXPECTED: Record<string, { label: string; href: string; lines: Array<[string, string]> }> = {
  [CLAUDE]: {
    label: "Open application",
    href: "https://claude.com/programs/startups",
    lines: [
      ["Credit value", "Up to $7,000 in Claude products and credits. Includes a free year of Claude Team and a $1,000 API credit."],
      ["Eligibility", "Founded in the last five years or funded in the last two. VC funding is not required."],
      ["What's included", "One year of Claude Team with up to five Premium seats, a one-time $1,000 API credit, and third-party offers worth up to $45,000. Partner VCs may add up to $100K. Credits apply to the first-party Claude API only."],
      ["Status", "As of 2026-10-09, the Team and $1,000 API credit offers are over capacity. All applications will be re-reviewed."],
    ],
  },
  [OPENAI]: {
    label: "Referral from a partner VC",
    href: "https://openai.com/business/why-openai/startups/",
    lines: [
      ["Credit value", "Credit value not stated."],
      ["Eligibility", "Requires a referral code from a partner VC."],
      ["What's included", "Credits only through a partner VC. The application needs the VC's referral code. No credit amount stated. Brex and Ramp customer perks on this page include OpenAI credits without VC backing."],
    ],
  },
};

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·",
};

function readable(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();
}

let server: ChildProcess;
let html = "";
const pages = new Map<string, string>();

before(async () => {
  server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
    server.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://localhost:${match[1]}`);
      }
    });
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  for (const page of Object.keys(PROGRAMME_COUNTS)) pages.set(page, await (await fetch(`${base}${page}`)).text());
  html = pages.get(PAGE)!;
});

after(() => {
  server?.kill();
});

function section(id: string): string {
  const start = html.indexOf(`<h3 id="${id}">`);
  assert.ok(start >= 0, `${PAGE} has no ${id} section`);
  const end = html.slice(start + 1).search(/<h3 id="cat-|<h2[ >]/);
  return end < 0 ? html.slice(start) : html.slice(start, start + 1 + end);
}

function cardsIn(sectionHtml: string): Card[] {
  return sectionHtml.split('<div class="diff-card"').slice(1).map((chunk) => {
    const heading = /<h3>([\s\S]*?)<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h3>/.exec(chunk);
    assert.ok(heading, `a card on ${PAGE} has no heading with a label: ${chunk.slice(0, 200)}`);
    const href = /<a href="([^"]+)"/.exec(heading[1]);
    const lines = new Map<string, string>();
    for (const line of chunk.matchAll(/<p class="diff-desc"><strong>([^<]+?):<\/strong>([\s\S]*?)<\/p>/g)) {
      lines.set(readable(line[1]), readable(line[2]));
    }
    return { name: readable(heading[1]), label: readable(heading[2]), href: href ? href[1] : null, lines };
  });
}

function allCards(): Card[] {
  return ["cat-cloud-infrastructure", "cat-fintech-banking", "cat-developer-tools", "cat-ai-tools"].flatMap((id) => cardsIn(section(id)));
}

function tableRow(name: string): string[] {
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => readable(c[1]));
    if (cells[0] === name) return cells;
  }
  assert.fail(`${PAGE}'s comparison table has no row for ${name}`);
}

describe("/startup-credits lists the AI labs' own startup programmes", () => {
  it("prints Claude Startups and then OpenAI for Startups first under AI Tool Credits, before Amazon Kiro", () => {
    const names = cardsIn(section("cat-ai-tools")).map((c) => c.name);
    assert.deepStrictEqual(names.slice(0, 2), [CLAUDE, OPENAI]);
    assert.ok(names.indexOf(KIRO) > 1, `AI Tool Credits lists ${names.join(", ")}`);
  });

  it("prints each programme's credit value, eligibility and inclusions, and Claude Startups' status, under its label", () => {
    const cards = cardsIn(section("cat-ai-tools"));
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const card = cards.find((c) => c.name === name);
      assert.ok(card, `AI Tool Credits has no ${name} card`);
      assert.strictEqual(card.label, expected.label);
      assert.deepStrictEqual([...card.lines.entries()], expected.lines);
    }
  });

  it("links each programme's card to the programme's own page", () => {
    const cards = cardsIn(section("cat-ai-tools"));
    for (const [name, expected] of Object.entries(EXPECTED)) {
      assert.strictEqual(cards.find((c) => c.name === name)?.href, expected.href);
    }
  });

  it("gives each programme a comparison-table row from its card's fields", () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const fields = new Map(expected.lines);
      assert.deepStrictEqual(tableRow(name), [
        name,
        fields.get("Credit value"),
        fields.get("Eligibility")!.split(".")[0],
        "—",
        expected.label,
      ]);
    }
  });

  it("dates Claude Startups' capacity status, and the source states it once", () => {
    const status = cardsIn(section("cat-ai-tools")).find((c) => c.name === CLAUDE)?.lines.get("Status") ?? "";
    const dated = /^As of (\d{4}-\d{2}-\d{2}), /.exec(status);
    assert.ok(dated, `the status carries no read date: ${status}`);
    assert.ok(dated[1] <= new Date().toISOString().slice(0, 10), `the status is dated ${dated[1]}`);
    const sources = readdirSync(path.join(REPO, "src")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(path.join(REPO, "src", f), "utf8"));
    assert.strictEqual(sources.join("\n").split("API credit offers are over capacity").length - 1, 1);
  });

  it("counts every card among the programmes compared and the open ones among those open to application", () => {
    const cards = allCards();
    const compared = /(\d+) programs compared/.exec(readable(html));
    assert.ok(compared, `${PAGE} states no count of programmes compared`);
    assert.strictEqual(Number(compared[1]), cards.length);
    const stat = (label: string) => {
      const m = new RegExp(`<div class="stat-number[^"]*">(\\d+)</div><div class="stat-label">${label}</div>`).exec(html);
      assert.ok(m, `${PAGE} has no ${label} figure`);
      return Number(m[1]);
    };
    assert.strictEqual(stat("Programs Compared"), cards.length);
    assert.strictEqual(stat("Open Application"), cards.filter((c) => c.label === "Open application").length);
  });

  it("gives the number of programme cards it prints wherever a page or the guide list counts its programmes", () => {
    const cards = allCards().length;
    const wrong = Object.entries(PROGRAMME_COUNTS).flatMap(([page, counts]) =>
      counts.flatMap(([pattern, times]) => {
        const found = [...pages.get(page)!.matchAll(pattern)].map((m) => Number(m[1]));
        if (found.length !== times) return [`${page} states ${pattern.source} ${found.length} times, not ${times}`];
        return found.filter((n) => n !== cards).map((n) => `${page} counts ${n} programmes where ${PAGE} prints ${cards} (${pattern.source})`);
      }));
    const blurb = /^The definitive startup credits comparison — (\d+) programs across /.exec(guideBlurb("startup-credits"));
    if (!blurb) wrong.push(`the guide list's entry for ${PAGE} states no count: ${guideBlurb("startup-credits")}`);
    else if (Number(blurb[1]) !== cards) wrong.push(`the guide list's entry for ${PAGE} counts ${blurb[1]} programmes where the page prints ${cards}`);
    assert.deepStrictEqual(wrong, []);
  });
});
