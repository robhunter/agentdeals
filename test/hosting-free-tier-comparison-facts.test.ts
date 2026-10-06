import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGE = "/hosting-free-tier-comparison-2026";
const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];
const HOSTS = /Vercel|Netlify|Cloudflare|Render|Railway|Fly\.io|Koyeb|Deno Deploy|GitHub Pages|PythonAnywhere|Heroku|Cloud Run/g;
const NEARBY = 400;

const MAIN_TABLE_ROWS: Record<string, string[]> = {
  "Vercel": [
    "Included (45 min per build)",
    "200",
    "✓ (beta)",
    "Can cold-start; prevention on Pro"
  ],
  "Netlify": [
    "15 credits per production deploy",
    "500",
    "10 credits/GB-hr + 2 credits/10K requests",
    "No figure in Netlify docs"
  ],
  "Cloudflare Pages": [
    "500 builds/mo (20-min timeout)"
  ],
  "Render": [
    "512 MB RAM, 0.1 CPU",
    "Unlimited (25 services)",
    "✓ Docker",
    "~1 min (spins down after 15 min idle)"
  ],
  "Railway": [
    "30-day trial ($5 credit), then $1/mo credit",
    "1 vCPU, 0.5 GB RAM (2 vCPU, 1 GB on trial)",
    "Free",
    "5 services per project (trial)",
    "1 on trial",
    "✓ Functions (Bun)",
    "✓ $1/mo credit after trial"
  ],
  "Fly.io": [
    "From $0.02/GB",
    "Trial: up to 2 vCPU, 4 GB per machine",
    "Trial machines stop after 5 min"
  ],
  "Koyeb": [
    "None for new users (Pro from $29/mo)",
    "N/A"
  ],
  "Deno Deploy": [
    "15 builds/hr, one at a time",
    "10 apps",
    "Serverless JS/TS apps (2 regions)",
    "≤100 ms (hello world)"
  ],
  "Cloudflare Workers": [
    "3,000 min/mo (Workers Builds)",
    "100 Workers"
  ],
  "GitHub Pages": [
    "Free (public repos on GitHub Free)",
    "1 site per repo"
  ]
};

const COST_TABLE_CELLS: string[] = [
  "$0 (Hobby, non-commercial)",
  "$0 (Hobby, ≤1M requests, non-commercial)",
  "From $60/mo (3 seats; $80 over 1M requests)",
  "From $120/mo + compute (5 seats + CDN tier)",
  "$0 (Free)",
  "$20/mo (Pro; ~2,500 credits)",
  "$63/mo+ (10,000-credit tier; no seat fees)",
  "~$266/mo (bandwidth credits alone)",
  "~$96/mo + compute (Pro $25 + 475 GB at $0.15)",
  "~$321/mo + compute (Pro $25 + 1,975 GB at $0.15)",
  "$0 on trial; then $1/mo credit or $5 Hobby",
  "Greater of $5 or usage (egress: $2.50)",
  "$25/mo egress + compute (Pro, $20 minimum)",
  "$100/mo egress + compute (Pro)"
];

const STATED_ON_THE_PAGE: string[] = [
  "Quick verdict: Cloudflare Pages Free offers unlimited static bandwidth, 500 builds a month and 100 projects; Cloudflare now tells new projects to start on Workers. Render has free web services (512 MB RAM, 0.1 CPU) that spin down after 15 idle minutes, and a free Postgres database that expires after 30 days. Vercel, made by the creators of Next.js, includes 100 GB of Fast Data Transfer and 1M function invocations a month on Hobby, for non-commercial personal use only. Koyeb has had no free plan for new users since February 2026; Pro starts at $29 a month.",
  "The hosting landscape has shifted: Netlify has used credit plans for accounts created since 2025-09-04, with 300 credits a month on Free. Railway gives new accounts a 30-day trial with a $5 credit, then $1 of credit a month. Fly.io has offered no plans to new customers since October 2024; new accounts get a trial of 2 machine hours or 7 days, whichever comes first. Heroku's free plans ended in November 2022. Koyeb closed its free plan to new users in February 2026. Static hosting is still free on Cloudflare Pages, on GitHub Pages from public repositories on GitHub Free, and on Vercel Hobby for non-commercial personal use.",
  "Platforms for deploying frontend frameworks such as Next.js and Astro, and static sites, with serverless functions.",
  "Free tier: Hobby includes 100 GB of Fast Data Transfer, 1M Edge Requests, 1M Function Invocations, 4 hours of Fluid Active CPU, 360 GB-hrs of Provisioned Memory, 1 GB of Blob Storage and 5K image transformations a month. Vercel is made by the creators of Next.js. Hobby includes preview deployments, Routing Middleware, ISR and image optimization. Key limitation: Hobby is for non-commercial personal use only. Commercial use needs Pro or Enterprise; Pro is $20 a month with one deploying seat and $20 for each additional deploying seat.",
  "Free tier: 300 credits a month. Bandwidth costs 20 credits per GB, about 15 GB a month if nothing else uses credits. Production deploys cost 15 credits each; deploy previews, branch deploys and failed deploys are free. Function compute costs 10 credits per GB-hour, and web requests 2 credits per 10,000. All projects pause when credits run out, with no overage charges. Accounts created before 2025-09-04 keep their legacy plans; legacy Free includes 100 GB of bandwidth and 300 build minutes a month, and 125,000 function invocations per site a month. Key limitation: bandwidth, deploys, compute and requests all draw on the one 300-credit pool.",
  "Free tier: 100 projects per account, unlimited static bandwidth, 500 builds a month with a 20-minute timeout each, 100 custom domains per project, and 20,000 files per site, each up to 25 MiB. Pages Functions count toward the Workers Free limit of 100,000 requests a day and run with no cold starts. Cloudflare publishes Pages guides for Astro and SvelteKit. Pages takes only a static export of Next.js; for full-stack Next.js, Cloudflare recommends vinext, a beta reimplementation of the Next.js API, on Workers. Remix's successor is React Router. Cloudflare Workers also serves static assets free and without limit, and Cloudflare now tells new projects to start on Workers.",
  "Free tier: free web services with 512 MB RAM and 0.1 CPU, and 750 free instance hours per workspace a month. They draw on a Hobby workspace's 5 GB of bandwidth and 500 build minutes a month. With a payment method on file, extra bandwidth is $0.15 per GB; without one, Render suspends free services for the rest of the month. One free Postgres database per workspace (256 MB RAM, 1 GB storage) expires 30 days after creation and is deleted 14 days later unless upgraded. One free Key Value instance per workspace (Redis-compatible, 25 MB) keeps its data in memory only. Hobby includes 2 custom domains with managed TLS, then $0.25 per domain a month. Docker images run on free web services. Key limitation: a free web service spins down after 15 minutes with no inbound traffic, and spinning it back up takes about one minute. Render says free instances are not for production.",
  "Free tier: new accounts get a 30-day trial with a one-time $5 credit and no credit card, allowing up to 2 vCPU and 1 GB RAM per service, 5 services per project and 1 custom domain. After the trial, the Free plan gives $1 of credit a month and allows up to 1 vCPU and 0.5 GB RAM per service and 0.5 GB of volume storage. Builds are free. Docker and many languages are supported. Railway's one-click PostgreSQL, MySQL, Redis and MongoDB templates are unmanaged: you handle backups, tuning, security and maintenance.",
  "Free tier: Fly.io stopped offering plans to new customers on 2024-10-07. New accounts get a trial of 2 hours of machine runtime or 7 days, whichever comes first, before adding a payment method; after it, billing is pay-as-you-go with a payment method on file. Organizations on the Hobby, Launch or Scale plans before 2024-10-07 keep a legacy allowance: up to 3 shared-cpu-1x 256 MB VMs, 3 GB of volume storage, and 100 GB of outbound transfer a month in North America and Europe (30 GB in other regions). Volume snapshots: first 10 GB free each month, then $0.08 per GB-month.",
  "Free tier: none for new users. Since February 2026, new users must subscribe to Pro ($29 a month plus compute, with $10 of compute included) or a higher plan. Every plan can run one free-type Postgres instance with 0.25 vCPU, 1 GB RAM, 1 GB storage and 5 hours of compute a month. Organizations already on the Starter plan keep it. Paid plans deploy containers from any registry or build from Docker.",
  "Serverless platforms that run your code on request with no containers to manage.",
  "Free tier: 100,000 requests a day and 10 milliseconds of CPU time per invocation. KV: 1 GB storage, 100,000 reads and 1,000 writes a day. D1: 5 GB storage, 5 million rows read and 100,000 rows written a day. Queues: 10,000 operations a day. 5 Cron Triggers per account, and SQLite-backed Durable Objects. 100 Workers per account. Workers Builds: 3,000 build minutes a month. How it runs: no cold starts, in 330+ cities. Time spent waiting on network requests does not count toward CPU time, and duration is not charged. Workers Paid starts at $5 a month. See our serverless comparison for details.",
  "Free tier: 1M requests a month, 20 GiB of egress a month, 10 hours of active CPU a month, 1 GiB KV storage, 1,000,000 KV read units and 500,000 KV write units a month, 10 apps, 5 custom domains, and 15 builds an hour, one at a time. Runs in 2 regions. Cold starts complete within 100 ms for a hello-world app and within a few hundred ms for larger apps. Native TypeScript and JavaScript. Built-in KV with strongly consistent writes.",
  "Hosts that serve static files (HTML, CSS, JavaScript) with no server-side code.",
  "Free tier: every GitHub plan includes Pages; on GitHub Free it works only from public repositories. Published sites up to 1 GB, a soft limit of 100 GB of bandwidth a month, and a soft limit of 10 builds an hour that does not apply when you publish with a custom GitHub Actions workflow. Custom domains with HTTPS via Let's Encrypt. Jekyll is built in; other static site generators work through a GitHub Actions workflow or your own build. Limitations: static files only. Sites are public on every plan except Enterprise Cloud. GitHub bars using Pages to run an online business, e-commerce site or SaaS.",
  "Free tier: Beginner gives one web app at your-username.pythonanywhere.com, 512 MiB of disk, 100 CPU-seconds a day for consoles and tasks (not the web app), and 2 consoles. Free web apps stop after one month unless you log in and extend them. Accounts created since 2026-01-15 (2026-01-08 in the EU) get no MySQL and no scheduled tasks. Hosts server-side Python web apps (Django, Flask and others) with many libraries preinstalled. Key limitation: custom domains are paid only. Free accounts reach the internet only over HTTP(S) and only to allowlisted sites, about 6,500 of them, including api.openai.com and api.stripe.com.",
  "Vercel's commercial use restriction: Hobby is for non-commercial personal use only. Payments, ads, or being paid to build or host the site count as commercial use and need Pro at $20 a month with one deploying seat, and $20 for each additional deploying seat. Cloudflare Pages, Netlify and Render allow commercial use on their free tiers. GitHub Pages bars running an online business, shop or SaaS.",
  "Per-seat pricing at scale: Vercel Pro charges $20 per deploying seat, so 10 deploying developers cost $200 a month before usage. Netlify's credit-based Pro plan has charged no seat fee since 2026-04-14; $19 a month per member is the Legacy Pro price. Render Pro is $25 a month flat and Railway Pro has a $20 monthly minimum that counts toward usage; both include unlimited team members and bill compute by usage.",
  "Cold starts: Render's free web services spin down after 15 idle minutes and take about one minute to spin back up. Railway services are always on by default. Cloudflare states that Workers have no cold starts. Vercel functions can cold-start, and Vercel lists cold start prevention as a Pro feature. Koyeb and Fly.io offer new accounts no ongoing free compute.",
  "Vercel is made by the creators of Next.js. Hobby includes ISR, Routing Middleware, image optimization and preview deployments, for non-commercial personal use. For full-stack Next.js on Cloudflare, Cloudflare recommends vinext, a beta reimplementation of the Next.js API, on Workers; Pages takes only a static export.",
  "Render's free web services have 512 MB RAM and 0.1 CPU, with custom domains and TLS. Its free Postgres database expires after 30 days, and its free Key Value instance keeps data in memory only. Free services spin down after 15 idle minutes and take about a minute to return; a paid instance from $7 a month stays on.",
  "Unlimited static bandwidth, 100,000 Workers requests a day, KV and D1 storage, no cold starts, and no commercial-use restriction in Cloudflare's terms. Past 100,000 Worker requests in a day, Cloudflare returns an error for them until the limit resets at midnight UTC; static assets stay free and unlimited. Workers Paid starts at $5 a month.",
  "Railway bills the greater of a plan's monthly minimum and your usage, with no seat charges: Pro has a $20 minimum that includes $20 of usage, and unlimited seats. New accounts get a 30-day trial with a one-time $5 credit. Builds are free, and Docker is supported. Railway's one-click database templates are unmanaged.",
  "Google Cloud Run's free tier, per billing account each month on request-based billing, is 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds at us-central1 prices. Services scale to zero by default. It runs any container that meets its contract (Linux x86_64 executables, listening on the configured port). After a scale to zero, a request can wait for a new instance to start, whatever the image size. Koyeb and Fly.io offer new accounts no ongoing free compute.",
  "Cloudflare Pages serves static bandwidth without limit, as does Workers for static assets. The Free plan allows 20,000 files per site, each up to 25 MiB; Cloudflare says to put larger files in R2. Vercel Hobby includes 100 GB a month, GitHub Pages has a soft limit of 100 GB a month, and Netlify's 300 monthly credits cover about 15 GB if nothing else uses them.",
  "Cloudflare Workers runs in 330+ cities with no cold starts, and time spent waiting on the network does not count toward CPU time. The Free plan includes 100,000 requests a day and 10 ms of CPU per invocation. Deno Deploy runs in 2 regions, and its Free plan includes 10 CPU-hours a month.",
  "GitHub Pages hosts static sites from a repository; on GitHub Free it works only from public repositories. It has a soft bandwidth limit of 100 GB a month, custom domains and HTTPS. GitHub bars using it to run an online business, shop or SaaS.",
  "Vercel Hobby is for non-commercial personal use only. Commercial use, including ads, requires Pro at $20 a month with one deploying seat. GitHub Pages also bars sites run as an online business, shop or SaaS. Cloudflare Pages, Netlify, Render and Railway allow commercial use on their free or entry tiers.",
  "Render spins down a free web service after 15 minutes without inbound traffic. The next HTTP request or WebSocket connection spins it back up, which takes about one minute; browsers see a loading page meanwhile. Render says free instances are not for production applications.",
  "New Fly.io accounts get a trial of 2 machine hours or 7 days, whichever comes first, before adding a payment method. Trial Machines stop after 5 minutes of running. The legacy free allowance is only for organizations that were on the Hobby, Launch or Scale plans before 2024-10-07. Apps stop at the end of the trial unless a payment method is added.",
  "Netlify's Free plan gives 300 credits a month. Production deploys cost 15 credits each, bandwidth 20 credits per GB, compute 10 credits per GB-hour, and web requests 2 credits per 10,000; deploy previews and branch deploys are free. Ten production deploys a day use about 4,500 credits a month, and 20 GB of bandwidth adds 400. That is about 4,900 credits, well over the 300 limit, and every project on the account pauses.",
  "PythonAnywhere free accounts reach only allowlisted sites over HTTP(S), about 6,500 of them, including api.openai.com and api.stripe.com; other hosts are blocked. The Developer plan, which replaced the $5 Hacker plan in January 2026, costs $10 a month and has unrestricted internet access.",
  "Our comparison table gives each provider's published limits; figures marked ~ are estimates. See The Hosting Cost Trap for what you pay past the free limits."
];

const HEADINGS_ON_THE_PAGE: string[] = [
  "Next.js → Vercel",
  "Backend APIs → Render",
  "Side projects → Cloudflare Pages + Workers",
  "Usage-based billing → Railway",
  "Docker containers → Google Cloud Run",
  "Unlimited static bandwidth → Cloudflare Pages",
  "Edge compute → Cloudflare Workers",
  "Static sites from a repository → GitHub Pages",
  "Render free tier spin-up (about one minute)",
  "PythonAnywhere limits outbound internet"
];

const WITHDRAWN_NEAR_A_HOST: string[] = [
  "BEST STATIC",
  "BEST BACKEND",
  "DB ONLY",
  "database-only now",
  "125K/mo (Level 0)",
  "Level 0 (125K",
  "unique among hosting platforms",
  "35+ edge locations",
  "No outbound internet access",
  "blocks outbound internet",
  "10–50x cheaper",
  "30–60 second cold starts",
  "30-60 second cold starts",
  "30-60s cold start",
  "cold starts of 30-60 seconds",
  "Netlify ($19/seat)",
  "Render ($19/seat)",
  "No build time limits per build",
  "credit card at signup",
  "no trial or free tier for new signups",
  "Hacker plan ($10/mo",
  "Free Postgres DB",
  "No cold start penalty for lightweight images",
  "gold standard for Next.js",
  "Next.js adapter is the best free alternative",
  "$20/seat team",
  "Railway ($20/seat)",
  "6K build min",
  "pay-as-you-go from day one",
  "(Individual)",
  "Individual plan"
];

const VERCEL = /Vercel/;

const WITHDRAWN_NEAR_VERCEL: string[] = [
  "6,000 build minutes",
  "100 hours serverless function execution",
  "$20/month per team member"
];

const VERCEL_HOBBY_ON_HOSTING_PRICING = "Vercel's Hobby plan (100 GB of Fast Data Transfer, builds included; non-commercial use only)";
const VERCEL_HOBBY_ON_THE_NEXTJS_STACK = "Vercel's Hobby plan is free, with 100 GB of Fast Data Transfer, 1M function invocations and 4 hours of Fluid Active CPU a month, and builds included.";
const VERCEL_PRO_ON_THE_NEXTJS_STACK = "Vercel Pro is $20 a month with one deploying seat, and $20 for each additional deploying seat.";

const CIRCLECI_BUILD_MINUTES = "(up to 6,000 build minutes on small Docker)";

const RENDER_HIDDEN_COSTS = "Free web services spin down after 15 minutes without traffic and take about one minute to spin back up. Free Postgres expires after 30 days.";
const FLY_HIDDEN_COSTS = "No free plan for new accounts: a trial of 2 machine hours or 7 days, whichever comes first, then pay-as-you-go.";
const HIDDEN_COST_CHARACTERS_SHOWN = 80;
const RAILWAY_FOR_GENERAL_PURPOSE_APPS = "Railway for general-purpose apps ($5/mo Hobby; Pro is a $20 monthly minimum with unlimited seats).";

const STATED_ON_OTHER_PAGES: Record<string, string[]> = {
  "/hosting-pricing": [
    "$20/mo minimum (Pro, unlimited seats)",
    "$25/mo flat (Pro) + usage",
    RENDER_HIDDEN_COSTS.slice(0, HIDDEN_COST_CHARACTERS_SHOWN).trim(),
    FLY_HIDDEN_COSTS.slice(0, HIDDEN_COST_CHARACTERS_SHOWN).trim(),
    "New accounts get a trial of 2 machine hours or 7 days, whichever comes first, before adding a payment method; apps stop at the end of the trial unless one is added.",
    "$20/mo (Pro)",
    "$20/mo flat (Pro, no seat fees)",
    "Runs in 2 regions. Cold starts complete within 100 ms for a hello-world app.",
    "Railway Pro ($20 monthly minimum) and Render Pro ($25 a month flat) include unlimited team members. Google Cloud Run has no per-seat pricing",
    RAILWAY_FOR_GENERAL_PURPOSE_APPS,
    "Railway Pro ($20 monthly minimum, unlimited seats) for general-purpose backends.",
    "Vercel Hobby for Next.js (100 GB of Fast Data Transfer, builds included; non-commercial use only).",
    "Vercel Pro ($20/seat) for frontend/Next.js.",
    "$7/mo (Starter instance)",
    "The workaround costs $7/month (Starter instance, always-on).",
    "Hobby plan: 100 GB Fast Data Transfer, 1M Function Invocations and 4 hours Fluid Active CPU a month; builds included, up to 45 minutes each; non-commercial personal use only.",
    VERCEL_HOBBY_ON_HOSTING_PRICING
  ],
  "/vercel-alternatives": [
    "None for new users",
    "No free plan for new users since Feb 2026 (Pro from $29/mo)"
  ],
  "/free-nextjs-stack": [
    "Hobby plan: 100 GB Fast Data Transfer, 1M function invocations and 4 hours Fluid Active CPU a month; builds included.",
    VERCEL_HOBBY_ON_THE_NEXTJS_STACK,
    VERCEL_PRO_ON_THE_NEXTJS_STACK
  ],
  "/cloudflare-pages-vs-vercel": [
    "Vercel Hobby includes builds, up to 45 minutes each."
  ]
};

const PAGES_GIVING_RENDERS_SPIN_UP: string[] = [
  "/railway-vs-render",
  "/free-nextjs-stack",
  "/free-django-stack",
  "/free-fastapi-stack",
  "/netlify-vs-render"
];

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&#10003;/g, "✓")
    .replace(/&#10007;/g, "✗")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
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

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell.replace(/<div class="row-referral"[\s\S]*?<\/div>/g, " "))))
    .filter((cells) => cells.length >= 2);
}

function tableAfter(html: string, heading: string): string {
  const at = html.indexOf(heading);
  assert.ok(at >= 0, `the page has a section headed ${heading}`);
  const start = html.indexOf("<table", at);
  return html.slice(start, html.indexOf("</table>", start));
}

function faqAnswersOf(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
    .flatMap(([, raw]) => {
      try {
        return [JSON.parse(raw)];
      } catch {
        return [];
      }
    })
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .filter((entry) => entry?.["@type"] === "FAQPage")
    .flatMap((entry) => (entry.mainEntity ?? []).map((q: { acceptedAnswer?: { text?: string } }) => q.acceptedAnswer?.text ?? ""));
}

function metaContentsOf(html: string): string[] {
  return [...html.matchAll(/<meta\s[^>]*content="([^"]*)"/g)].map(([, content]) => decode(content));
}

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

describe("the hosting free tier comparison states each host's terms as the host does", () => {
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
    const routes = new Set<string>([PAGE, ...Object.keys(STATED_ON_OTHER_PAGES), ...PAGES_GIVING_RENDERS_SPIN_UP]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads the page, the pages that repeat its claims, and the rest of the guides and reports", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    for (const route of [PAGE, ...Object.keys(STATED_ON_OTHER_PAGES), ...PAGES_GIVING_RENDERS_SPIN_UP]) assert.ok(served.has(route), `${route} renders`);
  });

  it("sets each main table cell as the host's own pages state it", () => {
    const rows = rowsOf(tableAfter(served.get(PAGE)!, 'id="main-comparison"'));
    const missing = Object.entries(MAIN_TABLE_ROWS).flatMap(([host, cells]) => {
      const row = rows.find((cells) => cells[0] === host || cells[0].startsWith(`${host} `));
      if (!row) return [`${host}: no row`];
      return cells.filter((cell) => !row.includes(cell)).map((cell) => `${host}: ${cell}`);
    });
    assert.deepStrictEqual(missing, []);
  });

  it("prices growth in the cost table as the hosts' pages state it", () => {
    const cells = rowsOf(tableAfter(served.get(PAGE)!, 'id="cost-trap"')).flat();
    assert.deepStrictEqual(COST_TABLE_CELLS.filter((cell) => !cells.includes(cell)), []);
  });

  it("states every card, box, use case, gotcha and FAQ answer as written", () => {
    const text = textOf(served.get(PAGE)!);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((sentence) => !text.includes(sentence)), []);
    assert.deepStrictEqual(HEADINGS_ON_THE_PAGE.filter((heading) => !text.includes(heading)), []);
  });

  it("ranks no host in its own headings or badges", () => {
    const html = served.get(PAGE)!;
    const ownHeadings = [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>|<div class="verdict-item">\s*<strong>([\s\S]*?)<\/strong>/g)]
      .map((m) => textOf(m[2] ?? m[3]))
      .filter((heading) => /\bBest\b/.test(heading));
    assert.deepStrictEqual(ownHeadings, []);
    assert.deepStrictEqual(["BEST STATIC", "BEST BACKEND", "BEST FREE BACKEND"].filter((badge) => html.includes(badge)), []);
  });

  it("repeats none of the withdrawn claims near a host's name on any guide or report", () => {
    const found: string[] = [];
    for (const [route, html] of served) {
      const text = textOf(html);
      for (const claim of WITHDRAWN_NEAR_A_HOST) {
        for (let at = text.indexOf(claim); at >= 0; at = text.indexOf(claim, at + 1)) {
          const around = text.slice(Math.max(0, at - NEARBY), at + claim.length + NEARBY);
          if (around.match(HOSTS)) found.push(`${route}: ${claim}`);
        }
      }
    }
    assert.deepStrictEqual([...new Set(found)], []);
  });

  it("states the same corrections on the pages that repeat them", () => {
    const missing = Object.entries(STATED_ON_OTHER_PAGES).flatMap(([route, sentences]) =>
      sentences.filter((sentence) => !textOf(served.get(route)!).includes(sentence)).map((sentence) => `${route}: ${sentence}`));
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(PAGES_GIVING_RENDERS_SPIN_UP.filter((route) => !/about one minute/.test(textOf(served.get(route)!))), []);
  });

  it("gives /hosting-pricing's structured data Railway's minimum and its meta none of the withdrawn claims", () => {
    const html = served.get("/hosting-pricing")!;
    assert.ok(faqAnswersOf(html).some((answer) => answer.includes(RAILWAY_FOR_GENERAL_PURPOSE_APPS)));
    assert.deepStrictEqual(metaContentsOf(html).filter((content) => WITHDRAWN_NEAR_A_HOST.some((claim) => content.includes(claim))), []);
  });

  it("gives Vercel Hobby no build-minute allowance or function hours near Vercel's name on any guide or report, in text, meta or structured data", () => {
    const found: string[] = [];
    for (const [route, html] of served) {
      for (const text of [textOf(html), ...metaContentsOf(html)]) {
        for (const claim of WITHDRAWN_NEAR_VERCEL) {
          for (let at = text.indexOf(claim); at >= 0; at = text.indexOf(claim, at + 1)) {
            if (VERCEL.test(text.slice(Math.max(0, at - NEARBY), at + claim.length + NEARBY))) found.push(`${route}: ${claim}`);
          }
        }
      }
    }
    assert.deepStrictEqual([...new Set(found)], []);
    const answers = [
      ["/hosting-pricing", VERCEL_HOBBY_ON_HOSTING_PRICING],
      ["/free-nextjs-stack", VERCEL_HOBBY_ON_THE_NEXTJS_STACK],
      ["/free-nextjs-stack", VERCEL_PRO_ON_THE_NEXTJS_STACK],
    ];
    assert.deepStrictEqual(answers.filter(([route, answer]) => !faqAnswersOf(served.get(route)!).some((text) => text.includes(answer))), []);
  });

  it("keeps CircleCI's build minutes, which are CircleCI's own figure", () => {
    assert.ok(textOf(served.get("/ci-cd-pricing")!).includes(CIRCLECI_BUILD_MINUTES));
  });

  it("keeps Cloudflare Pages' builds, Vercel's transfer and Heroku's removed badge", () => {
    const html = served.get(PAGE)!;
    assert.ok(textOf(html).includes("500 builds a month"));
    assert.ok(textOf(html).includes("100 GB Fast Data Transfer"));
    assert.ok(html.includes("FREE REMOVED"));
  });
});
