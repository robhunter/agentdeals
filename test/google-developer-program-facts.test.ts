import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/google-developer-program-2026";
const SITEMAPS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const WITHDRAWN = [
  "75K+ requests",
  "250GB SQL",
  "Small 4, Devstral",
  "$41.67",
  "Covers 90%+",
  "more compute for $0",
  "multi-cloud setup that costs $0/month",
  "benefits now come with",
  "Premium was folded into",
  "replace most GDP Premium benefits",
  "Same GCP services",
  "U.S. college students",
  "Workspace accounts keep existing Premium subscriptions",
];

const GUIDE_BLURB = "Standalone Google Developer Program Premium no longer takes sign-ups — current plans, Cloud credits and free alternatives";

const STATED = [
  "$300 credits (90 days, no GPUs) + always-free tier",
  "Its Google Cloud credits and Firebase Studio workspaces now come with Google AI Pro ($19.99/mo) and Google AI Ultra (from $99.99/mo) on personal Google Accounts. Premium's 1:1 consultations, certification voucher and unlimited Google Skills access did not carry over.",
  "The headline loss: Cloud credits drop 76% for annual subscribers who move to AI Pro. GDP Premium's annual plan included $500 a year in Google Cloud credits, and its monthly plan $45 a month.",
  "GDP Premium's annual plan included a $50 credit a year for Google AI Studio and Vertex AI.",
  "Firebase Studio has taken no new workspaces since 2026-06-22 and shuts down on 2027-03-22.",
  "$200 credit (30 days) + 12 months of free services",
  "12 months: 750 hours each of B2pts v2 and B2ats v2 VMs, 5 GB Blob Storage. Always free: up to 10 SQL databases, 100,000 vCore seconds and 32 GB each a month",
  "75K monthly active users, 5 GB bandwidth, 2 GB storage, 750K executions",
  "Mistral Large 3, Medium 3.5, Small 4",
  "AWS's free plan and Azure's free account add more, but AWS's plan closes within 6 months, sooner if its credits run out, and Azure's 12 months of free services need a move to pay-as-you-go within 30 days.",
  "= $0/month within free limits. AWS's free plan closes within 6 months, but its always-free services, such as Lambda's 1M requests a month, continue on a Paid plan.",
  "Switch to always-free tiers (Oracle Cloud, Firebase Spark, free LLM APIs), and use AWS's and Azure's free offers while they last.",
  "The other $9.99 buys expanded Gemini 3.1 Pro access and the rest of the AI Pro bundle, including 5 TB of storage.",
];

const PREPAY_CREDITS =
  "The Gemini API keeps a free tier of its own; check Google's pricing page for your model. The monthly Google Cloud credits from Google AI Pro or Ultra are eligible Google Cloud credits. On the Prepay billing plan, these credits pay for Gemini API usage only after you buy Prepay credits in AI Studio. With a $0 Prepay balance, requests fail even with unused Google Cloud credits, according to a Google staff member on discuss.ai.google.dev.";

const PREPAY_CREDITS_SOURCE = "https://discuss.ai.google.dev/t/error-code-402-message-your-prepayment-credits-are-depleted/185524";

const LINK_THE_PLAN =
  "AI Pro gives expanded access to Gemini 3.1 Pro and Deep Research in the Gemini app. Link your Google AI Pro or Ultra plan on the Google Developer Program site to receive monthly Google Cloud credits and higher Antigravity quotas. Since June 18, 2026, Gemini CLI and the Gemini Code Assist IDE extensions no longer serve Google AI Pro or Ultra subscribers. Google points them to Antigravity. The Gemini API keeps a free tier of its own;";

const PROGRAM_SITE = "https://developers.google.com/program";
const CODE_ASSIST_DEPRECATION = "https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals";

const RENEWALS_ENDED =
  'annual plans stopped renewing after March 30, 2026 and monthly plans after June 30, 2026. Google\'s FAQ updated 2026-10-07 states: "The Google Developer Program premium standalone subscription has been deprecated, and new users can no longer sign up for it. Since September 18, 2026, existing subscriptions can no longer be renewed." It also says: "Existing monthly plan subscribers: Can continue to enjoy benefits until October 18, 2026. Existing annual plan subscribers: Can continue to enjoy benefits until September 18, 2027." Monthly benefits ended on October 18, 2026. The FAQ does not exempt Workspace accounts, but Google\'s older benefits page says Workspace subscriptions are not changing.';

const DEVELOPER_PROGRAM_FAQ = "https://developers.google.com/profile/help/faq";
const OLDER_BENEFITS_PAGE = "https://developers.google.com/profile/help/benefits";

const MONTHLY_RENEWALS_ENDED =
  "Monthly standalone Premium ($24.99) on @gmail.com accounts stopped auto-renewing. Workspace subscriptions kept renewing until Google stopped all renewals on September 18, 2026. No new standalone sign-ups are accepted.";

const STUDENT_OFFER =
  "Eligible college students aged 18+ in countries where the plan is offered, except Bolivia, Albania, Canada, Hong Kong, Macau, and Tunisia, get Google AI Pro free for a year (redeem by December 31, 2026; a payment method is required, and it then renews at $19.99/month).";

const STUDENT_OFFER_TERMS = "https://one.google.com/offer/studentoffer8";

const GEMINI_25_ACCESS =
  "Since September 18, 2026, Google limits the Gemini 2.5 models to users who have used them before. New projects should use Gemini 3.5 Flash-Lite or 3.8 Flash. See our Free LLM APIs comparison for full details.";

const GEMINI_API_CHANGELOG = "https://ai.google.dev/gemini-api/docs/changelog";

function geminiContextBox(html: string): string {
  return html.split("<strong>Context — Gemini API free tier reduction:</strong>")[1]?.split("</div>")[0] ?? "";
}

const PLAN_CELLS: Record<string, [string, string, string]> = {
  "GDP Premium (standalone, closed)": ["$500/year (annual plan) or $45/mo (monthly plan)", "Gemini 3 Pro access; $50/yr GenAI credit (annual plan)", "30 Firebase Studio workspaces"],
  "Google AI Pro": ["$10/mo ($120/yr)", "Expanded Gemini 3.1 Pro and Deep Research", "30 Firebase Studio workspaces"],
  "Google AI Ultra 5x (20 TB)": ["$40/mo ($480/yr)", "5x AI Pro's usage limits", "30 Firebase Studio workspaces"],
  "Google AI Ultra 20x (30 TB)": ["$100/mo ($1,200/yr)", "20x AI Pro's usage limits", "30 Firebase Studio workspaces"],
};

const KEPT = [
  "Google no longer sells standalone Google Developer Program Premium ($299/year or $24.99/month).",
  "annual plans stopped renewing after March 30, 2026 and monthly plans after June 30, 2026.",
  "January 27, 2026 — Announcement",
  "Cloud credits expire a year after they were granted.",
  "$19.99/mo ($199.99/yr)",
  "$99.99/mo (monthly only)",
  "$199.99/mo (monthly only)",
  "Cloud Build (2,500 build-minutes a month)",
  "BigQuery 1 TiB of queries a month",
  "1 GiB Firestore, 50K reads/day; Cloud Storage needs Blaze since Feb 2026",
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

function geminiApiUsersCard(html: string): string {
  return html.split("<h3>Gemini API Users</h3>")[1]?.split("</div>")[0] ?? "";
}

function timelineCard(html: string, heading: string): string {
  return html.split(`<h3>${heading}</h3>`)[1]?.split("</div>")[0] ?? "";
}

function anchors(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(([, href, text]) => `${readable(text)} -> ${href}`);
}

function planRows(html: string): Map<string, string[]> {
  const table = html.split('id="comparison"')[1]?.split("</table>")[0] ?? "";
  const body = table.split("<tbody>")[1] ?? "";
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => readable(cell))
  );
  return new Map(rows.map((cells) => [cells[0], cells.slice(1)]));
}

let server: ChildProcess;
const served = new Map<string, string>();

describe("the Google Developer Program guide states Google's, Microsoft's, Appwrite's and Mistral's terms as they do", () => {
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
    const routes = new Set<string>([PAGE]);
    for (const sitemap of SITEMAPS) {
      const xml = await (await fetch(`${base}${sitemap}`)).text();
      for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) routes.add(new URL(loc).pathname);
    }
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads the guide and the rest of the guides and reports", () => {
    assert.ok(served.has(PAGE), `${PAGE} was not read`);
    assert.ok(served.size > 60, `read ${served.size} routes`);
  });

  it("states none of the withdrawn claims on any guide or report, in body, meta or structured data, in any case", () => {
    const found = [...served].flatMap(([route, html]) => {
      const text = `${readable(html)} ${structuredStrings(html).join(" ")}`.toLowerCase();
      return WITHDRAWN.filter((claim) => text.includes(claim.toLowerCase())).map((claim) => `${route}: "${claim}"`);
    });
    assert.deepStrictEqual(found, []);
  });

  it("describes the guide in every guide list as a programme that stopped taking sign-ups", () => {
    const listing = [...served]
      .filter(([, html]) => `${readable(html)} ${structuredStrings(html).join(" ")}`.includes(GUIDE_BLURB))
      .map(([route]) => route);
    assert.deepStrictEqual(["/hetzner-pricing-2026", "/guides"].filter((route) => !listing.includes(route)), []);
    assert.ok(listing.length > 60, `the blurb is on ${listing.length} routes`);
  });

  it("states each corrected line as written", () => {
    const text = readable(served.get(PAGE)!);
    assert.deepStrictEqual(STATED.filter((line) => !text.includes(line)), []);
  });

  it("tells Gemini API users that AI Pro and Ultra credits pay for Prepay usage only once Prepay credits are bought, linking the Google staff member's forum answer", () => {
    const card = geminiApiUsersCard(served.get(PAGE)!);
    assert.ok(readable(card).includes(PREPAY_CREDITS), readable(card));
    assert.strictEqual(anchors(card).at(-1), `a Google staff member on discuss.ai.google.dev -> ${PREPAY_CREDITS_SOURCE}`);
  });

  it("tells AI Pro and Ultra subscribers to link their plan on the Google Developer Program site for the monthly Cloud credits, and that Gemini CLI and the Code Assist IDE extensions stopped serving them on June 18, 2026", () => {
    const card = geminiApiUsersCard(served.get(PAGE)!);
    assert.ok(readable(card).includes(LINK_THE_PLAN), readable(card));
    assert.deepStrictEqual(anchors(card), [
      `Google Developer Program site -> ${PROGRAM_SITE}`,
      `Since June 18, 2026 -> ${CODE_ASSIST_DEPRECATION}`,
      `a Google staff member on discuss.ai.google.dev -> ${PREPAY_CREDITS_SOURCE}`,
    ]);
  });

  it("quotes the FAQ on Premium renewals and benefit end dates, linking the FAQ and the conflicting older benefits page", () => {
    const page = served.get(PAGE)!;
    assert.ok(readable(page).includes(RENEWALS_ENDED));
    const summary = page.split('<div class="executive-summary">')[1]?.split("</p>")[0] ?? "";
    assert.deepStrictEqual(anchors(summary).filter((link) => link.includes("-> https://")), [
      `Google's FAQ -> ${DEVELOPER_PROGRAM_FAQ}`,
      `older benefits page -> ${OLDER_BENEFITS_PAGE}`,
    ]);
  });

  it("states the monthly cutoff as a past event without telling readers what to plan for or assume", () => {
    const text = readable(served.get(PAGE)!);
    assert.ok(text.includes(`${RENEWALS_ENDED} Its Google Cloud credits`), text);
    assert.doesNotMatch(text, /\b(?:plan for|assume)\b/i);
  });

  it("dates the end of Workspace renewals in the June 30 timeline entry", () => {
    assert.strictEqual(readable(timelineCard(served.get(PAGE)!, "June 30, 2026 — Monthly renewals end")), MONTHLY_RENEWALS_ENDED);
  });

  it("follows the free tier reduction and its source with Google's limit on the Gemini 2.5 models since September 18, 2026, linking Google's changelog", () => {
    const box = geminiContextBox(served.get(PAGE)!);
    const text = readable(box);
    const stopped = text.indexOf("Google's rate-limits page stopped listing free-tier limits the same day.");
    assert.ok(stopped >= 0, text);
    assert.ok(text.endsWith(GEMINI_25_ACCESS), text);
    assert.ok(text.indexOf(GEMINI_25_ACCESS) > stopped, text);
    assert.deepStrictEqual(anchors(box).filter((link) => link.includes("-> https://ai.google.dev")), [`Since September 18, 2026 -> ${GEMINI_API_CHANGELOG}`]);
    const recordSource = box.indexOf('class="change-source"');
    assert.ok(recordSource >= 0 && box.indexOf(GEMINI_API_CHANGELOG) > recordSource, "the record keeps its own source link ahead of the new sentence");
  });

  it("gives the student offer's countries in the Students card and the student verdict, each linking Google One's offer terms", () => {
    const page = served.get(PAGE)!;
    assert.strictEqual(readable(page).split(STUDENT_OFFER).length - 1, 2);
    assert.strictEqual(page.split(`get <a href="${STUDENT_OFFER_TERMS}" target="_blank" rel="noopener">Google AI Pro free for a year</a> (redeem`).length - 1, 2);
  });

  it("names both Premium plans' credits and every plan's Firebase Studio workspaces in the plan table", () => {
    const rows = planRows(served.get(PAGE)!);
    const wrong = Object.entries(PLAN_CELLS).flatMap(([plan, [credits, gemini, firebase]]) => {
      const cells = rows.get(plan);
      if (!cells) return [`${plan}: no row`];
      return [
        cells[1] === credits ? null : `${plan} credits: "${cells[1]}"`,
        cells[2] === gemini ? null : `${plan} Gemini: "${cells[2]}"`,
        cells[3] === firebase ? null : `${plan} Firebase: "${cells[3]}"`,
      ].filter((line): line is string => line !== null);
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("keeps the figures that were right", () => {
    const text = readable(served.get(PAGE)!);
    assert.deepStrictEqual(KEPT.filter((line) => !text.includes(line)), []);
  });
});
