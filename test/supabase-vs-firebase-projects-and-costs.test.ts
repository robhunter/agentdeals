import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const decode = (s: string) =>
  s.replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

interface Page {
  served: string;
  tables: { head: string[]; rows: string[][] }[];
  quickVerdict: string;
  onFreeTiers: string;
  pricingModel: string;
  scaleBottomLine: string;
  chooseFirebase: string;
  bigCaveat: string;
}

function readPage(html: string): Page {
  const body = html.replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  const tables = [...body.matchAll(/<table class="pricing-table">([\s\S]*?)<\/table>/g)].map(t => ({
    head: [...(t[1].match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(c => plain(c[1])),
    rows: [...(t[1].match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => plain(c[1]))),
  }));
  const scale = body.slice(body.indexOf('<h2 id="scale">'), body.indexOf('<h2 id="when">'));
  return {
    served: decode(html),
    tables,
    quickVerdict: plain(body.match(/<p><strong>Quick verdict:<\/strong>([\s\S]*?)<\/p>/)?.[1] ?? ""),
    onFreeTiers: plain(body.match(/<p><strong>On free tiers:<\/strong>([\s\S]*?)<\/p>/)?.[1] ?? ""),
    pricingModel: plain(body.match(/Pricing Model<\/h3>\s*<p class="diff-desc">([\s\S]*?)<\/p>/)?.[1] ?? ""),
    scaleBottomLine: plain(scale.match(/<div class="context-box">([\s\S]*?)<\/div>/)?.[1] ?? ""),
    chooseFirebase: plain(body.match(/<strong>Choose Firebase if:<\/strong>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? ""),
    bigCaveat: plain(body.match(/<p><strong>The big caveat:<\/strong>([\s\S]*?)<\/p>/)?.[1] ?? ""),
  };
}

let proc: ChildProcess | null = null;
let port = 0;
let page: Page;

function startServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", e => { clearTimeout(timeout); reject(e); });
  });
}

const rowNamed = (rows: string[][], name: string) => rows.find(r => r[0] === name);

describe("/supabase-vs-firebase counts Firebase's free projects and prices both vendors at scale as the vendors do", () => {
  before(async () => {
    const started = await startServer();
    proc = started.child;
    port = started.port;
    const res = await fetch(`http://localhost:${port}/supabase-vs-firebase`);
    assert.strictEqual(res.status, 200);
    page = readPage(await res.text());
  });

  after(() => proc?.kill());

  it("never calls Firebase's free projects unlimited, nor Supabase 30-50% cheaper, anywhere it serves", () => {
    assert.match(page.served, /Supabase vs Firebase[\s\S]*Bottom line on scaling:[\s\S]*Choose Firebase if:/);
    for (const gone of [/unlimited free projects/i, /unlimited projects/i, /Unlimited Spark/i, /30\s*[-–]\s*50\s*%/]) {
      assert.doesNotMatch(page.served, gone);
    }
  });

  it("gives Firebase's project count as Google's quota in the free tier table", () => {
    const free = page.tables.find(t => t.head[0] === "Feature");
    assert.ok(free, JSON.stringify(page.tables.map(t => t.head)));
    assert.deepStrictEqual(rowNamed(free.rows, "Projects"), [
      "Projects", "2 free projects", "About 5-10 per account (Google's project quota)",
      "Firebase wins on project count. Supabase pauses inactive projects",
    ]);
  });

  it("counts the projects the same way in the quick verdict, the free-tier summary and the decision guide", () => {
    assert.match(page.quickVerdict, /Choose Firebase if you need a mature NoSQL ecosystem, more free projects than Supabase's 2, and tight Google Cloud integration\.$/);
    assert.match(page.onFreeTiers, /^Firebase offers more raw storage \(1 GiB vs 500 MB\) and more free projects \(about 5-10 per account, against Supabase's 2\), but imposes daily read\/write caps \(50K reads, 20K writes\)\. Supabase has no API request limits/);
    assert.match(page.chooseFirebase, /^You're building mobile-first apps with Google ecosystem integration, need several free projects for prototyping, prefer document-model databases/);
  });

  it("prices Supabase Pro's extra database and storage as Supabase does, and Firebase's storage after its free 5 GB", () => {
    const scale = page.tables.find(t => t.head.join("|") === "Metric|Supabase|Firebase|Notes");
    assert.ok(scale, JSON.stringify(page.tables.map(t => t.head)));
    assert.deepStrictEqual(rowNamed(scale.rows, "Database at 10 GB"), [
      "Database at 10 GB", "$25.25/mo (8 GB included, then $0.125/GB)", "$1.56/mo (Firestore)",
      "Firebase cheaper for pure storage. Supabase includes more in base price",
    ]);
    assert.deepStrictEqual(rowNamed(scale.rows, "50 GB storage"), [
      "50 GB storage", "$25/mo (100 GB included in Pro)", "Blaze required, about $1/mo (first 5 GB free)",
      "Firebase cheaper for raw storage on Blaze pay-as-you-go",
    ]);
  });

  it("closes the cost section on what its own table shows, and leaves the pricing card without a saving it cannot source", () => {
    assert.strictEqual(
      page.scaleBottomLine,
      "Bottom line on scaling: At every volume in this table, Firebase's pay-as-you-go prices come to less than Supabase Pro's $25 a month. Supabase's advantage is a predictable bill, since Pro's spend cap is on by default. Blaze's spend caps must be set up and cover only AI Logic, App Hosting, Cloud Functions and Extensions, not Firestore or Cloud Storage.",
    );
    assert.strictEqual(
      page.pricingModel,
      "Supabase Pro is $25/month with predictable limits. Firebase Blaze is pay-as-you-go and cheap at low usage. Spend caps cover only AI Logic, App Hosting, Cloud Functions and Extensions, so a traffic spike on Firestore or Cloud Storage can still cause a surprise bill.",
    );
  });

  it("names the four Firebase services Blaze's spend caps cover, and never says Blaze has no cap, anywhere it serves", () => {
    for (const gone of [/no hard caps?/i, /no spending caps?/i, /no hard spending caps?/i, /no billing caps?/i]) {
      assert.doesNotMatch(page.served, gone);
    }
    const scale = page.tables.find(t => t.head.join("|") === "Metric|Supabase|Firebase|Notes");
    assert.ok(scale, JSON.stringify(page.tables.map(t => t.head)));
    assert.deepStrictEqual(rowNamed(scale.rows, "Starter paid plan"), [
      "Starter paid plan", "$25/mo (Pro)", "Pay-as-you-go (Blaze)",
      "Supabase is a flat rate; Firebase is usage-based with spend caps on only four services.",
    ]);
    assert.deepStrictEqual(rowNamed(scale.rows, "Billing protection"), [
      "Billing protection", "Hard limits, spend caps available",
      "Budget alerts, plus optional spend caps for AI Logic, App Hosting, Cloud Functions and Extensions",
      "Supabase safer for indie devs. Firebase can generate surprise bills",
    ]);
    assert.strictEqual(
      page.bigCaveat,
      "Firebase removed Cloud Storage from the free Spark plan in February 2026. File storage now needs Blaze with a credit card, and Blaze's spend caps do not cover Cloud Storage. Supabase includes 1 GB file storage on the free tier.",
    );
  });

  it("gives Blaze's spend caps the same four services on /firebase-alternatives", async () => {
    const res = await fetch(`http://localhost:${port}/firebase-alternatives`);
    assert.strictEqual(res.status, 200);
    const served = decode(await res.text());
    assert.match(plain(served), /Appwrite projects pause after 1 week of inactivity on the free tier\. On Firebase's Blaze plan, spend caps must be set up and cover only AI Logic, App Hosting, Cloud Functions and Extensions, not Firestore or Cloud Storage\./);
    for (const gone of [/no hard caps?/i, /no spending caps?/i, /no hard spending caps?/i, /no billing caps?/i]) {
      assert.doesNotMatch(served, gone);
    }
  });
});
