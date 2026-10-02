import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { changesTheVendorMade } from "../dist/data.js";
import { changeEntryDateLabelFor } from "../dist/change-dates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGE = "/google-developer-program-2026";
const PAGES_READING_THE_FIREBASE_GUIDE_BLURB = ["/guides", "/alternatives"];

const RETIRED = [
  "$249.99",
  "$2,999.88",
  "$239.88",
  "Monthly Developer Plan",
  "new monthly Developer Plan",
  "Gemini Advanced",
  "120 min/day",
  "5GB Storage",
  "10x price increase",
  "before March 30",
  "lose access",
  "GitHub Models",
  "Premium ending March 30",
  "What's Ending",
  "Premium Ends",
  "API access included",
  "may not be significantly better than what's available for free",
];

const STATED = [
  "Google no longer sells standalone Google Developer Program Premium ($299/year or $24.99/month). On personal (@gmail.com) accounts, annual plans stopped renewing after March 30, 2026 and monthly plans after June 30, 2026; Premium on Workspace accounts did not change. Its Google Cloud credits and Firebase Studio workspaces now come with Google AI Pro ($19.99/mo) and Google AI Ultra (from $99.99/mo) on personal Google Accounts. Premium's 1:1 consultations, certification voucher and unlimited Google Skills access did not carry over.",
  "The closest match to the old credit is Ultra 5x at $99.99/mo with $40/mo ($480/yr), about 4x Premium's $299/year.",
  "Cloud Storage for Firebase is the exception: since February 3, 2026 it needs the Blaze plan.",
  "Monthly standalone Premium ($24.99) on @gmail.com accounts stopped auto-renewing. Workspace accounts keep existing Premium subscriptions. No new standalone sign-ups are accepted.",
  "Cloud Run, BigQuery and Cloud Build keep their free tiers. Firebase's Spark plan lost Cloud Storage on February 3, 2026. The free Google Developer Program (non-Premium) continues.",
  "$120/year in credits for $199.99/year",
  "Eligible U.S. college students aged 18+ get Google AI Pro free for a year (redeem by December 31, 2026; a payment method is required, and it then renews at $19.99/month). Otherwise, Oracle's Always Free tier and AWS's free plan cost nothing.",
  "4. If You Held Premium",
  "(Cloud Run free tier, BigQuery 1 TiB of queries a month, Cloud Build 2,500 build-minutes a month)",
  "If staying with Google: subscribe to AI Pro or AI Ultra; standalone Premium no longer takes sign-ups.",
  "Free plan: $100 credit at sign-up + up to $100 more, 6 months",
  "$5 credit (90 days)",
  "1 GiB Firestore, 50K reads/day; Cloud Storage needs Blaze since Feb 2026",
  "GDP Premium's annual plan included a $50 credit a year for Google AI Studio and Vertex AI. These providers offer free API tiers of their own.",
  "Google Developer Program Premium — What Replaced It",
  "Closed Standalone Premium",
  "$199.99/yr AI Pro (Premium was $299/yr)",
  "1. What Changed & When",
  "This analysis covers what replaced standalone Google Developer Program Premium, which no longer takes sign-ups.",
  "to \"expanded Gemini access with a small credit bonus.\"",
  "Gemini 3 Pro access; $50/yr GenAI credit (annual plan)",
  "What replaced standalone Google Developer Program Premium: Google AI Pro and AI Ultra at today's prices, and free alternatives",
  "Ultra 5x costs $99.99 and includes $40 in Cloud credits: $59.99/mo for its other benefits. Ultra 20x costs $199.99 and includes $100: $99.99/mo.",
];

const FIREBASE_GUIDE_BLURB = "Firebase Studio is closing (no new workspaces since June 22, 2026; shutdown March 22, 2027)";

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
  for (const page of [PAGE, ...PAGES_READING_THE_FIREBASE_GUIDE_BLURB]) {
    served.set(page, await (await fetch(`http://localhost:${port}${page}`)).text());
  }
});

after(() => { proc?.kill(); });

function textOf(html: string): string {
  return html
    .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

function withoutTheChangeTrackerBox(html: string): string {
  const start = html.indexOf("From our change tracker:");
  if (start === -1) return html;
  return html.slice(0, start) + html.slice(html.indexOf("</ul>", start));
}

function planRows(html: string): string[] {
  const header = html.indexOf("<th>Status</th>");
  assert.ok(header > 0, `${PAGE} has no plan table`);
  const body = html.slice(html.indexOf("<tbody>", header), html.indexOf("</tbody>", header));
  return [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((row) => textOf(row[0]).trim());
}

describe("/google-developer-program-2026 describes what replaced Premium, at today's prices", () => {
  it("keeps none of the March checklist's retired prices, plans or deadlines, in the body or its metadata, outside the dated records it quotes", () => {
    const text = textOf(withoutTheChangeTrackerBox(served.get(PAGE)!));
    assert.deepStrictEqual(RETIRED.filter((phrase) => text.includes(phrase)), []);
  });

  it("does not call the Spark plan or Google's free tiers unchanged", () => {
    const sentences = textOf(served.get(PAGE)!).split(/(?<=[.!?])\s+/);
    assert.deepStrictEqual(sentences.filter((s) => /unchanged/i.test(s) && /Spark|free tier/i.test(s)), []);
  });

  it("states the current plans and what happened to Premium in Google's terms", () => {
    const text = textOf(served.get(PAGE)!);
    assert.deepStrictEqual(STATED.filter((line) => !text.includes(line)), []);
  });

  it("names its sections as they read today in the table of contents", () => {
    const toc = served.get(PAGE)!.split('<div class="toc">')[1]?.split("</div>")[0] ?? "";
    assert.ok(toc.includes('<a href="#timeline">What Changed &amp; When</a>'), toc);
    assert.ok(toc.includes('<a href="#migration">If You Held Premium</a>'), toc);
    assert.ok(!toc.includes("Migration Guide"), toc);
  });

  it("lists every change Google made since Premium closed in its change tracker box, oldest first, each with its date", () => {
    const box = served.get(PAGE)!.split("From our change tracker:")[1]?.split("</ul>")[0] ?? "";
    const since = changesTheVendorMade(JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes)
      .filter((c: { vendor: string; date: string }) => c.vendor === "Google" && c.date >= "2026-03-30")
      .sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date));
    assert.ok(since.length > 0, "no Google record dates from Premium's closing, so the box proves nothing");
    const servedOnUtc = (date: string) =>
      new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).replace(/ /g, "\u00a0");
    const at = since.map((c: { date: string; date_source?: string }) => box.indexOf(`<strong>${changeEntryDateLabelFor(c, servedOnUtc)}:</strong>`));
    assert.ok(at.every((i: number) => i >= 0), `each record's date is in the box: ${JSON.stringify(at)}`);
    assert.deepStrictEqual([...at].sort((a, b) => a - b), at);
  });

  it("compares four plans: the closed Premium and the three sold today", () => {
    const rows = planRows(served.get(PAGE)!);
    assert.deepStrictEqual(rows.map((row) => row.split(" $")[0]), [
      "GDP Premium (standalone, closed)",
      "Google AI Pro",
      "Google AI Ultra 5x (20 TB)",
      "Google AI Ultra 20x (30 TB)",
    ]);
    assert.ok(rows[0].endsWith("CLOSED"));
    for (const row of rows.slice(1)) assert.ok(row.endsWith("CURRENT"), row);
  });

  it("dates Firebase Studio's shutdown March 22, 2027 wherever the Firebase guide is summarised", () => {
    for (const page of PAGES_READING_THE_FIREBASE_GUIDE_BLURB) {
      const text = textOf(served.get(page)!);
      assert.ok(text.includes(FIREBASE_GUIDE_BLURB), page);
      assert.doesNotMatch(text, /Firebase Studio shut down March 19, 2026/, page);
    }
  });
});
