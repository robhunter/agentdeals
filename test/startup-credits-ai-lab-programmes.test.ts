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
const XAI = "Grok for Startups (xAI)";
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
    label: "Not accepting applications",
    href: "https://claude.com/programs/startups",
    lines: [
      ["Credit value", "Not accepting new applications. Members: Claude Startup Stack offers worth up to $45,000; startups backed by a VC in Anthropic's partner network may get up to $100K in API credits through the VC."],
      ["Eligibility", "Not accepting new applications: the current cohort is full."],
      ["What's included", "Members keep Claude Startup Stack offers worth up to $45,000, Applied AI group sessions and events. Startups backed by a VC in Anthropic's partner network may get up to $100K in API credits through the VC. Credits apply to the first-party Claude API only."],
      ["Status", "Since between 2026-10-12 and 2026-10-14, Anthropic says the current cohort is full and it is not accepting new applications. Applications still in review were not taken forward."],
    ],
  },
  [XAI]: {
    label: "VC/funding required",
    href: "https://x.ai/startups",
    lines: [
      ["Credit value", "No amount stated. Sized by funding, revenue and AI spend to about six months of usage."],
      ["Eligibility", "Venture backing, a live product, and a company email matching the website. One grant per company."],
      ["Duration", "Credits expire six months after they are applied unless the approval says otherwise."],
      ["What's included", "Credits for Grok, Grok Build, Grok Bot and the Grok API from one balance."],
      ["Vesting", "20% on approval, the other 80% after onboarding."],
      ["When credits run out", "Usage continues at xAI's standard pricing. (From x.ai/startups , read 2026-10-29.)"],
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
  it("prints the three AI lab programmes first under AI Tool Credits, before Amazon Kiro", () => {
    const names = cardsIn(section("cat-ai-tools")).map((c) => c.name);
    assert.deepStrictEqual(names.slice(0, 3), [CLAUDE, OPENAI, XAI]);
    assert.ok(names.indexOf(KIRO) > 2, `AI Tool Credits lists ${names.join(", ")}`);
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
        fields.get("Duration") ?? "—",
        expected.label,
      ]);
    }
  });

  it("dates the interval in which Claude Startups closed, and the source states it once", () => {
    const status = cardsIn(section("cat-ai-tools")).find((c) => c.name === CLAUDE)?.lines.get("Status") ?? "";
    const dated = /^Since between (\d{4}-\d{2}-\d{2}) and (\d{4}-\d{2}-\d{2}), /.exec(status);
    assert.ok(dated, `the status carries no read date: ${status}`);
    assert.ok(dated[1] < dated[2] && dated[2] <= new Date().toISOString().slice(0, 10), `the status interval is ${dated[1]} to ${dated[2]}`);
    const sources = readdirSync(path.join(REPO, "src")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(path.join(REPO, "src", f), "utf8"));
    assert.strictEqual(sources.join("\n").split("Applications still in review were not taken forward.").length - 1, 1);
  });

  it("offers none of Claude Startups' withdrawn benefits anywhere on the page", () => {
    assert.doesNotMatch(readable(html), /up to \$7,000|free year of Claude Team|one year of Claude Team|\$1,000 API credit|one-time \$1,000|VC funding is not required|All applications will be re-reviewed/i);
    const card = cardsIn(section("cat-ai-tools")).find((c) => c.name === CLAUDE)!;
    assert.strictEqual(card.label, "Not accepting applications");
    assert.ok(card.lines.get("Credit value")?.startsWith("Not accepting new applications."));
    assert.strictEqual(tableRow(CLAUDE)[4], "Not accepting applications");
    assert.ok(html.includes('<div class="diff-card" style="border-left-color:#f85149"><h3><a href="https://claude.com/programs/startups"'));
    assert.ok(html.includes('<span style="color:#f85149;font-size:.8rem;font-weight:600">Not accepting applications</span>'));
  });

  it("links Grok's billing continuation to the programme with citation attributes", () => {
    const ai = section("cat-ai-tools");
    assert.ok(ai.includes('<a href="https://x.ai/startups" rel="nofollow noopener"'));
    assert.ok(ai.includes('(From <a href="https://x.ai/startups" rel="nofollow noopener">x.ai/startups</a>, read 2026-10-29.)'));
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
