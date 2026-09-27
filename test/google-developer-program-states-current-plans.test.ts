import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
];

const STATED = [
  "Google no longer sells standalone Google Developer Program Premium ($299/year or $24.99/month). On personal (@gmail.com) accounts, annual plans stopped renewing after March 30, 2026 and monthly plans after June 30, 2026; Premium on Workspace accounts did not change. Its developer benefits now come with Google AI Pro ($19.99/mo) and Google AI Ultra (from $99.99/mo), which only personal Google Accounts can buy.",
  "The closest match to the old credit is Ultra 5x at $99.99/mo with $40/mo ($480/yr), about 4x Premium's $299/year.",
  "Cloud Storage for Firebase is the exception: since February 3, 2026 it needs the Blaze plan.",
  "Monthly standalone Premium ($24.99) on @gmail.com accounts stopped auto-renewing. Workspace accounts keep existing Premium subscriptions. No new standalone sign-ups are accepted.",
  "Cloud Run, BigQuery and Cloud Build keep their free tiers. Firebase's Spark plan lost Cloud Storage on February 3, 2026. The free Google Developer Program (non-Premium) continues.",
  "$120/year in credits for $199.99/year",
  "Eligible students get Google AI Pro free for a year. Otherwise, Oracle's Always Free tier and AWS's free plan cost nothing.",
  "4. If You Held Premium",
  "(Cloud Run free tier, BigQuery 1 TiB of queries a month, Cloud Build 2,500 build-minutes a month)",
  "If staying with Google: subscribe to AI Pro or AI Ultra; standalone Premium no longer takes sign-ups.",
  "Free plan: $100 credit at sign-up + up to $100 more, 6 months",
  "$5 credit (90 days)",
  "1 GiB Firestore, 50K reads/day; Cloud Storage needs Blaze since Feb 2026",
  "GDP Premium included Gemini API access. These providers offer free API tiers of their own.",
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

function planRows(html: string): string[] {
  const header = html.indexOf("<th>Status</th>");
  assert.ok(header > 0, `${PAGE} has no plan table`);
  const body = html.slice(html.indexOf("<tbody>", header), html.indexOf("</tbody>", header));
  return [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((row) => textOf(row[0]).trim());
}

describe("/google-developer-program-2026 describes what replaced Premium, at today's prices", () => {
  it("keeps none of the March checklist's retired prices, plans or deadlines, in the body or its metadata", () => {
    const text = textOf(served.get(PAGE)!);
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
