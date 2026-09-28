import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGES_THIS_GUIDE_STATES_PROGRAMMES_ON = [
  "/startup-credits",
  "/cloud-free-tier-comparison-2026",
  "/azure-free-tier-2026",
  "/digitalocean-free-tier-2026",
  "/state-of-free-tiers",
  "/free-tier-risk",
  "/q1-2026-developer-pricing-report",
  "/hosting-alternatives",
];

const WITHDRAWN = [
  "Founders Hub Basic",
  "Cloudflare Bootstrapped ($5K)",
  "Cloudflare High Growth",
  "SWE-1.5 model access",
  "$2.5K OpenAI",
  "1yr GitHub",
  "$5K DigitalOcean credits",
  "Up-and-Coming ($25K)",
  "19 programs",
  "IBM Builder",
  "$500K+ Total Credit Value",
  "Durable Objects pricing reduction",
  "$250K Startup Program",
  "15+ startup programs",
  "$1.90/GPU/hr",
  "H100 at ~$1.90/hr",
];

const PROGRAMMES: Record<string, [string, string, string, string]> = {
  "AWS Activate": ["$1K–$5K (Founders), up to $200K (Portfolio)", "Pre-Series B, founded in the last 10 years, AWS account on a paid plan. Founders: self-funded. Portfolio: needs an Activate Provider Org ID.", "Usually 1–2 years, by package", "One award per approved application; a later, larger award pays only the difference"],
  "Google Cloud for Startups": ["$2K (Start), up to $200K (Scale), up to $350K (Scale AI)", "Start: no funding yet but plans to raise venture funding soon, founded within 24 months, working MVP; Scale: VC funding from pre-seed to Series A (Series A within the last 12 months; angel money does not count), founded within 5 years.", "12 months (Start), 2 years (Scale)", "Scale: year 1 covers usage up to $100K ($250K for AI); year 2 covers 20% of spend, up to $100K more"],
  "Microsoft for Startups (formerly Founders Hub)": ["$200 on sign-up; up to $150K as Azure usage grows or with an Investor Network partner", "B2B software, AI or tech startups, pre-seed to Series C, privately held; no investor needed. Business verification and sustained Azure usage unlock more credits, and Investor Network backing starts most startups at $100K.", "Activate within 90 days; the first $200 lasts 90 days, the verification credit 180 days, and credits from the $25K milestone up to 2 years", "Released in milestones as you verify the business and use more Azure"],
  "DigitalOcean Startups": ["Credits for 12 months; amount varies, up to $10,000 a month", "Raised $10M or less; apply through a partner or directly", "12 months", ""],
  "Cloudflare Startup Program": ["$10K, $100K or $350K by tier", "Tier 3 ($10K): bootstrapped or self-funded, under $1M raised; Tiers 2 ($100K) and 1 ($350K): funded by an affiliated partner, Tier 1 with $5M+ raised.", "1 year or until used up", "Lump sum per tier"],
  "Stripe Atlas": ["Over $50K in partner discounts, plus $2.5K of Stripe credits", "Companies incorporated through Atlas ($500, then $100 a year after the first year)", "Varies by perk; Stripe credits last the first year", "Available once the Atlas application is approved"],
  "Brex": ["Over $350K in partner discounts and credits", "Brex customers", "", ""],
  "Mercury": ["", "", "", ""],
  "Ramp": ["Over $350K in partner rewards", "Ramp customers", "", ""],
  "SVB (Silicon Valley Bank)": ["$5K AWS + partner offers", "SVB clients (SVB is a division of First Citizens Bank)", "", "Per-partner activation"],
  "PostHog for Startups": ["$50K in credits (YC: $50K a year)", "Under 2 years old and under $5M raised. YC companies under $25M raised get $50K a year instead.", "12 months (YC: renews yearly while eligible)", "Credits for 12 months; the YC deal renews yearly"],
  "Amazon Kiro (AWS Startups)": ["Up to 1 year of Kiro Pro+ ($40 per user a month)", "Early stage to Series A, without active AWS Activate credits; Kiro's startup page asks for VC backing and its terms do not; not available in France, Germany, Italy, Spain, Poland, Brazil, Mexico, Argentina, the UAE, China or sanctioned regions; apply by 2026-12-31.", "Credits expire 1 year after they are issued", "Deposited once to your AWS account"],
  "Amplitude Early Stage Startup Pricing": ["1 year of the Growth plan free", "Under 20 employees and under $10M raised", "1 year; year 2 at 40% off the annual Plus plan, or move to the free plan", "Full plan for 12 months"],
};

const INCLUDED: Record<string, string> = {
  "AWS Activate": "AWS credits, which can also pay for AWS Support. Technical guidance, mentoring and go-to-market resources.",
  "Google Cloud for Startups": "Google Cloud and Firebase credits, 12 months of Google Workspace Business Plus, technical training and business support. The AI tier adds $150K of credits.",
  "Microsoft for Startups (formerly Founders Hub)": "Azure credits and Azure AI models. GitHub Enterprise, Microsoft 365 Business Premium, Visual Studio Enterprise and LinkedIn Premium offers are for Investor Network-backed startups only.",
  "DigitalOcean Startups": "Compute credits for most DigitalOcean services, 15 months of free Standard-tier support; GPU credits are a separate benefit for selected startups",
  "Cloudflare Startup Program": "Credits for usage-based services such as Workers and R2 (R2 up to $10K; Workers AI up to $2.5K, $10K or $50K by tier). AI Gateway is not covered. Core security and networking features are free at every tier.",
  "Stripe Atlas": "$2.5K of Stripe product credits for the first year, $5K of AWS Activate credits (new AWS users), $100K of Cloudflare credits through the Cloudflare Startup Program, Microsoft for Startups Azure credits, a 30-minute immigration attorney consult (Ellis), and banking through Stripe Treasury.",
  "Brex": "Up to $5K of AWS credits for new Brex customers (subject to Activate eligibility), $1K of OpenAI credits for a year, up to $200K of Google Cloud and Firebase credits over 2 years, 6 months of Notion Plus, 30% off Slack for 12 months.",
  "Mercury": "1 year of Datadog free (up to $100K in credits; Series A or earlier, new Datadog customers), up to $5K of AWS Activate credits, 50% off QuickBooks Online for 3 months. Mercury's Google Cloud offer is paused.",
  "Ramp": "AWS credits through AWS Activate and OpenAI API credits (Ramp states no amount for either), $350 of Google Cloud credits, 6 months of Notion Business with Notion AI.",
  "SVB (Silicon Valley Bank)": "$5K of AWS Activate credits (with an Activate Provider Org ID, pre-Series B), $5K of MongoDB credits for 12 months, 25% off Slack upgrades (up to $9K). 79 offers from 58 vendors; no Google Cloud offer.",
  "PostHog for Startups": "Credits for product analytics, session replay, feature flags and experiments, plus about $12K of partner perks. Since 2026-09-14, credits don't cover PostHog AI, Desktop, the Slack app, Replay Vision or Inbox.",
  "Amazon Kiro (AWS Startups)": "Kiro Pro+ for up to 2, 10 or 30 users (Starter, Growth and Scale tiers).",
  "Amplitude Early Stage Startup Pricing": "The full Growth plan for 200K monthly tracked users or 100M events a month.",
};

const STATED_ON_THE_GUIDE = [
  "$350K Largest Published Offer",
  "Startup credits in 2026: 13 programs across cloud infrastructure, fintech perks, developer tools and AI. The largest published offers are up to $350,000. Cloud providers offer the highest individual values. Fintech platforms pass partner credits on to their customers; each perk is claimed separately.",
  "Key insight: Stacking Google Scale (up to $200K) + AWS Activate Portfolio (up to $200K) + Cloudflare Tier 2 ($100K) can reach $500K; each needs VC funding or an affiliated partner. AWS credits from Brex and Stripe Atlas overlap: a later award pays only the difference.",
  "Major cloud providers offering $200–$350K in compute",
  "Credit Expiry Timelines AWS Activate credits usually expire within 1-2 years.",
  "Vesting Schedules AWS Activate gives one award per approved application.",
  "Revenue & Funding Caps Google Scale requires VC funding; angel money doesn't count. PostHog's YC deal has a $25M fundraising cap and renews only while you stay under it.",
  "Overlapping Perks Problem Brex, Mercury, Ramp, SVB and Stripe Atlas all offer AWS Activate credits. A later AWS Activate award pays only the difference, so several $5,000 perks give $5,000 in total. Mercury states that credits are not added on.",
  "Funded startup, three clouds (up to $500K) Google Scale (up to $200K) + AWS Activate Portfolio (up to $200K) + Cloudflare Tier 2 ($100K). Requires VC funding and an affiliated partner.",
  "Bootstrapped founder ($63K+) AWS Activate Founders offers $1,000. Google Start offers $2,000. Microsoft offers $200 on sign-up, with more after verification. Cloudflare Tier 3 offers $10,000. PostHog offers $50,000 for startups under 2 years old. None needs funding.",
  "YC / Accelerator company (up to $350K) AWS Activate Portfolio (up to $200K) + Google Scale (up to $100K in the first year) + PostHog ($50K) = up to $350K in the first year.",
  "AI-focused startup (up to $550K, plus Kiro) Google Scale AI (up to $350K) + Kiro (up to one year of Kiro Pro+, $40 per user a month) + AWS Activate Portfolio (up to $200K). Apply for Kiro first: it excludes startups with active Activate credits.",
  "Careful: their AWS credits don't add up; a later Activate award pays only the difference.",
];

const FAQ_ANSWERS = [
  "The largest published offers are Google Scale AI and Cloudflare Tier 1, each up to $350,000. Then Google Scale and AWS Activate Portfolio, up to $200,000 each. Then Microsoft for Startups, up to $150,000. Most require VC funding or an affiliated partner.",
  "Yes. Programs on different platforms stack: Google Scale (up to $200K), AWS Activate Portfolio (up to $200K) and Cloudflare Tier 2 ($100K) can combine to $500K. Credits from fintech platforms come from the same programmes: a later AWS Activate award pays only the difference, and Stripe Atlas's Cloudflare and Azure credits are Cloudflare's and Microsoft's own programmes.",
  "Programmes that need no funding: AWS Founders, Google Start, Microsoft, Cloudflare Tier 3, PostHog, Amplitude and DigitalOcean Startups. Programmes that need VC backing or an affiliated partner: Google Scale, AWS Portfolio, Cloudflare Tiers 1 and 2. Kiro's page asks for VC backing; its terms do not. Banking programs (Brex, Mercury, Ramp, SVB) need an account; Stripe Atlas needs incorporation through Atlas.",
];

const STATED_ELSEWHERE: Record<string, string[]> = {
  "/cloud-free-tier-comparison-2026": [
    "Up to $350K Startup Program Credits",
    "Microsoft for Startups needs no investor: B2B tech startups start at $200 and can reach $150K with Azure usage. GCP offers up to $350K to AI-first startups and needs VC funding. AWS Activate Portfolio needs an Activate Provider Org ID.",
    "Google for Startups offers up to $350K to AI-first startups. Its Scale tier needs VC funding; its $2K Start tier needs none.",
  ],
  "/azure-free-tier-2026": [
    "AWS Activate: up to $200K credits (Portfolio needs an Activate Provider Org ID). Google for Startups: up to $200K, or $350K for AI-first startups (VC funding, pre-seed to Series A). Microsoft for Startups: up to $150K with no investor needed.",
    "B2B tech startups get $200 on sign-up and up to $150K as they verify the business and use Azure. GitHub Enterprise and Microsoft 365 offers are for startups backed by Microsoft's Investor Network.",
    "Investor Network-backed startups also get GitHub Enterprise and Visual Studio Enterprise offers.",
  ],
  "/digitalocean-free-tier-2026": [
    "Credits for 12 months in an amount that varies by startup, usable up to $10,000 a month. They do not cover GPU Droplets, H100 GPU products, inference or third-party AI models; GPU credits are a separate benefit for selected startups. 15 months of free Standard-tier support.",
    "Raised $10M or less, not a service business, and new to DigitalOcean credits. Apply through a partner accelerator, incubator or VC, or directly.",
    "AWS Activate: up to $200K (Portfolio needs an Activate Provider Org ID). Google for Startups: up to $200K, or $350K for AI-first startups; a $2K Start tier needs no funding. Microsoft for Startups: up to $150K (no investor needed).",
  ],
  "/state-of-free-tiers": [
    "Cloudflare Startup Program Up to $350K 3 tiers; upper two via affiliated partners",
    "Microsoft for Startups Up to $150K B2B tech startups, pre-seed to Series C Azure credits, Foundry models",
    "DigitalOcean Startups Amount varies",
    "AWS Activate Up to $200K Portfolio needs an Activate Provider Org ID",
    "for 13 programs.",
  ],
  "/free-tier-risk": ["Microsoft for Startups offers up to $150K in credits.", "Added free Queues and expanded Workers in Q1 2026."],
  "/q1-2026-developer-pricing-report": ["In Q1 2026, Cloudflare added a free tier for Queues:", "Free Queues (February)"],
  "/hosting-alternatives": ["See our startup credits guide: Google for Startups and Cloudflare offer the largest published packages, up to $350K each."],
};

const CLOUD_STARTUP_ROWS = [
  ["Activate", "Up to $200K", "1–2 years", "Activate Provider Org ID (Portfolio)"],
  ["Google for Startups", "Up to $350K", "1–2 years", "VC funding, pre-seed to Series A"],
  ["Microsoft for Startups", "Up to $150K", "90 days to 2 years", "No funding requirement (easiest to qualify)"],
  ["DigitalOcean Startups", "Amount varies (up to $10,000 a month)", "12 months", "$10M raised or less; partner or direct application"],
];

const ENTITIES: Record<string, string> = {
  "&mdash;": "—", "&ndash;": "–", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&rsquo;": "’", "&nbsp;": " ", "&middot;": "·", "&rarr;": "→", "&lt;": "<", "&gt;": ">",
};

function decoded(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
}

function readable(html: string): string {
  return decoded(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(?:a|abbr|b|code|em|i|small|span|strong|sub|sup)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function structuredStrings(html: string): string[] {
  const strings: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/gi)) strings.push(decoded(m[1]));
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    try {
      walk(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return strings;
}

function startupTableRows(html: string): string[][] {
  const table = html.split('id="startup-credits"')[1]?.split("</table>")[0] ?? "";
  const body = table.split("<tbody>")[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(1).map(([, cell]) => readable(cell))
  );
}

function programmeCards(html: string): Map<string, Record<string, string>> {
  const cards = new Map<string, Record<string, string>>();
  for (const [, card] of html.matchAll(/<div class="diff-card"[^>]*>([\s\S]*?)<\/div>/g)) {
    const name = readable(card.match(/<h3>([\s\S]*?)<span/)?.[1] ?? "").trim();
    const fields: Record<string, string> = {};
    for (const [, label, value] of card.matchAll(/<strong>([^<]+):<\/strong>\s*([\s\S]*?)<\/p>/g)) fields[label] = readable(value);
    cards.set(name, fields);
  }
  return cards;
}

let server: ChildProcess;
const served = new Map<string, string>();

describe("the startup credits guide states each programme's terms as the programme does, and so do the pages that repeat them", () => {
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
    for (const page of PAGES_THIS_GUIDE_STATES_PROGRAMMES_ON) {
      const response = await fetch(`${base}${page}`);
      assert.strictEqual(response.status, 200, `${page} answered ${response.status}`);
      served.set(page, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("states none of the withdrawn claims on these pages, in body, meta or structured data", () => {
    const found = [...served].flatMap(([page, html]) => {
      const text = `${readable(html)} ${structuredStrings(html).join(" ")}`;
      return WITHDRAWN.filter((claim) => text.includes(claim)).map((claim) => `${page}: "${claim}"`);
    });
    assert.deepStrictEqual(found, []);
  });

  it("lists thirteen programmes, without IBM or Segment, and counts thirteen", () => {
    const cards = programmeCards(served.get("/startup-credits")!);
    assert.deepStrictEqual([...cards.keys()].sort(), Object.keys(PROGRAMMES).sort());
    const text = readable(served.get("/startup-credits")!);
    assert.ok(text.includes("13 Programs Compared"), "the programme count card does not say 13");
    assert.ok(structuredStrings(served.get("/startup-credits")!).some((s) => s.startsWith("Compare 13 startup programs: AWS Activate, Google for Startups, Microsoft for Startups, Cloudflare, DigitalOcean Startups, Stripe Atlas, Brex, Mercury, and more.")));
  });

  it("states each programme's credit value, eligibility, duration, inclusions and vesting as written", () => {
    const cards = programmeCards(served.get("/startup-credits")!);
    const wrong = Object.entries(PROGRAMMES).flatMap(([name, [credit, eligibility, duration, vesting]]) => {
      const card = cards.get(name) ?? {};
      const expected: Array<[string, string]> = [
        ["Credit value", credit], ["Eligibility", eligibility], ["Duration", duration], ["Vesting", vesting], ["What's included", INCLUDED[name]],
      ];
      return expected
        .filter(([label, value]) => value !== "" && card[label] !== value)
        .map(([label, value]) => `${name} ${label}: "${card[label]}" where the programme says "${value}"`);
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states the summary, constraints and stacking lines as written", () => {
    const text = readable(served.get("/startup-credits")!);
    assert.deepStrictEqual(STATED_ON_THE_GUIDE.filter((line) => !text.includes(line)), []);
  });

  it("answers the FAQ as written, in the page and in its FAQPage data", () => {
    const html = served.get("/startup-credits")!;
    const text = readable(html);
    const structured = structuredStrings(html);
    const inStructuredData = (answer: string) => structured.some((s) => s === answer || s.startsWith(`${answer} `));
    assert.deepStrictEqual(FAQ_ANSWERS.filter((answer) => !text.includes(answer) || !inStructuredData(answer)), []);
  });

  it("lists each cloud's startup programme on the cloud comparison as the programme states it", () => {
    assert.deepStrictEqual(startupTableRows(served.get("/cloud-free-tier-comparison-2026")!), CLOUD_STARTUP_ROWS);
  });

  it("states the same programme terms on the pages that repeat them", () => {
    const missing = Object.entries(STATED_ELSEWHERE).flatMap(([page, lines]) => {
      const text = readable(served.get(page)!);
      return lines.filter((line) => !text.includes(line)).map((line) => `${page}: "${line}"`);
    });
    assert.deepStrictEqual(missing, []);
  });
});
