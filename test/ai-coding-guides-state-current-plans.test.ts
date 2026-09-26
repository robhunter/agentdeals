import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TOOLS_PAGE = "/ai-coding-tools-pricing";
const YEAR_PAGE = "/ai-coding-pricing-2026";

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
  for (const page of [TOOLS_PAGE, YEAR_PAGE]) {
    served.set(page, await (await fetch(`http://localhost:${port}${page}`)).text());
  }
});

after(() => { proc?.kill(); });

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function pricingRow(page: string, vendor: string): { free: string; pro: string; power: string; teams: string } {
  const rows = [...served.get(page)!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1])))
    .filter((cells) => cells.length === 5 && (cells[0] === vendor || cells[0].startsWith(`${vendor} `)));
  assert.strictEqual(rows.length, 1, `${page} has ${rows.length} pricing rows for ${vendor}`);
  const [, free, pro, power, teams] = rows[0];
  return { free, pro, power, teams };
}

function cardText(page: string, vendorSlug: string): string {
  const card = served.get(page)!.match(
    new RegExp(`<div class="diff-card"[^>]*><h3><a href="/vendor/${vendorSlug}"[\\s\\S]*?<p class="diff-desc">([\\s\\S]*?)</p>`),
  );
  assert.ok(card, `${page} has no card for ${vendorSlug}`);
  return textOf(card[1]);
}

describe("/ai-coding-tools-pricing states OpenAI Codex's current plans", () => {
  it("prices Pro from $100 in Codex's row, and names Free and Go in its card", () => {
    assert.strictEqual(pricingRow(TOOLS_PAGE, "OpenAI Codex").power, "From $100/mo (Pro)");
    const card = cardText(TOOLS_PAGE, "openai-codex");
    assert.match(card, /Free \(\$0\)/);
    assert.match(card, /Go \(\$8\/mo\)/);
    assert.doesNotMatch(card, /\$200/);
  });

  it("does not say anywhere on the page that Codex cannot run locally", () => {
    assert.doesNotMatch(textOf(served.get(TOOLS_PAGE)!), /Cloud-only|can't run locally|cannot run locally/i);
  });
});

describe("the AI coding guides state the plans the vendors' own pricing pages list", () => {
  it("prices Devin's team plan at $80 a month plus seats, not the retired $500 plan", () => {
    const teams = pricingRow(TOOLS_PAGE, "Devin").teams;
    assert.match(teams, /\$80/);
    assert.doesNotMatch(teams, /\$500/);
  });

  it("does not call Google Antigravity a preview", () => {
    assert.doesNotMatch(pricingRow(TOOLS_PAGE, "Google Antigravity").free, /preview/i);
  });

  it("does not list Claude Code's free tier as API-based on either guide", () => {
    for (const page of [TOOLS_PAGE, YEAR_PAGE]) {
      assert.doesNotMatch(pricingRow(page, "Claude Code").free, /API-based/i, page);
    }
  });

  it("prices Bolt.new's and Lovable's Pro plans at $25", () => {
    assert.strictEqual(pricingRow(TOOLS_PAGE, "Bolt.new").pro, "$25/mo");
    assert.strictEqual(pricingRow(TOOLS_PAGE, "Lovable").pro, "$25/mo");
  });

  it("keeps none of the retired plan text in the hand-written rows, cards and answers", () => {
    const retired = [
      "$500/mo (250 credits)",
      "Team plan $500",
      "ACUs at $2.25",
      "$20/mo minimum",
      "100% free (preview)",
      "no paid tiers yet",
      "Pricing has not been announced",
      "Claude-powered",
      "$40/seat (Teams)",
      "Teams ($40/mo/seat)",
      "identical prices",
      "Peak-hour throttling",
      "OpenClaw",
      "public projects only",
      "$33/seat",
      "launched GA in April 2026",
      "can't run locally",
      "Pro ($200/mo)",
      "$200/mo (Pro)",
      "reduced from $30",
      "dropped from $30",
      "2M+ weekly users",
      "$100 credits for new team members",
      "Pay-as-you-go seats available",
    ];
    const source = readdirSync(path.join(REPO, "src"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => [file, readFileSync(path.join(REPO, "src", file), "utf-8")] as const);
    const found = source.flatMap(([file, text]) => retired.filter((phrase) => text.includes(phrase)).map((phrase) => `src/${file}: ${phrase}`));
    assert.deepStrictEqual(found, []);
  });
});
