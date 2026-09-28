import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { getGuideBySlug } = await import("../dist/guides.js");
const { FIGURE_SOURCE_CLASS } = await import("../dist/source-citation.js");
const { SOURCE_MARKER_IN_A_CELL } = await import("../dist/page-reviews.js");

const PAGE = "/gcp-free-tier-2026";
const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const WITHDRAWN: Record<string, RegExp> = {
  "Standard Tier's free egress placed on Premium Tier": /free on Premium Tier/i,
  "a Free Trial account that pauses rather than closes": /your account pauses|Service pause/i,
  "snapshot storage at $0.026 a GB": /Each snapshot costs \$0\.026/i,
  "a T4 GPU on Colab's free notebooks": /T4 GPU/i,
  "Looker Studio's unlimited reports and 10 data sources": /unlimited reports|\b10 data sources/i,
  "unlimited deploys on Vercel's Hobby plan": /Unlimited deploys \(hobby\)/i,
  "every Spark project forced onto Blaze": /Spark forced Blaze/i,
  "Aurora PostgreSQL Serverless as new on the AWS Free Tier": /Aurora PostgreSQL Serverless \(new March 2026\)/i,
  "a ranking of which cost surprises most": /the #1 surprise/i,
  "a claim about how other guides read the tiers": /guides conflate these/i,
};

const WITHDRAWN_FROM_THE_PAGE = [
  "Three tiers, different rules",
  "GCP entries tracked",
  "won't auto-charge",
  "load balancers are never free",
  "Minimum ~$18/month",
  "within Always Free limits",
  "Firebase Auth (50K MAUs)",
  "50,000 MAUs",
  "1 free zonal cluster",
  "60 minutes/month audio transcription",
  "Free to download and run locally",
  "Free for individual use",
  "Cloud Functions to load data",
  "Cloud Functions + Cloud Storage",
  "12-month: VMs, SQL",
];

const STATED_ON_THE_PAGE = [
  "Three ways to start free. Google offers the Free Tier, the $300 Free Trial and product-specific free offers such as the Gemini API free tier in Google AI Studio. Google's Free Tier table lists 29 products, including Cloud Run (2 million requests a month) and BigQuery (1 TiB of querying a month). It has no end date, but Google can change or remove its limits with 30 days' notice. Most limits are monthly; App Engine's limits and Firestore's operation limits are daily. The $300 Free Trial runs for 90 days and needs a credit card or other payment method; the trial billing account is not billed. Accounts opened after 2026-03-02 cannot spend the credit on the Gemini API. The Gemini API free tier has per-minute and per-day limits; the Cloud AI APIs in the Free Tier have monthly limits.",
  "The hidden costs: the e2-micro VM is free only in us-west1, us-central1 and us-east1. Outbound data transfer beyond each product's free allowance is billed. Firestore's free operations are counted per day. Load balancers are billed (forwarding rules and data processed).",
  "GCP's free tier is generous, but these costs catch developers off guard.",
  "Egress charges $0.12–0.23/GiB Premium Tier is the default. From us-central1 it costs $0.12 per GiB (up to 1,024 GiB) to North America, Europe and Asia (excluding Korea and Indonesia), and up to $0.23 elsewhere. The Free Tier covers 1 GB a month from North America to every destination except China and Australia, on Premium Tier only; Cloud Storage's Free Tier adds 100 GB. Standard Tier's first 200 GiB a month are free, per account. Cross-region transfer is also billed.",
  "Firestore daily limits $0.03–0.06/100K reads The free quota covers the default database only; named databases get none. Free: 1 GiB of storage, plus 50,000 reads, 20,000 writes and 20,000 deletes a day. Past the quota, reads cost $0.03 per 100,000 in us-central1 and $0.06 in the nam5, nam7 and eur3 multi-regions.",
  "Free trial credit expiration Not billed The $300 credit lasts 90 days. When it is spent or 90 days pass, the Free Trial billing account closes unless you upgrade to a Paid billing account: resources stop, and data in services such as Compute Engine is marked for deletion. After a 30-day grace period without an upgrade, the resources are permanently deleted. The trial account is not billed, but a billing account set up through AI Studio is billed automatically once its credits are used up or expire.",
  "Load balancer costs $18+/mo The first 5 forwarding rules cost $0.025 an hour (about $18.25 for a 730-hour month). Data processed costs $0.008 per GiB in us-central1 and up to $0.0128 per GiB in other regions. Cloud Run and App Engine include their own load balancing for free.",
  "Persistent disk snapshots $0.05/GB/mo The Free Tier includes 30 GB-months of standard persistent disk and no snapshot storage. Standard snapshot storage costs $0.05 per GB a month in us-central1. Snapshots are incremental and billed on the compressed size of the data changed since the previous snapshot.",
  "A Google Cloud Free Trial billing account is not billed. New AWS accounts on the Free plan are not charged either; they close after 6 months or when their credits run out, unless upgraded to a Paid plan.",
  "Cloud Run and Firestore together cover a small serverless backend within Free Tier limits. Cloud Run gives 2 million requests a month and Firestore 1 GiB of storage. Firebase Authentication, except SMS phone sign-in, is included at no cost on the Spark plan; its 50,000-MAU no-cost tier needs Identity Platform, and Spark projects that upgrade are limited to 3,000 daily active users. Add Cloud Build (2,500 build-minutes a month) for CI/CD and Cloud Logging (50 GiB a month) for observability.",
  "BigQuery (1 TiB of queries and 10 GiB of storage a month) + Data Studio (formerly Looker Studio, free for report creators and viewers). Queries past the first 1 TiB a month are billed, including queries on public datasets. Use Cloud Run functions to load data on a schedule.",
  "Gemini API free tier (AI Studio) + Cloud Run functions + Cloud Storage. Or use Google Colab's free notebooks, where GPU access is heavily restricted. The Vision, Natural Language and Speech-to-Text APIs have monthly free quotas. See our AI/ML tools guide for more options.",
  "Firebase Hosting (10 GB storage, custom domain + SSL) + Firebase Auth + Firestore.",
];

const ROWS_AS_GOOGLE_STATES_THEM: [string, string][] = [
  ["Cloud Run functions (1st gen)", "2M invocations, 400K GB-seconds, 200K GHz-seconds, 5 GB egress/month. Current Cloud Run functions are billed on Cloud Run pricing."],
  ["GKE", "$74.40/month credit per billing account. Covers the cluster management fee for one Autopilot or zonal Standard cluster; not compute, networking or other resources."],
  ["Cloud Source Repositories", "Not available to new customers since June 17, 2024. Existing customers keep up to 5 project-users, 50 GB storage and 50 GB egress/month free."],
  ["Cloud Speech-to-Text", "60 minutes/month per account on the V1 API. The V2 API has no free minutes."],
  ["reCAPTCHA", "10,000 assessments/month free on the Essentials and Premium tiers, counted per organization. Enterprise tier: $1 per 1,000 assessments on a 12-month commitment."],
  ["Firebase Auth", "Included at no cost on the Spark plan, except SMS phone sign-in. The 50K-MAU tier requires Identity Platform; Spark projects that upgrade are limited to 3,000 DAU. SAML/OIDC: 50 MAUs on Blaze, 2 DAU on Spark."],
  ["Firebase Hosting", "10 GB storage, 360 MB/day transfer, custom domain + SSL"],
  ["$300 Free Trial Credit", "$300 credit for 90 days. Credit card or other payment method required. Accounts opened after 2026-03-02 cannot spend it on the Gemini API."],
  ["Google Colab", "Free notebooks run for at most 12 hours. GPU access is heavily restricted and GPU types vary."],
  ["AlloyDB Omni", "Free to download and use for development, testing, prototyping and demos; production or data-processing use is paid ($40 per vCPU a month)."],
  ["Data Studio (formerly Looker Studio)", "Free for report creators and viewers. Connects to 1,400+ data sources. Data Studio Pro: $9/user/project/month."],
];

const FREE_TIER_ROWS_THE_TABLE_LACKED: [string, string, string][] = [
  ["Agent Runtime (Gemini Enterprise Agent Platform)", "First 180,000 vCPU-seconds (50 hours) and 360,000 GiB-seconds of memory a month", "AI/ML"],
  ["Cloud Deploy", "First active delivery pipeline per billing account", "CI/CD"],
  ["Datastream", "100 GiB of change data capture a month per billing account (AlloyDB or Spanner to BigQuery)", "Data"],
  ["Security Command Center", "Standard tier", "Security"],
  ["Web Risk", "100,000 uris.search calls a month", "Security"],
  ["Workload Manager", "5,000 resource evaluations a month", "Management"],
];

const PROVIDER_ROWS: [string, string, string[]][] = [
  [
    "Azure",
    "12 months: 750 hours each of B2pts v2 and B2ats v2 VMs. Always free: SQL Database (100K vCore seconds/mo, 32 GB), Cosmos DB (1K RU/s, 25 GB). $200 credit for 30 days, then pay-as-you-go to keep the free services.",
    ["/aws-free-tier-2026", "/gcp-free-tier-2026"],
  ],
  [
    "Vercel",
    "Hobby plan (personal, non-commercial use only): 100 deployments/day, 100 GB Fast Data Transfer/month, 1M function invocations/month.",
    ["/aws-free-tier-2026", "/gcp-free-tier-2026", "/azure-free-tier-2026"],
  ],
];

const GUIDE_BLURBS: Record<string, string> = {
  "firebase-alternatives": "Firebase Studio is closing (no new workspaces since June 22, 2026; shutdown March 22, 2027) + Cloud Storage for Firebase now requires Blaze — 7 BaaS alternatives",
  "aws-free-tier-2026": "Complete AWS free tier guide — every free service, real limits, hidden costs, and Aurora PostgreSQL on the Free Tier (March 2026)",
};

const CONTROLS = [
  "Always Free includes one e2-micro VM a month in us-west1, us-central1 or us-east1, with 30 GB of standard persistent disk.",
  "2,500 build-minutes",
  "$18+/mo",
];

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nearr;/g, "")
    .replace(/&nbsp;/g, " ");
}

function textOf(html: string): string {
  return decode(
    html
      .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

const CITATION_ANCHOR = new RegExp(`<a [^>]*class="${FIGURE_SOURCE_CLASS}"[^>]*>[\\s\\S]*?<\\/a>`, "g");

function rowsOf(table: string): string[][] {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      textOf(cell.replace(CITATION_ANCHOR, "").replace(new RegExp(SOURCE_MARKER_IN_A_CELL.source, "g"), "")).replace(/^★ /, "")))
    .filter((cells) => cells.length >= 2);
}

function tableAfter(html: string, anchor: string): string {
  const section = html.slice(html.indexOf(anchor));
  return section.slice(0, section.indexOf("</table>"));
}

describe("the GCP free tier guide states Google's terms as Google's own pages state them", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
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
    const routes = new Set<string>([PAGE, "/guides", "/alternatives", ...PROVIDER_ROWS.flatMap(([, , pages]) => pages)]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads the guide, the guide lists and the pages the census covers", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    for (const route of [PAGE, "/aws-free-tier-2026", "/azure-free-tier-2026", "/guides", "/alternatives"]) {
      assert.ok(served.has(route), `${route} was not read`);
    }
  });

  it("serves none of the withdrawn claims on any guide, report or page, in body, meta or structured data", () => {
    const found = [...served].flatMap(([route, html]) =>
      Object.entries(WITHDRAWN)
        .filter(([, pattern]) => pattern.test(html))
        .map(([claim, pattern]) => `${route}: ${claim} ("${html.match(pattern)![0]}")`)
    );
    assert.deepStrictEqual(found, []);
  });

  it("drops the replaced sentences, figures and row limits from the guide", () => {
    const text = textOf(served.get(PAGE)!);
    assert.deepStrictEqual(WITHDRAWN_FROM_THE_PAGE.filter((line) => text.includes(line)), []);
  });

  it("states each corrected sentence and hidden cost as written", () => {
    const text = textOf(served.get(PAGE)!);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((line) => !text.includes(line)), []);
    assert.match(text, /\d+ Google and Firebase entries tracked/);
  });

  it("states each corrected row's name and limits", () => {
    const html = served.get(PAGE)!;
    const rows = [...rowsOf(tableAfter(html, 'id="always-free"')), ...rowsOf(tableAfter(html, 'id="trial-ai"'))];
    const wrong = ROWS_AS_GOOGLE_STATES_THEM.flatMap(([name, limits]) => {
      const row = rows.find(([cell]) => cell === name);
      if (!row) return [`no ${name} row`];
      return row[1] === limits ? [] : [`${name}: ${row[1]}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("lists the six Free Tier products the Always Free table lacked, with the limits and category Google gives", () => {
    const rows = rowsOf(tableAfter(served.get(PAGE)!, 'id="always-free"'));
    const wrong = FREE_TIER_ROWS_THE_TABLE_LACKED.flatMap(([name, limits, category]) => {
      const row = rows.find(([cell]) => cell === name);
      if (!row) return [`no ${name} row in the Always Free table`];
      return row[1] === limits && row[2] === category ? [] : [`${name}: ${row.slice(1).join(" | ")}`];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states Azure's and Vercel's free offers the same way on every cloud guide that compares them", () => {
    const wrong = PROVIDER_ROWS.flatMap(([provider, freeTier, pages]) =>
      pages.flatMap((page) => {
        const row = rowsOf(served.get(page)!).find(([cell]) => cell === provider || cell.startsWith(`${provider} `));
        if (!row) return [`${page}: no ${provider} row`];
        return row[1] === freeTier ? [] : [`${page}: ${provider}: ${row[1]}`];
      })
    );
    assert.deepStrictEqual(wrong, []);
  });

  it("describes the Firebase alternatives and AWS free tier guides with the corrected blurb on every guide list, web and MCP", () => {
    const wrong = Object.entries(GUIDE_BLURBS).flatMap(([slug, blurb]) => {
      const carrying = [...served].filter(([, html]) => textOf(html).includes(blurb)).map(([route]) => route);
      return [
        getGuideBySlug(slug)?.description === blurb ? null : `${slug} MCP: "${getGuideBySlug(slug)?.description}"`,
        ...["/guides", "/alternatives"].map((list) => (carrying.includes(list) ? null : `${slug} not on ${list}`)),
        carrying.length > 60 ? null : `${slug} on only ${carrying.length} routes`,
      ].filter((line): line is string => line !== null);
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("keeps the free VM sentence, Cloud Build's quota, the load balancer cost and the Gemini API row", () => {
    const html = served.get(PAGE)!;
    const text = textOf(html);
    assert.deepStrictEqual(CONTROLS.filter((line) => !text.includes(line)), []);
    assert.ok(rowsOf(tableAfter(html, 'id="trial-ai"')).some(([name]) => name === "Gemini API (AI Studio)"), "no Gemini API (AI Studio) row");
  });
});
