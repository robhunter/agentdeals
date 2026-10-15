import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TOOLS_PAGE = "/ai-coding-tools-pricing";
const GEMINI_CODE_ASSIST_PAGE = "/vendor/google-gemini-code-assist";

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
  for (const page of [TOOLS_PAGE, GEMINI_CODE_ASSIST_PAGE]) {
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
  it("prices ChatGPT Pro's three plans in Codex's row and card, and names Free and Go in its card", () => {
    assert.strictEqual(pricingRow(TOOLS_PAGE, "OpenAI Codex").power, "$100, $200 or $500/mo (ChatGPT Pro)");
    const card = cardText(TOOLS_PAGE, "openai-codex");
    assert.match(card, /Free \(\$0\)/);
    assert.match(card, /Go \(\$8\/mo\)/);
    assert.ok(card.includes("ChatGPT Pro plans are $100, $200, or $500 USD per month and currently have no five-hour limit."), card);
  });

  it("does not say anywhere on the page that Codex cannot run locally", () => {
    assert.doesNotMatch(textOf(served.get(TOOLS_PAGE)!), /Cloud-only|can't run locally|cannot run locally/i);
  });
});

const GEMINI_CODE_ASSIST_SALES_STOP = "Google stopped selling new Standard and Enterprise subscriptions on 2026-10-09. Existing subscribers can add licenses until 2027-01-31. Annual subscriptions can auto-renew until 2027-01-31; monthly subscriptions can auto-renew until 2027-12-31. Agentic coding assistance is now available through Antigravity, included in Gemini Enterprise editions.";

const STATED_ON_THE_TOOLS_PAGE = [
  GEMINI_CODE_ASSIST_SALES_STOP,
  "Gemini Code Assist Standard is $22.80/user/month or $19/user/month annually. Enterprise is $54/user/month or $45/user/month annually.",
  "GitHub Copilot Business ($19/seat) is cheapest. Gemini Code Assist is no longer sold to new customers. Cursor Teams seats are $30, $100 or $200 per user a month, with Claude and GPT billed at API list price plus the Cursor Token Rate. Devin Desktop (Windsurf) Teams is $80/month plus $40/month per full dev seat.",
  "Inline code suggestions, chat, code transformation, 50 agent invocations/month. Supports VS Code, JetBrains, CLI, and AWS Console. New sign-ups and subscriptions were blocked from 2026-05-15. Existing subscriptions can add users. Support ends on 2027-04-30. AWS recommends Kiro.",
  "The MarsCode cloud IDE ended on 2025-04-01. The extension is now Trae Plugin. marscode.com promotes the Trae AI IDE.",
  "Cline, Aider, and Gemini CLI with local models are the only fully private options. Cloud agents may process code on servers with varying data retention policies.",
  "GitHub Copilot — Copilot Student is free with an allowance of GitHub AI Credits, available to verified students. Verified teachers and maintainers of popular open source projects may be eligible for free Copilot Pro access.",
  "Free and Go state no message count. Plus and Business allowances are per five-hour window, vary by model and task, and may have weekly limits. Cloud tasks use more than local messages. Pro has no five-hour limit. API-key use is billed per token.",
  "Windsurf Pro ($20/mo) or Cursor Premium ($30/mo, with Claude and GPT billed at API list price on top; Cursor's $8 Plus plan runs only Grok models and Composer). Cascade was removed from Devin Desktop in version 3.9.19 on 2026-09-08. Devin Local is now the only agent.",
  "Since 2026-10-12, Cursor's pricing docs say: \"Cursor is sold as part of The X Subscription, one subscription for Grok, Cursor, and X.\" Free is $0, with limited Agent and Chat usage. Plus is $8/mo, Premium $30/mo (4x Plus's usage), Super $100/mo (15x) and Ultra $200/mo (50x), all from one weekly usage pool shared with Grok. Claude, GPT and Gemini are outside every plan's pool: Premium and above pay the model's API list price from prepaid credit, and Free and Plus cannot use them. Teams seats are $30, $100 or $200 per user a month. Existing Hobby, Pro ($20), Pro+ ($60) and Ultra subscribers keep their plans until they choose to switch.",
  "Since 2026-10-12, Cursor's paid plans for new subscribers start at $8/month (Plus, Grok models and Composer only) and $30/month (Premium, the first plan that can use Claude and GPT, billed at API list price on top); Windsurf's start at $20/month. Both top out at $200/month: Cursor Ultra and Windsurf Max. For teams, Cursor seats are $30, $100 or $200 per user a month, and Windsurf is $80/month plus $40 per seat. Existing Cursor Pro ($20) and Pro+ ($60) subscribers keep their plans until they switch. Windsurf, renamed Devin Desktop, raised Pro from $15 to $20 in March 2026.",
  "Price convergence: Windsurf, Augment, Bolt.new, Lovable, Codex (via ChatGPT Plus), and Devin all land at or near $20/month for their entry paid tier. GitHub Copilot is $10/mo. Since 2026-10-12, Cursor's entry paid plan for new subscribers is Plus at $8/mo, which runs only Grok models and Cursor's Composer.",
  "Amazon Kiro is an AI coding tool from AWS, generally available since November 2025, built around spec-driven development: requirements, design docs and tests. By default it runs on Auto, a mix of frontier models. Free: 50 credits/month. Pro: $20/month (1,000 credits). Paid plans can buy add-on credits at $0.04 each. Enterprise adds SAML/SCIM SSO.",
  "Cursor's Free plan lists \"Agent and Chat with limited usage\"",
  "The pattern: Credits and quotas are replacing flat subscriptions: Cursor in June 2025, Augment Code in October 2025, Windsurf in March 2026, and GitHub Copilot, which moved every plan to AI credits, in June 2026. Most entry plans are $20/month and power-user plans $200/month. Since 2026-10-12, Cursor's entry plan for new subscribers is Plus at $8/month, and Claude, GPT and Gemini cost API list price on top from Premium ($30/month) up.",
  "Key trends: Credit and quota models are replacing flat subscriptions (Cursor Jun 2025, Augment Oct 2025, Windsurf Mar 2026, Copilot Jun 2026).",
  "Cline is Apache 2.0 licensed. Users can bring their own API keys or use the Cline provider.",
];

const TEAMS_ANSWER = "GitHub Copilot Business ($19/seat) is cheapest for teams. Gemini Code Assist is no longer sold to new customers. Cursor Teams seats are $30, $100 or $200 per user a month, with Claude and GPT billed at API list price plus the Cursor Token Rate. Devin Desktop (Windsurf) Teams is $80/month plus $40/month per full dev seat.";

const WITHDRAWN_GEMINI_CODE_ASSIST_RECORD_TEXT: Record<string, RegExp> = {
  "Gemini Code Assist's paid subscriptions as unchanged": /subscriptions are unchanged|Standard and Enterprise continue/,
  "Gemini Code Assist Enterprise at $19 a month in 2025": /remains at \$19|enterprise-only at \$19/,
};

const STATED_ON_THE_GEMINI_CODE_ASSIST_PAGE = [
  GEMINI_CODE_ASSIST_SALES_STOP,
  "Google stopped selling new Standard and Enterprise subscriptions on 2026-10-09; existing subscriptions continue to the end of their contracts.",
  "No free tier — paid Standard and Enterprise subscriptions only",
  "Free individual tier with code completions, chat, and multi-file editing. Standard and Enterprise remained paid.",
];

const WITHDRAWN_FROM_THE_TOOLS_PAGE: Record<string, RegExp> = {
  ...WITHDRAWN_GEMINI_CODE_ASSIST_RECORD_TEXT,
  "Gemini Code Assist Enterprise at $19 a seat": /Gemini Code Assist Enterprise (?:matches at \$19|\(\$19\/seat\))/,
  "Code Assist's annual price as its only price": /\$19\/user\/month with an annual commitment/,
  "a Windsurf Business plan": /Windsurf Business|Cursor\/Windsurf Business/,
  "Amazon Q Developer as the best value on AWS": /Best value if already on AWS|genuinely useful for AWS-centric/,
  "MarsCode's cloud IDE as available": /Free cloud IDE|built into the cloud IDE|MarsCode \(ByteDance\)/,
  "Copilot free and unlimited for students, teachers and maintainers": /free unlimited access/,
  "Codex Pro as a multiple of Plus": /5x or 20x/,
  "Codex Pro priced from $100": /From \$100\/mo \(Pro\)|Pro \(from \$100\/mo\)/,
  "Cascade as a current Windsurf feature": /agentic Cascade flows/,
  "Cline as MIT-licensed": /open-source \(MIT\)/,
  "Devin Teams as $40 a seat with an $80 minimum": /\$40\/full seat with an \$80 monthly minimum/,
  "Cursor's Teams seat at $40": /Cursor Teams is \$40|Cursor charges \$40/,
  "Cursor's individual plans starting at $20 beside Windsurf's": /both \$20\/mo|Both start at \$20/,
  "Kiro Pro priced to match Cursor": /matching Cursor's price/,
  "Hobby as the free plan a new Cursor subscriber gets": /Hobby is Cursor's free plan|Cursor's free plan is called Hobby|Cursor's free Hobby plan/,
  "Cursor's entry tier among those near $20": /Price convergence: Cursor/,
  "entry prices held at $20 by the credit model": /keeping entry prices at \$20/,
  "GitHub Copilot's move to credits as still to come": /Expect GitHub Copilot to adopt/,
};

function rowsBetween(page: string, from: string, to: string): string[][] {
  const html = served.get(page)!;
  return [...html.slice(html.indexOf(from), html.indexOf(to)).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1])))
    .filter((cells) => cells.length > 0);
}

function rowFor(rows: string[][], tool: string): string[] {
  const found = rows.filter((cells) => cells[0] === tool);
  assert.strictEqual(found.length, 1, `${found.length} rows for ${tool}`);
  return found[0].slice(1);
}

describe("/ai-coding-tools-pricing says which of its products are closed, as their vendors say", () => {
  it("prints each replacement line as written", () => {
    const text = textOf(served.get(TOOLS_PAGE)!);
    assert.deepStrictEqual(STATED_ON_THE_TOOLS_PAGE.filter((line) => !text.includes(line)), []);
  });

  it("answers which tool is best for teams with the replacement, in the page and in its FAQ data", () => {
    const html = served.get(TOOLS_PAGE)!;
    assert.ok(textOf(html).includes(TEAMS_ANSWER), "the page does not print the teams answer");
    const answers = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .flatMap(([, json]) => [JSON.parse(json)].flat())
      .flatMap((block) => block?.["@type"] === "FAQPage" ? block.mainEntity : [])
      .filter((question) => question.name === "Which AI coding tool is best for teams?")
      .map((question) => question.acceptedAnswer.text);
    assert.strictEqual(answers.length, 1, `${answers.length} FAQ answers to which tool is best for teams`);
    assert.ok(answers[0] === TEAMS_ANSWER || answers[0].startsWith(`${TEAMS_ANSWER} `), answers[0]);
  });

  it("states none of the replaced claims in the page or its structured data", () => {
    const text = textOf(served.get(TOOLS_PAGE)!);
    assert.deepStrictEqual(Object.entries(WITHDRAWN_FROM_THE_TOOLS_PAGE).filter(([, claim]) => claim.test(text)).map(([what]) => what), []);
  });

  it("prints the corrected Gemini Code Assist records on the vendor's own page, and none of the text they replace", () => {
    const text = textOf(served.get(GEMINI_CODE_ASSIST_PAGE)!);
    assert.deepStrictEqual(STATED_ON_THE_GEMINI_CODE_ASSIST_PAGE.filter((line) => !text.includes(line)), []);
    assert.deepStrictEqual(Object.entries(WITHDRAWN_GEMINI_CODE_ASSIST_RECORD_TEXT).filter(([, claim]) => claim.test(text)).map(([what]) => what), []);
  });

  it("prices Cursor's table rows at the plans a new subscriber can buy", () => {
    assert.deepStrictEqual(pricingRow(TOOLS_PAGE, "Cursor"), {
      free: "Limited Agent and Chat usage",
      pro: "$8/mo (Plus); $30/mo (Premium) for Claude and GPT",
      power: "$200/mo (Ultra)",
      teams: "$30, $100 or $200/user/mo",
    });
    const freeTiers = rowsBetween(TOOLS_PAGE, 'id="free-tiers"', 'id="cost-analysis"');
    assert.strictEqual(rowFor(freeTiers, "Cursor")[1], "Limited Agent and Chat usage");
    const costs = rowsBetween(TOOLS_PAGE, 'id="cost-analysis"', 'id="hidden-costs"');
    assert.deepStrictEqual(rowFor(costs, "Cursor").slice(0, 2), [
      "$8 (Plus, Grok and Composer only) or $30 (Premium) plus Claude and GPT at API list price",
      "$150 (5 × $30 seats) plus Claude and GPT at API list price and the Cursor Token Rate",
    ]);
  });

  it("lists Amazon Q Developer and MarsCode with no free tier, saying when each closed", () => {
    assert.strictEqual(pricingRow(TOOLS_PAGE, "Amazon Q Developer").free, "New signups blocked 2026-05-15");
    assert.strictEqual(pricingRow(TOOLS_PAGE, "MarsCode").free, "Ended 2025-04-01");
    const freeTiers = rowsBetween(TOOLS_PAGE, 'id="free-tiers"', 'id="cost-analysis"');
    assert.deepStrictEqual(rowFor(freeTiers, "Amazon Q Developer"), ["No free tier", "New signups blocked 2026-05-15", "Immediately"]);
    assert.deepStrictEqual(rowFor(freeTiers, "MarsCode"), ["No free tier", "Ended 2025-04-01", "Immediately"]);
    const costs = rowsBetween(TOOLS_PAGE, 'id="cost-analysis"', 'id="hidden-costs"');
    assert.deepStrictEqual(rowFor(costs, "Amazon Q Developer"), ["$19", "$95", "50 agent invocations/month is the main limit. Pro at $19/mo unlocks higher limits and security scanning."]);
    assert.deepStrictEqual(rowFor(costs, "MarsCode"), ["—", "—", "—"]);
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

  it("does not list Claude Code's free tier as API-based", () => {
    assert.doesNotMatch(pricingRow(TOOLS_PAGE, "Claude Code").free, /API-based/i);
  });

  it("prices Bolt.new's and Lovable's Pro plans at $25", () => {
    assert.strictEqual(pricingRow(TOOLS_PAGE, "Bolt.new").pro, "$25/mo");
    assert.strictEqual(pricingRow(TOOLS_PAGE, "Lovable").pro, "$25/mo");
  });

  it("gives Cursor's usage cost by model from Cursor's own prices, with Claude Opus at twice Claude Sonnet", () => {
    const [, , usageCost] = rowFor(rowsBetween(TOOLS_PAGE, '<h2 id="cost-analysis">', '<h2 id="hidden-costs">'), "Cursor");
    assert.strictEqual(usageCost, "Usage cost varies by model. Claude Opus 5.5 costs $4/$20 per million tokens, twice the $2/$10 cost of Claude Sonnet 5.5.");
  });

  it("keeps none of the retired plan text in the hand-written rows, cards and answers", () => {
    const retired = [
      "$500/mo (250 credits)",
      "Team plan $500",
      "ACUs at $2.25",
      "Devin: $20/mo minimum",
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
      "burns 10x faster",
    ];
    const source = readdirSync(path.join(REPO, "src"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => [file, readFileSync(path.join(REPO, "src", file), "utf-8")] as const);
    const found = source.flatMap(([file, text]) => retired.filter((phrase) => text.includes(phrase)).map((phrase) => `src/${file}: ${phrase}`));
    assert.deepStrictEqual(found, []);
  });
});
